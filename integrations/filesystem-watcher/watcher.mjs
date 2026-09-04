import { watch, promises as fsp, readFileSync, statSync, realpathSync } from "node:fs";
import { resolve, relative, join, extname, sep, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes, randomUUID } from "node:crypto";

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

function canonicalRemote(remote, dir) {
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
    return value ? `file/${canonicalPath(resolve(dir, value))}` : null;
  }
}

function gitRepository(dir) {
  let current = realProjectPath(dir);
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

function gitRemoteIdentity(commonDir, dir) {
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
    const canonical = canonicalRemote(remote, dir);
    if (canonical) return canonical;
  }
  return null;
}

export function resolveProjectIdentity(dir, explicitProject) {
  if (typeof explicitProject === "string" && explicitProject.trim()) {
    const project = explicitProject.trim();
    return { project, projectName: project };
  }
  const cacheKey = canonicalPath(dir);
  const cached = projectIdentityCache.get(cacheKey);
  if (cached) return cached;
  const repository = gitRepository(dir);
  let identity;
  if (repository) {
    const canonicalCommonDir = canonicalPath(repository.commonDir);
    const projectName = basename(
      canonicalCommonDir.endsWith("/.git") ? dirname(canonicalCommonDir) : repository.top,
    );
    let project = gitProjectIdCache.get(canonicalCommonDir);
    if (!project) {
      const remote = gitRemoteIdentity(repository.commonDir, dir);
      project = remote
        ? projectHash("git", remote)
        : projectHash("path", canonicalCommonDir);
      gitProjectIdCache.set(canonicalCommonDir, project);
    }
    identity = { project, projectName };
  } else {
    identity = { project: projectHash("path", cacheKey), projectName: basename(cacheKey) };
  }
  projectIdentityCache.set(cacheKey, identity);
  return identity;
}

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".cc", ".cpp", ".h", ".hpp",
  ".md", ".mdx", ".txt", ".rst",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".env",
  ".html", ".css", ".scss", ".vue", ".svelte",
  ".sh", ".bash", ".zsh", ".fish",
  ".sql", ".graphql", ".proto",
]);

const DEFAULT_IGNORE = [
  /(?:^|\/)\.git(?:\/|$)/,
  /(?:^|\/)node_modules(?:\/|$)/,
  /(?:^|\/)dist(?:\/|$)/,
  /(?:^|\/)build(?:\/|$)/,
  /(?:^|\/)\.next(?:\/|$)/,
  /(?:^|\/)\.turbo(?:\/|$)/,
  /(?:^|\/)coverage(?:\/|$)/,
  /(?:^|\/)\.DS_Store$/,
  /\.log$/,
  /\.lock$/,
];

const MAX_PREVIEW_BYTES = 4096;
const DEBOUNCE_MS = 500;
const REPLAY_INTERVAL_MS = 15_000;
const REDACTED = "[REDACTED]";
const PEM_BEGIN_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PEM_END_RE = /-----END [A-Z ]*PRIVATE KEY-----/;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const JWT_MIN_LEN = 100;

function isDotEnvPath(path) {
  const name = basename(path).toLowerCase();
  return name === ".env" || name.startsWith(".env.");
}

function isSensitiveKey(key) {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return [
    "apikey",
    "accesstoken",
    "accesskey",
    "authorization",
    "bearer",
    "clientsecret",
    "password",
    "passwd",
    "privatekey",
    "pwd",
    "secret",
    "token",
  ].some((needle) => normalized.includes(needle));
}

function redactJwtTokens(line) {
  return line.replace(JWT_RE, (match) => (match.length >= JWT_MIN_LEN ? REDACTED : match));
}

