import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnvFile } from "../env-file.js";
import { agentMemoryOutboxPath, resolvePathLayout } from "../runtime-paths.js";

export type HookDelivery = ReturnType<typeof createHookDelivery>;

let envelopeSequence = 0;

function defaultOutboxDir(): string {
  return agentMemoryOutboxPath("codex");
}

function hookTransportEnv(): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(resolvePathLayout().envFile, "utf8"));
  } catch {
    return {};
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

export function stableHookCaptureId(
  sessionId: string,
  eventType: string,
  locator: unknown,
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([sessionId, eventType, locator]))
    .digest("hex");
  return `codex:${hash.slice(0, 32)}`;
}

/**
 * The locator of a lifecycle event for stableHookCaptureId: every natural id
 * the payload carries (agent id, turn id), or the moment of capture when it
 * carries none. Keyed on the agent alone, an agent that stops once per turn
 * repeated its capture id; keyed on the prompt text, "진행" typed twice did;
 * keyed on the trigger word, every compaction did -- 125 envelopes rejected
 * as capture_id_conflict on 2026-09-11, each one a lost event.
 */
export function hookEventLocator(candidates: unknown[], capturedAt: string): unknown {
  const present = candidates.filter((candidate) =>
    typeof candidate === "string" ? candidate.trim().length > 0 : candidate != null,
  );
  return present.length > 0 ? present : capturedAt;
}

export function hookSessionId(data: Record<string, unknown>): string | null {
  const value = [data.session_id, data.sessionId, data.conversation_id]
    .find((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
  return typeof value === "string" ? value.trim() : null;
}

export function createHookDelivery(options: {
  restUrl?: string;
  secret?: string;
  outboxDir?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  priority?: "terminal";
} = {}) {
  const fileEnv = hookTransportEnv();
  const restUrl = (options.restUrl || nonEmpty(process.env["AGENTMEMORY_URL"]) ||
    nonEmpty(fileEnv["AGENTMEMORY_URL"]) || "http://localhost:3111")
    .replace(/\/+$/, "");
  const secret = options.secret ?? nonEmpty(process.env["AGENTMEMORY_SECRET"]) ??
    nonEmpty(fileEnv["AGENTMEMORY_SECRET"]) ?? "";
  const outboxDir = options.outboxDir || defaultOutboxDir();
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs ?? 800;
  const priority = options.priority;
  let queue = Promise.resolve();
  const queuedFiles = new Set<string>();

  function headers(): Record<string, string> {
    const result: Record<string, string> = { "Content-Type": "application/json" };
    if (secret) result.Authorization = `Bearer ${secret}`;
    return result;
  }

  function bodyForTransmission(
    path: string,
    body: Record<string, unknown>,
  ): Record<string, unknown> {
    if (
      path === "/agentmemory/session/start" &&
      body.includeContext === undefined
    ) {
      return { ...body, includeContext: false };
    }
    return body;
  }

  async function transmit(path: string, body: Record<string, unknown>): Promise<void> {
    const response = await fetchImpl(`${restUrl}${path}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(bodyForTransmission(path, body)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  }

  async function persist(path: string, body: Record<string, unknown>): Promise<string> {
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
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({
        schemaVersion: 2,
        ...(priority ? { priority } : {}),
        path,
        body,
        createdAt: new Date().toISOString(),
        sequence: ++envelopeSequence,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    try {
      await rename(temporary, target);
    } catch (error) {
      try {
        await access(target);
        await rm(temporary, { force: true });
      } catch {
        await rm(temporary, { force: true });
        throw error;
      }
    }
    return target;
  }

  async function deliverEnvelope(file: string): Promise<number> {
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      if (typeof value?.path !== "string" || !value.body || typeof value.body !== "object") {
        return 0;
      }
      await transmit(value.path, value.body);
      await rm(file);
      return 1;
    } catch {
      return 0;
    }
  }

  async function listEnvelopes(): Promise<Array<{
    file: string;
    value: { path: string; body: Record<string, unknown>; createdAt?: string; sequence?: number };
  }>> {
    let names: string[];
    try {
      names = await readdir(outboxDir);
    } catch {
      return [];
    }
    const result: Array<{
      file: string;
      value: { path: string; body: Record<string, unknown>; createdAt?: string; sequence?: number };
    }> = [];
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const file = join(outboxDir, name);
      try {
        const value = JSON.parse(await readFile(file, "utf8"));
        if (typeof value?.path === "string" && value.body && typeof value.body === "object") {
          result.push({ file, value });
        }
      } catch {
        // Preserve malformed envelopes for operator inspection.
      }
    }
    result.sort((a, b) =>
      String(a.value.createdAt || "").localeCompare(String(b.value.createdAt || "")) ||
      Number(a.value.sequence || 0) - Number(b.value.sequence || 0) ||
      a.file.localeCompare(b.file),
    );
    return result;
  }

  async function replayUnlocked(deadline = Number.POSITIVE_INFINITY): Promise<number> {
    let delivered = 0;
    for (const { file, value } of await listEnvelopes()) {
      if (Date.now() >= deadline) break;
      try {
        await transmit(value.path, value.body);
        await rm(file);
        delivered++;
      } catch {
        break;
      }
    }
    return delivered;
  }

  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  return {
    enqueue(path: string, body: Record<string, unknown>): Promise<void> {
      return serialized(async () => {
        queuedFiles.add(await persist(path, body));
      });
    },
    deliver(path: string, body: Record<string, unknown>): Promise<number> {
      return serialized(async () => {
        const file = await persist(path, body);
        return deliverEnvelope(file);
      });
    },
    replay(): Promise<number> {
      return serialized(replayUnlocked);
    },
    replayFor(budgetMs: number): Promise<number> {
      const safeBudget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 0;
      return serialized(() => replayUnlocked(Date.now() + safeBudget));
    },
    replayQueuedFor(budgetMs: number): Promise<number> {
      const safeBudget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 0;
      return serialized(async () => {
        const deadline = Date.now() + safeBudget;
        let delivered = 0;
        for (const file of queuedFiles) {
          if (Date.now() >= deadline) break;
          try {
            const value = JSON.parse(await readFile(file, "utf8"));
            if (
              typeof value?.path !== "string" ||
              !value.body ||
              typeof value.body !== "object"
            ) {
              break;
            }
            await transmit(value.path, value.body);
            await rm(file);
            queuedFiles.delete(file);
            delivered++;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              queuedFiles.delete(file);
              continue;
            }
            break;
          }
        }
        return delivered;
      });
    },
  };
}

let sharedDelivery: HookDelivery | null = null;

export function defaultHookDelivery(): HookDelivery {
  if (!sharedDelivery) sharedDelivery = createHookDelivery();
  return sharedDelivery;
}
