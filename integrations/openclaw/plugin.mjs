/**
 * agentmemory plugin for OpenClaw
 *
 * Deeper integration than raw MCP:
 * - claims the plugins.slots.memory slot via api.registerMemoryCapability({ promptBuilder })
 * - recalls relevant memories before prompt assembly (before_prompt_build hook)
 * - captures completed conversation turns after the agent finishes (agent_end hook)
 *
 * Requires the agentmemory server on localhost:3111.
 * Start it with: npx @agentmemory/agentmemory
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const DEFAULT_BASE_URL = "http://localhost:3111";
const DEFAULT_TIMEOUT_MS = 5000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const configSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    base_url: { type: "string" },
    token_budget: { type: "number" },
    min_confidence: { type: "number" },
    fallback_on_error: { type: "boolean" },
    timeout_ms: { type: "number" },
  },
};

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      if (block.type === "text" && typeof block.text === "string") return [block.text];
      if (
        ["toolCall", "tool_call", "tool-call"].includes(block.type) &&
        typeof block.arguments?.message === "string"
      ) {
        return [block.arguments.message];
      }
      return [];
    })
    .join("\n")
    .trim();
}

const projectIdentityCache = new Map();
const gitProjectIdCache = new Map();

function realProjectPath(value) {
  try {
    return realpathSync.native(value);
  } catch {
    return resolve(value);
  }
}

function canonicalPath(value) {
  let canonical = realProjectPath(value);
  canonical = canonical.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function projectHash(kind, value) {
  return `${kind}:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function canonicalRemote(remote, cwd) {
  const value = remote.trim();
  const scp = value.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (scp && !value.includes("://") && !/^[A-Za-z]:[\\/]/.test(value)) {
    const path = scp[2].replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return path ? `${scp[1].toLowerCase()}/${path}` : null;
  }
  try {
    const url = new URL(value);
    if (url.protocol === "file:") {
      return `file/${canonicalPath(decodeURIComponent(url.pathname))}`;
    }
    const path = decodeURIComponent(url.pathname)
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/i, "");
    return url.hostname && path
      ? `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}/${path}`
      : null;
  } catch {
    return value ? `file/${canonicalPath(resolve(cwd, value))}` : null;
  }
}

function gitRepository(cwd) {
  let current = realProjectPath(cwd);
  try {
    if (!statSync(current).isDirectory()) current = dirname(current);
  } catch {
    return null;
  }
  while (true) {
    const dotGit = join(current, ".git");
    try {
      const metadata = statSync(dotGit);
      if (metadata.isDirectory()) return { top: current, commonDir: realProjectPath(dotGit) };
      if (metadata.isFile()) {
        const pointer = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)\s*$/im)?.[1];
        if (!pointer) return null;
        const gitDir = realProjectPath(resolve(current, pointer));
        let commonDir = gitDir;
        try {
          const common = readFileSync(join(gitDir, "commondir"), "utf8").trim();
          if (common) commonDir = realProjectPath(resolve(gitDir, common));
        } catch {}
        return { top: current, commonDir };
      }
    } catch {}
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function gitRemoteIdentity(commonDir, cwd) {
  const remotes = new Map();
  try {
    const configured = readFileSync(join(commonDir, "config"), "utf8");
    let remoteName = null;
    for (const line of configured.split(/\r?\n/)) {
      const section = line.match(/^\s*\[remote\s+"([^"]+)"\]\s*$/i);
      if (section) {
        remoteName = section[1];
        continue;
      }
      if (/^\s*\[/.test(line)) {
        remoteName = null;
        continue;
      }
      const url = remoteName ? line.match(/^\s*url\s*=\s*(.+?)\s*$/i) : null;
      if (url) remotes.set(remoteName, url[1]);
    }
  } catch {}
  const names = ["upstream", "origin"];
  for (const name of [...remotes.keys()].sort()) {
    if (!names.includes(name)) names.push(name);
  }
  for (const name of names) {
    const remote = remotes.get(name);
    if (!remote) continue;
    const canonical = canonicalRemote(remote, cwd);
    if (canonical) return canonical;
  }
  return null;
}

export function resolveProjectIdentity(cwd) {
  const explicit = process.env.AGENTMEMORY_PROJECT_NAME?.trim();
  if (explicit) return { project: explicit, projectName: explicit };
  const cacheKey = canonicalPath(cwd);
  const cached = projectIdentityCache.get(cacheKey);
  if (cached) return cached;
  const repository = gitRepository(cwd);
  let identity;
  if (repository) {
    const canonicalCommonDir = canonicalPath(repository.commonDir);
    const projectName = basename(
      canonicalCommonDir.endsWith("/.git") ? dirname(canonicalCommonDir) : repository.top,
    );
    let project = gitProjectIdCache.get(canonicalCommonDir);
    if (!project) {
      const remote = gitRemoteIdentity(repository.commonDir, cwd);
      project = remote
        ? projectHash("git", remote)
        : projectHash("path", canonicalCommonDir);
      gitProjectIdCache.set(canonicalCommonDir, project);
    }
    identity = { project, projectName };
  } else {
    identity = { project: projectHash("path", cacheKey), projectName: basename(cacheKey) || "unknown" };
  }
  projectIdentityCache.set(cacheKey, identity);
  return identity;
}

function identityFor(event, ctx) {
  const sessionId = [ctx?.sessionId, ctx?.sessionKey, event?.sessionId, event?.sessionKey]
    .find((value) => typeof value === "string" && value.trim());
  const cwd = [ctx?.workspaceDir, ctx?.cwd, event?.workspaceDir, event?.cwd]
    .find((value) => typeof value === "string" && value.trim()) || process.cwd();
  const agentId = [ctx?.agentId, event?.agentId]
    .find((value) => typeof value === "string" && value.trim());
  return {
    sessionId: sessionId?.trim() || "",
    cwd,
    ...resolveProjectIdentity(cwd),
    agentId: agentId?.trim() || undefined,
  };
}

function captureId(parts) {
  const hash = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `openclaw:${hash.slice(0, 32)}`;
}

function lastAssistantText(messages) {
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== "object") continue;
    if (message.role !== "assistant") continue;
    const text = extractText(message.content);
    if (text) return text;
  }
  return "";
}

function latestUserText(messages) {
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== "object") continue;
    if (message.role !== "user") continue;
    const text = extractText(message.content);
    if (text) return text;
  }
  return "";
}

function formatResults(results) {
  if (!Array.isArray(results) || results.length === 0) return "";
  return results
    .slice(0, 5)
    .map((result, index) => {
      const obs = result?.observation ?? result ?? {};
      const title = (obs.title || `Memory ${index + 1}`).trim();
      const narrative = (obs.narrative || "").trim();
      const type = (obs.type || "memory").trim();
      return `- ${title} (${type})${narrative ? `: ${narrative}` : ""}`;
    })
    .join("\n");
}

function normalizedHostname(hostname) {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function usesPlaintextBearerAuth(baseUrl, secret) {
  if (!secret) return false;
  try {
    const parsed = new URL(baseUrl);
    return parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(normalizedHostname(parsed.hostname));
  } catch {
    return false;
  }
}

function plaintextBearerAuthMessage(baseUrl) {
  return `agentmemory: AGENTMEMORY_SECRET is configured for plaintext HTTP to ${baseUrl}. Bearer tokens and memory payloads can be observed on the network; use HTTPS or an SSH tunnel.`;
}

function defaultOutboxDir() {
  return process.env.AGENTMEMORY_OUTBOX_DIR ||
    join(homedir(), ".agentmemory", "outbox", "openclaw");
}

let envelopeSequence = 0;

async function persistEnvelope(outboxDir, path, body) {
  await mkdir(outboxDir, { recursive: true, mode: 0o700 });
  const identity = typeof body.captureId === "string" && body.captureId.trim()
    ? { path, captureId: body.captureId.trim() }
    : typeof body.sessionId === "string" && body.sessionId.trim()
      ? { path, sessionId: body.sessionId.trim() }
      : { path, body };
  const key = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
  const target = join(outboxDir, `${key}.json`);
  try {
    await access(target);
    return target;
  } catch {
    // No existing envelope for this idempotent request.
  }
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(
    temp,
    JSON.stringify({
      path,
      body,
      createdAt: new Date().toISOString(),
      sequence: ++envelopeSequence,
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  try {
    await rename(temp, target);
  } catch (error) {
    try {
      await access(target);
      await rm(temp, { force: true });
    } catch {
      await rm(temp, { force: true });
      throw error;
    }
  }
  return target;
}

async function readEnvelopes(outboxDir) {
  let names;
  try {
    names = await readdir(outboxDir);
  } catch {
    return [];
  }
  const envelopes = [];
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const file = join(outboxDir, name);
    try {
      const envelope = JSON.parse(await readFile(file, "utf8"));
      if (
        typeof envelope?.path === "string" &&
        envelope.body &&
        typeof envelope.body === "object"
      ) {
        envelopes.push({ file, envelope });
      }
    } catch {
      // A malformed envelope is kept for operator inspection, not deleted.
    }
  }
  envelopes.sort((a, b) =>
    String(a.envelope.createdAt || "").localeCompare(String(b.envelope.createdAt || "")) ||
    Number(a.envelope.sequence || 0) - Number(b.envelope.sequence || 0) ||
    a.file.localeCompare(b.file),
  );
  return envelopes;
}

export function createDurableClient(options) {
  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const fallbackOnError = options.fallbackOnError !== false;
  const outboxDir = options.outboxDir || defaultOutboxDir();
  const secret = options.secret || "";
  const fetchImpl = options.fetchImpl || fetch;
  const warn = options.warn || (() => {});
  const guard = options.guard || (() => {});
  let queue = Promise.resolve();

  function headers() {
    const result = { "Content-Type": "application/json" };
    if (secret) result.Authorization = `Bearer ${secret}`;
    return result;
  }

  async function transmit(path, body) {
    guard(baseUrl, secret);
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`agentmemory ${path} failed with HTTP ${response.status}`);
    }
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async function replayUnlocked() {
    let delivered = 0;
    for (const { file, envelope } of await readEnvelopes(outboxDir)) {
      try {
        await transmit(envelope.path, envelope.body);
        await rm(file);
        delivered++;
      } catch (error) {
        warn(`agentmemory: capture remains queued after delivery failure: ${String(error)}`);
        if (!fallbackOnError) throw error;
        break;
      }
    }
    return delivered;
  }

  function serialized(task) {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  return {
    async requestJson(path, body) {
      try {
        return await transmit(path, body);
      } catch (error) {
        warn(`agentmemory: ${String(error)}`);
        if (!fallbackOnError) throw error;
        return null;
      }
    },
    deliver(path, body) {
      return serialized(async () => {
        await persistEnvelope(outboxDir, path, body);
        await replayUnlocked();
        return null;
      });
    },
    replay() {
      return serialized(replayUnlocked);
    },
  };
}

export function createPlaintextBearerAuthGuard(warn, env) {
  let warned = false;
  return function guardPlaintextBearerAuth(baseUrl, secret) {
    if (!usesPlaintextBearerAuth(baseUrl, secret)) return;
    const message = plaintextBearerAuthMessage(baseUrl);
    if ((env || process.env).AGENTMEMORY_REQUIRE_HTTPS === "1") throw new Error(message);
    if (!warned) {
      warned = true;
      warn(message);
    }
  };
}

function createClient(cfg, api) {
  const baseUrl = String(cfg.base_url || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = Number(cfg.timeout_ms || DEFAULT_TIMEOUT_MS);
  const fallbackOnError = cfg.fallback_on_error !== false;
  const secret = process.env.AGENTMEMORY_SECRET;
  const guardPlaintextBearerAuth = createPlaintextBearerAuthGuard(
    (message) => api.logger.warn?.(message),
  );
  if (process.env.AGENTMEMORY_REQUIRE_HTTPS === "1") {
    guardPlaintextBearerAuth(baseUrl, secret);
  }

  const durable = createDurableClient({
    baseUrl,
    timeoutMs,
    fallbackOnError,
    outboxDir: defaultOutboxDir(),
    secret,
    fetchImpl: fetch,
    warn: (message) => api.logger.warn?.(message),
    guard: guardPlaintextBearerAuth,
  });

  return { ...durable, baseUrl };
}

const plugin = {
  id: "agentmemory",
  name: "agentmemory",
  description: "Shared cross-session memory via the local agentmemory server.",
  configSchema,
  register(api) {
    const cfg = {
      enabled: api.pluginConfig?.enabled !== false,
      base_url: api.pluginConfig?.base_url || DEFAULT_BASE_URL,
      token_budget: api.pluginConfig?.token_budget || 2000,
      min_confidence: api.pluginConfig?.min_confidence || 0.5,
      fallback_on_error: api.pluginConfig?.fallback_on_error !== false,
      timeout_ms: api.pluginConfig?.timeout_ms || DEFAULT_TIMEOUT_MS,
    };
    const client = createClient(cfg, api);

    if (typeof api.registerMemoryCapability === "function") {
      api.registerMemoryCapability({
        // OpenClaw passes { availableTools: Set<string>, citationsMode? }. We
        // don't currently branch on tool availability, but accept the params
        // object so the signature matches MemoryPromptSectionBuilder exactly.
        promptBuilder: (_params) => [
          "Long-term memory provider: agentmemory (external REST service on " +
            client.baseUrl +
            ").",
          "agentmemory recalls relevant prior observations before each turn via before_prompt_build and captures completed turns via agent_end.",
          "Treat recalled context as background, not authoritative — prefer current workspace state and explicit user instructions when they conflict.",
        ],
      });
    }

    api.on("before_prompt_build", async (event, ctx) => {
      if (!cfg.enabled) return;
      const prompt = typeof event?.prompt === "string" ? event.prompt.trim() : "";
      if (!prompt) return;
      const identity = identityFor(event, ctx);
      if (!identity.sessionId) {
        api.logger.warn?.("agentmemory: OpenClaw prompt hook has no session identity; recall skipped");
        return;
      }
      await client.deliver("/agentmemory/session/start", {
        sessionId: identity.sessionId,
        project: identity.project,
        projectName: identity.projectName,
        cwd: identity.cwd,
        ...(identity.agentId ? { agentId: identity.agentId } : {}),
      });
      await client.deliver("/agentmemory/observe", {
        captureId: captureId([
          identity.sessionId,
          "prompt",
          event.runId || event.turnId || event.messageId || prompt,
        ]),
        hookType: "prompt_submit",
        sessionId: identity.sessionId,
        project: identity.project,
        projectName: identity.projectName,
        cwd: identity.cwd,
        ...(identity.agentId ? { agentId: identity.agentId } : {}),
        timestamp: new Date().toISOString(),
        data: { prompt },
      });
      const result = await client.requestJson("/agentmemory/smart-search", {
        query: prompt,
        limit: 5,
        project: identity.project,
        ...(identity.agentId ? { agentId: identity.agentId } : {}),
      });
      const block = formatResults(result?.results || []);
      if (!block) return;
      return {
        prependContext: `Relevant long-term memory from agentmemory:\n${block}`,
      };
    });

    api.on("agent_end", async (event, ctx) => {
      if (!cfg.enabled || !event?.success || !Array.isArray(event.messages)) return;
      const userText = latestUserText(event.messages);
      const assistantText = lastAssistantText(event.messages);
      if (!userText || !assistantText) return;
      const identity = identityFor(event, ctx);
      if (!identity.sessionId) {
        api.logger.warn?.("agentmemory: OpenClaw agent_end has no session identity; capture skipped");
        return;
      }
      const turnLocator = event.runId || event.turnId || event.messageId || [userText, assistantText];
      await client.deliver("/agentmemory/observe", {
        captureId: captureId([identity.sessionId, "conversation", turnLocator]),
        hookType: "post_tool_use",
        sessionId: identity.sessionId,
        project: identity.project,
        projectName: identity.projectName,
        cwd: identity.cwd,
        ...(identity.agentId ? { agentId: identity.agentId } : {}),
        timestamp: new Date().toISOString(),
        data: {
          tool_name: "conversation",
          tool_input: userText.slice(0, 1000),
          tool_output: assistantText.slice(0, 4000),
        },
      });
      await client.deliver("/agentmemory/session/checkpoint", {
        sessionId: identity.sessionId,
      });
    });

    api.on("session_end", async (event, ctx) => {
      if (!cfg.enabled) return;
      const identity = identityFor(event, ctx);
      if (!identity.sessionId) {
        api.logger.warn?.("agentmemory: OpenClaw session_end has no session identity; close skipped");
        return;
      }
      await client.deliver("/agentmemory/session/end", {
        sessionId: identity.sessionId,
      });
    });
  },
};

export default plugin;