function redactSensitiveLine(line) {
  if (PEM_BEGIN_RE.test(line) || PEM_END_RE.test(line)) {
    return line;
  }
  const assignment = line.match(
    /^(\s*(?:export\s+)?["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*([=:])\s*)(.*)$/,
  );
  if (assignment && isSensitiveKey(assignment[2])) {
    const bearer = assignment[3] === ":" ? assignment[4].match(/^(Bearer\s+).+/i) : null;
    return `${assignment[1]}${bearer ? bearer[1] : ""}${REDACTED}`;
  }
  const bearerRedacted = line.replace(
    /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}\b/gi,
    `$1${REDACTED}`,
  );
  return redactJwtTokens(bearerRedacted);
}

function redactPemBlocks(preview) {
  const lines = preview.split("\n");
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    if (!inBlock) {
      const beginMatch = line.match(PEM_BEGIN_RE);
      if (!beginMatch) {
        out.push(line);
        continue;
      }
      const beginIdx = beginMatch.index;
      const endMatch = line.match(PEM_END_RE);
      if (endMatch && endMatch.index > beginIdx) {
        const before = line.slice(0, beginIdx);
        const after = line.slice(endMatch.index + endMatch[0].length);
        out.push(`${before}${beginMatch[0]}${REDACTED}${endMatch[0]}${after}`);
      } else {
        out.push(`${line.slice(0, beginIdx)}${beginMatch[0]}`);
        out.push(REDACTED);
        inBlock = true;
      }
    } else {
      const endMatch = line.match(PEM_END_RE);
      if (endMatch) {
        out.push(`${endMatch[0]}${line.slice(endMatch.index + endMatch[0].length)}`);
        inBlock = false;
      }
    }
  }
  return out.join("\n");
}

function redactSensitivePreview(preview) {
  return redactPemBlocks(preview).split("\n").map(redactSensitiveLine).join("\n");
}

function defaultOutboxDir() {
  return process.env.AGENTMEMORY_OUTBOX_DIR ||
    join(homedir(), ".agentmemory", "outbox", "filesystem-watcher");
}

let envelopeSequence = 0;

