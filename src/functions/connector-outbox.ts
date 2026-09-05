import { readFile, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ISdk } from "iii-sdk";
import { resolvePathLayout } from "../runtime-paths.js";
import { logger } from "../logger.js";

export type ConnectorOutbox = {
  adapter: string;
  dir: string;
};

type ConnectorEnvelope = {
  schemaVersion?: number;
  priority?: "terminal";
  path: string;
  body: Record<string, unknown>;
  createdAt?: string;
  sequence?: number;
};

type PendingEnvelope = {
  adapter: string;
  file: string;
  envelope: ConnectorEnvelope;
};

function comparePending(a: PendingEnvelope, b: PendingEnvelope): number {
  return String(a.envelope.createdAt || "").localeCompare(
    String(b.envelope.createdAt || ""),
  ) ||
    Number(a.envelope.sequence || 0) - Number(b.envelope.sequence || 0) ||
    a.file.localeCompare(b.file);
}

export type ConnectorOutboxInspection = {
  current: number;
  legacy: number;
  malformed: number;
  claimed: number;
};

export type ConnectorOutboxReplayResult = ConnectorOutboxInspection & {
  delivered: number;
  deduplicated: number;
  newlyAccepted: number;
  projectionQueued: number;
  failed: number;
  legacySkipped: number;
};

const CONNECTOR_ADAPTERS = [
  "codex",
  "hermes",
  "openclaw",
  "filesystem-watcher",
];

export function defaultConnectorOutboxes(
  env: NodeJS.ProcessEnv = process.env,
  home?: string,
): ConnectorOutbox[] {
  const explicit = env["AGENTMEMORY_OUTBOX_DIR"]?.trim();
  if (explicit) {
    return [{ adapter: "configured", dir: resolve(explicit) }];
  }
  const root = join(resolvePathLayout({ env, home }).configRoot, "outbox");
  return CONNECTOR_ADAPTERS.map((adapter) => ({
    adapter,
    dir: join(root, adapter),
  }));
}

async function readOutbox(outbox: ConnectorOutbox): Promise<{
  current: PendingEnvelope[];
  legacy: PendingEnvelope[];
  malformed: number;
  claimed: number;
}> {
  let names: string[];
  try {
    names = await readdir(outbox.dir);
  } catch {
    return { current: [], legacy: [], malformed: 0, claimed: 0 };
  }

  const current: PendingEnvelope[] = [];
  const legacy: PendingEnvelope[] = [];
  let malformed = 0;
  const claimed = names.filter((name) => name.endsWith(".json.replaying")).length;
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const file = join(outbox.dir, name);
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      if (
        typeof value?.path !== "string" ||
        !value.body ||
        typeof value.body !== "object" ||
        Array.isArray(value.body)
      ) {
        malformed += 1;
        continue;
      }
      const item = {
        adapter: outbox.adapter,
        file,
        envelope: value as ConnectorEnvelope,
      };
      if (value.schemaVersion === 2) current.push(item);
      else legacy.push(item);
    } catch {
      malformed += 1;
    }
  }

  current.sort(comparePending);
  legacy.sort(comparePending);
  return { current, legacy, malformed, claimed };
}

export async function inspectConnectorOutboxes(
  outboxes: ConnectorOutbox[],
): Promise<ConnectorOutboxInspection> {
  const readings = await Promise.all(outboxes.map(readOutbox));
  return readings.reduce(
    (total, reading) => ({
      current: total.current + reading.current.length,
      legacy: total.legacy + reading.legacy.length,
      malformed: total.malformed + reading.malformed,
      claimed: total.claimed + reading.claimed,
    }),
    { current: 0, legacy: 0, malformed: 0, claimed: 0 },
  );
}

export async function recoverConnectorOutboxClaims(
  outboxes: ConnectorOutbox[],
): Promise<number> {
  let recovered = 0;
  for (const outbox of outboxes) {
    let names: string[];
    try {
      names = await readdir(outbox.dir);
    } catch {
      continue;
    }
    for (const name of names.filter((entry) => entry.endsWith(".json.replaying"))) {
      const claim = join(outbox.dir, name);
      const pending = claim.slice(0, -".replaying".length);
      try {
        await rename(claim, pending);
        recovered += 1;
      } catch {
        try {
          await readFile(pending);
          await rm(claim, { force: true });
          recovered += 1;
        } catch {
          // Preserve an unrecognized claim for operator inspection.
        }
      }
    }
  }
  return recovered;
}

function fairSelection(
  queues: PendingEnvelope[][],
  limit: number,
): PendingEnvelope[] {
  const selected: PendingEnvelope[] = [];
  while (selected.length < limit) {
    let progressed = false;
    for (const queue of queues) {
      const item = queue.shift();
      if (!item) continue;
      selected.push(item);
      progressed = true;
      if (selected.length >= limit) break;
    }
    if (!progressed) break;
  }
  return selected;
}

function requestPath(path: string): string {
  const normalized = path.replace(/^\/+/, "");
  return normalized.startsWith("agentmemory/")
    ? `/${normalized}`
    : `/agentmemory/${normalized}`;
}

function terminalSessionSelection(
  queues: PendingEnvelope[][],
  limit: number,
): PendingEnvelope[] {
  const pending = queues.flat();
  const terminal = pending
    .filter((item) =>
      item.envelope.priority === "terminal" &&
      requestPath(item.envelope.path) === "/agentmemory/session/end" &&
      typeof item.envelope.body.sessionId === "string" &&
      item.envelope.body.sessionId.trim().length > 0
    )
    .sort(comparePending)[0];
  if (!terminal || limit <= 0) return [];

  const sessionId = String(terminal.envelope.body.sessionId).trim();
  const group = pending
    .filter((item) =>
      typeof item.envelope.body.sessionId === "string" &&
      item.envelope.body.sessionId.trim() === sessionId
    )
    .sort((a, b) => {
      const aEnds = requestPath(a.envelope.path) === "/agentmemory/session/end";
      const bEnds = requestPath(b.envelope.path) === "/agentmemory/session/end";
      if (aEnds !== bEnds) return aEnds ? 1 : -1;
      return comparePending(a, b);
    });
  return group.slice(0, limit);
}

async function restoreClaim(claim: string, pending: string): Promise<void> {
  try {
    await rename(claim, pending);
  } catch {
    try {
      await readFile(pending);
      await rm(claim, { force: true });
    } catch {
      // Leave the claim intact when neither recovery path is safe.
    }
  }
}

type ReplayAcceptance =
  | "deduplicated"
  | "newlyAccepted"
  | "projectionQueued"
  | "rejected";

async function replayAcceptance(
  item: PendingEnvelope,
  response: Response,
): Promise<ReplayAcceptance> {
  if (requestPath(item.envelope.path) !== "/agentmemory/observe") {
    return "newlyAccepted";
  }
  try {
    const body = await response.json() as {
      success?: boolean;
      deduplicated?: boolean;
      projectionQueued?: boolean;
    };
    if (body.success === false) return "rejected";
    if (body.deduplicated !== true) return "newlyAccepted";
    return body.projectionQueued === true
      ? "projectionQueued"
      : "deduplicated";
  } catch {
    return "newlyAccepted";
  }
}

export async function replayConnectorOutboxes(options: {
  outboxes: ConnectorOutbox[];
  baseUrl: string;
  secret?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  limit?: number;
  mode?: "current" | "legacy";
}): Promise<ConnectorOutboxReplayResult> {
  const readings = await Promise.all(options.outboxes.map(readOutbox));
  const inspection = readings.reduce(
    (total, reading) => ({
      current: total.current + reading.current.length,
      legacy: total.legacy + reading.legacy.length,
      malformed: total.malformed + reading.malformed,
      claimed: total.claimed + reading.claimed,
    }),
    { current: 0, legacy: 0, malformed: 0, claimed: 0 },
  );
  const mode = options.mode ?? "current";
  const limit = Math.max(0, Math.min(100, Math.floor(options.limit ?? 4)));
  const queues = readings.map((reading) => [...reading[mode]]);
  const terminalSelection = mode === "current"
    ? terminalSessionSelection(queues, limit)
    : [];
  const replayingTerminalSession = terminalSelection.length > 0;
  const selected = replayingTerminalSession
    ? terminalSelection
    : fairSelection(queues, limit);
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.secret) headers.Authorization = `Bearer ${options.secret}`;
  let delivered = 0;
  let deduplicated = 0;
  let newlyAccepted = 0;
  let projectionQueued = 0;
  let failed = 0;

  for (const item of selected) {
    const claim = `${item.file}.replaying`;
    try {
      await rename(item.file, claim);
    } catch {
      if (replayingTerminalSession) break;
      continue;
    }
    try {
      const response = await fetchImpl(
        `${baseUrl}${requestPath(item.envelope.path)}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(item.envelope.body),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const acceptance = mode === "current"
        ? await replayAcceptance(item, response)
        : "newlyAccepted";
      if (acceptance === "rejected") {
        throw new Error("Observe request was not accepted");
      }
      await rm(claim);
      await rm(item.file, { force: true });
      delivered += 1;
      if (acceptance === "deduplicated") {
        deduplicated += 1;
      } else {
        if (acceptance === "projectionQueued") projectionQueued += 1;
        else newlyAccepted += 1;
        if (mode === "current" && !replayingTerminalSession) break;
      }
    } catch {
      await restoreClaim(claim, item.file);
      failed += 1;
      if (replayingTerminalSession) break;
    }
  }

  return {
    ...inspection,
    delivered,
    deduplicated,
    newlyAccepted,
    projectionQueued,
    failed,
    legacySkipped: mode === "current" ? inspection.legacy : 0,
  };
}

export function registerConnectorOutboxReplayFunctions(
  sdk: ISdk,
  options: {
    outboxes?: ConnectorOutbox[];
    baseUrl?: string;
    secret?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): void {
  const outboxes = options.outboxes ?? defaultConnectorOutboxes();
  const baseUrl = options.baseUrl ?? "http://127.0.0.1:3111";
  let replayChain: Promise<unknown> = Promise.resolve();

  sdk.registerFunction(
    "mem::connector-outbox-replay",
    async (data: { mode?: "current" | "legacy"; limit?: number } = {}) => {
      const requestedLimit = Number.isFinite(data.limit) ? Number(data.limit) : 4;
      const limit = Math.min(20, Math.max(0, Math.floor(requestedLimit)));
      const run = replayChain.then(() =>
        replayConnectorOutboxes({
          outboxes,
          baseUrl,
          secret: options.secret,
          fetchImpl: options.fetchImpl,
          timeoutMs: options.timeoutMs,
          limit,
          mode: data.mode === "legacy" ? "legacy" : "current",
        }),
      );
      replayChain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  );

  sdk.registerFunction("mem::connector-outbox-inspect", async () =>
    inspectConnectorOutboxes(outboxes),
  );
}

export function startConnectorOutboxReplayLoop(
  sdk: ISdk,
  intervalMs = 30_000,
): { stop(): void } {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await sdk.trigger({
        function_id: "mem::connector-outbox-replay",
        payload: { limit: 20 },
      });
    } catch (error) {
      logger.warn("Connector outbox replay tick failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