export class FilesystemWatcher {
  constructor(config = {}) {
    this.roots = (config.roots || []).map((r) => resolve(r));
    this.baseUrl = (config.baseUrl || "http://localhost:3111").replace(/\/+$/, "");
    this.secret = config.secret;
    this.outboxDir = config.outboxDir || defaultOutboxDir();
    const defaultIdentity = this.roots[0]
      ? resolveProjectIdentity(this.roots[0], config.project)
      : resolveProjectIdentity(process.cwd(), config.project || "filesystem-watcher");
    this.project = defaultIdentity.project;
    this.projectName = defaultIdentity.projectName;
    // Per-root scope: a multi-root watcher must stamp each event with the
    // project of the root that produced it, not the first root's project.
    // An explicit config.project overrides for every root.
    this.projectByRoot = new Map(
      this.roots.map((r) => [r, resolveProjectIdentity(r, config.project)]),
    );
    this.sessionId =
      config.sessionId ||
      `fs-watcher-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    this.ignore = [...DEFAULT_IGNORE, ...(config.ignorePatterns || [])];
    this.allowBinary = Boolean(config.allowBinary);
    this.logger = config.logger || console;
    this.watchers = [];
    this.pendingByPath = new Map();
    this.deliveryQueue = Promise.resolve();
    this.replayTimer = null;
    this.automaticReplayRunning = false;
  }

  isIgnored(path) {
    return this.ignore.some((re) => re.test(path));
  }

  isTextFile(path) {
    if (this.allowBinary) return true;
    const ext = extname(path).toLowerCase();
    return TEXT_EXTENSIONS.has(ext) || isDotEnvPath(path);
  }

  async readPreview(path) {
    try {
      const fh = await fsp.open(path, "r");
      try {
        const buf = Buffer.alloc(MAX_PREVIEW_BYTES);
        const { bytesRead } = await fh.read(buf, 0, MAX_PREVIEW_BYTES, 0);
        return buf.slice(0, bytesRead).toString("utf-8");
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
  }

  async transmit(path, body) {
    const headers = { "content-type": "application/json" };
    if (this.secret) headers.authorization = `Bearer ${this.secret}`;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new Error(`observe ${res.status}: ${await res.text().catch(() => "")}`);
    }
  }

  async persist(path, body) {
    await fsp.mkdir(this.outboxDir, { recursive: true, mode: 0o700 });
    const key = createHash("sha256")
      .update(JSON.stringify({ path, captureId: body.captureId }))
      .digest("hex");
    const target = join(this.outboxDir, `${key}.json`);
    try {
      await fsp.access(target);
      return;
    } catch {}
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await fsp.writeFile(
      temporary,
      JSON.stringify({
        path,
        body,
        createdAt: new Date().toISOString(),
        sequence: ++envelopeSequence,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    try {
      await fsp.rename(temporary, target);
    } catch (error) {
      try {
        await fsp.access(target);
        await fsp.rm(temporary, { force: true });
      } catch {
        await fsp.rm(temporary, { force: true });
        throw error;
      }
    }
  }

  async envelopes() {
    let names;
    try {
      names = await fsp.readdir(this.outboxDir);
    } catch {
      return [];
    }
    const result = [];
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const file = join(this.outboxDir, name);
      try {
        const value = JSON.parse(await fsp.readFile(file, "utf8"));
        if (typeof value?.path === "string" && value.body && typeof value.body === "object") {
          result.push({ file, value });
        }
      } catch {}
    }
    result.sort((a, b) =>
      String(a.value.createdAt || "").localeCompare(String(b.value.createdAt || "")) ||
      Number(a.value.sequence || 0) - Number(b.value.sequence || 0) ||
      a.file.localeCompare(b.file),
    );
    return result;
  }

  async replayUnlocked() {
    let delivered = 0;
    for (const { file, value } of await this.envelopes()) {
      try {
        await this.transmit(value.path, value.body);
        await fsp.rm(file);
        delivered++;
      } catch (error) {
        this.logger.warn?.(
          `[fs-watcher] capture remains queued: ${error?.message || error}`,
        );
        break;
      }
    }
    return delivered;
  }

  serialized(task) {
    const run = this.deliveryQueue.then(task, task);
    this.deliveryQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  emit(event) {
    return this.serialized(async () => {
      await this.persist("/agentmemory/observe", event);
      return this.replayUnlocked();
    });
  }

  replay() {
    return this.serialized(() => this.replayUnlocked());
  }

  automaticReplay() {
    if (this.automaticReplayRunning) return;
    this.automaticReplayRunning = true;
    this.replay()
      .catch((error) =>
        this.logger.warn?.(`[fs-watcher] replay failed: ${error?.message || error}`),
      )
      .finally(() => {
        this.automaticReplayRunning = false;
      });
  }

  schedule(rootDir, relPath) {
    const key = join(rootDir, relPath);
    const existing = this.pendingByPath.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.pendingByPath.delete(key);
      this.flush(rootDir, relPath).catch((err) =>
        this.logger.warn?.(`[fs-watcher] flush failed: ${err?.message || err}`),
      );
    }, DEBOUNCE_MS);
    this.pendingByPath.set(key, { timer });
  }

  async flush(rootDir, relPath) {
    const absPath = join(rootDir, relPath);
    if (this.isIgnored(relPath)) return;
    let exists = true;
    let size = 0;
    try {
      const st = statSync(absPath);
      if (!st.isFile()) return;
      size = st.size;
    } catch {
      exists = false;
    }
    const changeKind = exists ? "file_change" : "file_delete";
    let preview = null;
    if (exists && this.isTextFile(absPath)) {
      preview = await this.readPreview(absPath);
      if (preview !== null) preview = redactSensitivePreview(preview);
    }
    const truncated = exists && size > MAX_PREVIEW_BYTES;
    const projectIdentity = this.projectByRoot.get(rootDir) ?? {
      project: this.project,
      projectName: this.projectName,
    };
    const content = this.formatContent(relPath, changeKind, preview, {
      size,
      truncated,
    });
    const payload = {
      captureId: `filesystem-watcher:${randomUUID()}`,
      hookType: "post_tool_use",
      sessionId: this.sessionId,
      ...projectIdentity,
      cwd: rootDir,
      timestamp: new Date().toISOString(),
      data: {
        source: "filesystem-watcher",
        changeKind,
        files: [relPath],
        content,
        tool_name: changeKind === "file_delete" ? "Delete" : "Write",
        tool_input: { file_path: relPath },
        tool_output: content,
        rootDir,
        absPath,
        size,
        truncated,
      },
    };
    await this.emit(payload);
  }

  formatContent(relPath, changeKind, preview, { size, truncated }) {
    if (changeKind === "file_delete") return `deleted: ${relPath}`;
    const head = `${relPath} (${size} bytes${truncated ? ", truncated" : ""})`;
    if (preview === null) return head;
    return `${head}\n\n${preview}`;
  }

  start() {
    if (this.roots.length === 0) {
      throw new Error("filesystem-watcher: at least one root directory is required");
    }
    const failures = [];
    for (const root of this.roots) {
      try {
        // Validate the root before handing it to fs.watch: on Linux with
        // Node 24+, fs.watch on a nonexistent path no longer throws
        // synchronously, so a missing root would otherwise count as
        // "attached" and be watched-in-name-only. An explicit stat keeps
        // the failure deterministic across Node versions and platforms.
        const st = statSync(root, { throwIfNoEntry: false });
        if (!st) {
          throw new Error("no such directory");
        }
        if (!st.isDirectory()) {
          throw new Error("not a directory");
        }
        const handle = watch(
          root,
          { recursive: true, persistent: true },
          (_eventType, filename) => {
            if (!filename) return;
            const rel = filename.split(sep).join("/");
            if (this.isIgnored(rel)) return;
            this.schedule(root, rel);
          },
        );
        handle.on("error", (err) => {
          this.logger.warn?.(`[fs-watcher] watch error on ${root}: ${err?.message || err}`);
        });
        this.watchers.push(handle);
        this.logger.info?.(`[fs-watcher] watching ${root}`);
      } catch (err) {
        const msg = err?.message || String(err);
        failures.push(`${root}: ${msg}`);
        this.logger.error?.(`[fs-watcher] failed to watch ${root}: ${msg}`);
      }
    }
    if (this.watchers.length === 0) {
      throw new Error(
        `filesystem-watcher: could not watch any of the configured roots. ` +
          `If you are on Node 18 + Linux, recursive fs.watch requires Node >=19.1.0; upgrade to Node 20 LTS or newer. ` +
          `Failures: ${failures.join("; ")}`,
      );
    }
    this.automaticReplay();
    this.replayTimer = setInterval(() => this.automaticReplay(), REPLAY_INTERVAL_MS);
    this.replayTimer.unref?.();
  }

  stop() {
    if (this.replayTimer) clearInterval(this.replayTimer);
    this.replayTimer = null;
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {}
    }
    this.watchers = [];
    for (const { timer } of this.pendingByPath.values()) {
      clearTimeout(timer);
    }
    this.pendingByPath.clear();
  }
}

// Small helper used by tests and bin.mjs to parse env.
export function configFromEnv(env = process.env) {
  const roots = (env.AGENTMEMORY_FS_WATCH_DIRS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const extraIgnore = (env.AGENTMEMORY_FS_WATCH_IGNORE || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new RegExp(s));
  return {
    roots,
    baseUrl: env.AGENTMEMORY_URL,
    secret: env.AGENTMEMORY_SECRET,
    // AGENTMEMORY_PROJECT_NAME is the canonical override (matches the hooks);
    // AGENTMEMORY_PROJECT stays as a deprecated alias for existing setups.
    // Trimmed, with whitespace-only treated as unset, same as resolveProject.
    project:
      (env.AGENTMEMORY_PROJECT_NAME || "").trim() ||
      (env.AGENTMEMORY_PROJECT || "").trim() ||
      null,
    sessionId: env.AGENTMEMORY_SESSION_ID || null,
    ignorePatterns: extraIgnore,
    allowBinary: env.AGENTMEMORY_FS_WATCH_ALLOW_BINARY === "1",
    outboxDir: env.AGENTMEMORY_OUTBOX_DIR || null,
  };
}

export { relative as _relativeForTests };
