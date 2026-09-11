import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ISdk } from "../iii-compat.js";
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
  pending: number;
  scanned: number;
  truncated: boolean;
};

const DEFAULT_OUTBOX_SCAN_LIMIT = 500;
const OUTBOX_STAT_CONCURRENCY = 32;

export function resolveOutboxScanLimit(
  requested?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  // An explicit 0 means "parse nothing"; only an absent/invalid value falls back.
  if (Number.isFinite(requested as number) && Number(requested) >= 0) {
    return Math.floor(Number(requested));
  }
  // A blank or whitespace value must not read as 0 and silently disable replay.
  const raw = (env.AGENTMEMORY_OUTBOX_SCAN_LIMIT ?? "").trim();
  const configured = raw === "" ? Number.NaN : Number(raw);
  return Number.isFinite(configured) && configured >= 0
    ? Math.floor(configured)
    : DEFAULT_OUTBOX_SCAN_LIMIT;
}

type OutboxEntry = {
  outbox: ConnectorOutbox;
  queue: number;
  name: string;
  at: number;
};

async function orderEntriesByWriteTime(entries: OutboxEntry[]): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= entries.length) return;
      const entry = entries[index];
      try {
        const { mtimeMs } = await stat(join(entry.outbox.dir, entry.name));
        // A non-finite mtime would make the comparator non-antisymmetric.
        entry.at = Number.isFinite(mtimeMs) ? mtimeMs : Number.POSITIVE_INFINITY;
      } catch {
        entry.at = Number.POSITIVE_INFINITY;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(OUTBOX_STAT_CONCURRENCY, entries.length) },
      worker,
    ),
  );
  entries.sort((a, b) =>
    (a.at === b.at ? 0 : a.at < b.at ? -1 : 1) ||
    a.name.localeCompare(b.name) ||
    a.queue - b.queue
  );
}

export type ConnectorOutboxReplayResult = ConnectorOutboxInspection & {
  delivered: number;
  deduplicated: number;
  newlyAccepted: number;
  projectionQueued: number;
  failed: number;
  /** Envelopes the server rejects on every retry, moved under <outbox>/rejected/<reason>/. */
  rejected: number;
  rejectedByReason: Record<string, number>;
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

type OutboxQueue = {
  current: PendingEnvelope[];
  legacy: PendingEnvelope[];
};

// How far past an undeliverable prefix a single pass may read. Legacy and
// malformed envelopes are never deleted in current mode, so a fixed window
// anchored on the oldest files would eventually hold nothing deliverable.
const OUTBOX_PARSE_CAP_FACTOR = 10;

async function readOutboxes(options: {
  outboxes: ConnectorOutbox[];
  scanLimit: number;
  ordered: boolean;
  // "sample" stops at the window; a replay mode keeps reading past envelopes it
  // cannot deliver until it has a full window of the class it will deliver.
  want: "current" | "legacy" | "sample";
}): Promise<{ queues: OutboxQueue[]; inspection: ConnectorOutboxInspection }> {
  const { outboxes, scanLimit } = options;
  const queues: OutboxQueue[] = outboxes.map(() => ({ current: [], legacy: [] }));
  const entries: OutboxEntry[] = [];
  let claimed = 0;
  let pending = 0;

  const listings = await Promise.all(
    outboxes.map(async (outbox) => {
      try {
        return await readdir(outbox.dir);
      } catch {
        return [] as string[];
      }
    }),
  );
  const perOutbox = listings.map((names, queue) => {
    claimed += names.filter((name) => name.endsWith(".json.replaying")).length;
    const pendingNames = names.filter((entry) => entry.endsWith(".json"));
    pending += pendingNames.length;
    return pendingNames.map((name) => ({
      outbox: outboxes[queue],
      queue,
      name,
      at: 0,
    }));
  });
  // Interleave adapters. An unordered sample must not be one adapter's readdir
  // prefix, or the health snapshot goes blind to every other adapter.
  for (let index = 0; entries.length < pending; index += 1) {
    for (const listing of perOutbox) {
      if (index < listing.length) entries.push(listing[index]);
    }
  }

  // Order across every adapter, not per adapter: replay selects a terminal
  // session and its predecessors from the union, so a per-adapter window could
  // admit a session/end while its own earlier envelopes stayed unparsed.
  if (options.ordered && scanLimit > 0 && entries.length > scanLimit) {
    await orderEntriesByWriteTime(entries);
  }

  const parseCap = Math.min(
    entries.length,
    options.want === "sample" ? scanLimit : scanLimit * OUTBOX_PARSE_CAP_FACTOR,
  );
  // Terminal envelopes must never ship ahead of their own session, so a bounded
  // scan holds them aside. They must not spend a window slot either: pinned at
  // the oldest end and never delivered, they would fill the window and wedge
  // replay permanently. They go back only when the scan turned out complete.
  const held: Array<{ queue: number; legacy: boolean; item: PendingEnvelope }> = [];
  let heldDropped = false;
  let currentSeen = 0;
  let legacySeen = 0;
  let currentKept = 0;
  let legacyKept = 0;
  let malformed = 0;
  let scanned = 0;
  const satisfied = (): boolean =>
    options.want === "current"
      ? currentKept >= scanLimit
      : options.want === "legacy"
      ? legacyKept >= scanLimit
      : false;
  for (const entry of entries) {
    if (scanned >= parseCap || satisfied()) break;
    scanned += 1;
    const file = join(entry.outbox.dir, entry.name);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(file, "utf8"));
    } catch {
      malformed += 1;
      continue;
    }
    const candidate = value as ConnectorEnvelope | null;
    if (
      typeof candidate?.path !== "string" ||
      !candidate.body ||
      typeof candidate.body !== "object" ||
      Array.isArray(candidate.body)
    ) {
      malformed += 1;
      continue;
    }
    const item = {
      adapter: entry.outbox.adapter,
      file,
      envelope: candidate,
    };
    const legacyItem = candidate.schemaVersion !== 2;
    if (legacyItem) legacySeen += 1;
    else currentSeen += 1;
    if (
      candidate.priority === "terminal" ||
      requestPath(candidate.path) === "/agentmemory/session/end"
    ) {
      if (held.length >= scanLimit) heldDropped = true;
      else held.push({ queue: entry.queue, legacy: legacyItem, item });
      continue;
    }
    if (legacyItem) {
      if (legacyKept >= scanLimit) continue;
      queues[entry.queue].legacy.push(item);
      legacyKept += 1;
    } else {
      if (currentKept >= scanLimit) continue;
      queues[entry.queue].current.push(item);
      currentKept += 1;
    }
  }

  const complete = scanned >= pending && !heldDropped;
  if (complete) {
    for (const entry of held) {
      const queue = queues[entry.queue];
      if (entry.legacy) queue.legacy.push(entry.item);
      else queue.current.push(entry.item);
    }
  }
  const wanted = options.want === "legacy" ? legacyKept : currentKept;
  if (
    options.want !== "sample" && wanted === 0 && pending > 0 && scanned > 0 &&
    scanned >= parseCap
  ) {
    logger.warn("Connector outbox scan found nothing deliverable", {
      want: options.want,
      pending,
      scanned,
      legacy: legacySeen,
      malformed,
    });
  }
  for (const queue of queues) {
    queue.current.sort(comparePending);
    queue.legacy.sort(comparePending);
  }
  return {
    queues,
    inspection: {
      current: currentSeen,
      legacy: legacySeen,
      malformed,
      claimed,
      pending,
      scanned,
      truncated: !complete,
    },
  };
}

export async function inspectConnectorOutboxes(
  outboxes: ConnectorOutbox[],
  scanLimit?: number,
): Promise<ConnectorOutboxInspection> {
  const limit = resolveOutboxScanLimit(scanLimit);
  // Classification is a sample, so write-time ordering buys nothing here and
  // the stat sweep it costs would run on every health tick.
  const { inspection } = await readOutboxes({
    outboxes,
    scanLimit: limit,
    ordered: false,
    want: "sample",
  });
  return inspection;
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

// Rejections the server will give again on every retry. Live outbox
// 2026-09-11: 3,791 envelopes whose observations already existed as
// pre-fingerprint rows; every tick took the same oldest twenty, each answered
// 409 legacy_identity_unverified, and the queue never advanced. Such an
// envelope is moved under <outbox>/rejected/<reason>/ and counted.
const TERMINAL_REJECTIONS = new Set(["legacy_identity_unverified", "capture_id_conflict"]);

async function terminalRejection(response: Response): Promise<string | null> {
  if (response.status < 400 || response.status >= 500) return null;
  if (response.status === 401 || response.status === 403 || response.status === 429) return null;
  try {
    const body = (await response.clone().json()) as { error?: unknown };
    const error = typeof body?.error === "string" ? body.error : null;
    return error && TERMINAL_REJECTIONS.has(error) ? error : null;
  } catch {
    return null;
  }
}

async function quarantineClaim(claim: string, pending: string, reason: string): Promise<void> {
  const dir = join(dirname(pending), "rejected", reason);
  await mkdir(dir, { recursive: true });
  await rename(claim, join(dir, basename(pending)));
  await rm(pending, { force: true });
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
  scanLimit?: number;
  mode?: "current" | "legacy";
  // Newly accepted observations one current-mode pass may deliver before it
  // stops (each one queues a projection). The automatic tick keeps 1; an
  // operator draining a backlog raises it.
  acceptBudget?: number;
}): Promise<ConnectorOutboxReplayResult> {
  const scanLimit = resolveOutboxScanLimit(options.scanLimit);
  const mode = options.mode ?? "current";
  const acceptBudget = Math.max(1, Math.floor(options.acceptBudget ?? 1));
  let accepted = 0;
  const { queues: readings, inspection } = await readOutboxes({
    outboxes: options.outboxes,
    scanLimit,
    ordered: true,
    want: mode,
  });
  const limit = Math.max(0, Math.min(100, Math.floor(options.limit ?? 4)));
  // A bounded scan keeps its window by write time but orders delivery by
  // createdAt, and the two can disagree. While the scan is truncated we cannot
  // prove a session's earlier envelopes were seen, so no terminal ships at all:
  // a session must never be ended ahead of its own observations.
  const queues = readings.map((reading) => [...reading[mode]]);
  const terminalSelection = mode === "current" && !inspection.truncated
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
  let rejected = 0;
  const rejectedByReason: Record<string, number> = {};

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
      if (!response.ok) {
        const reason = await terminalRejection(response);
        if (reason) {
          await quarantineClaim(claim, item.file, reason);
          rejected += 1;
          rejectedByReason[reason] = (rejectedByReason[reason] ?? 0) + 1;
          continue;
        }
        throw new Error(`HTTP ${response.status}`);
      }
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
        accepted += 1;
        if (mode === "current" && !replayingTerminalSession && accepted >= acceptBudget) break;
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
    rejected,
    rejectedByReason,
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
    scanLimit?: number;
  } = {},
): void {
  const outboxes = options.outboxes ?? defaultConnectorOutboxes();
  const baseUrl = options.baseUrl ?? "http://127.0.0.1:3111";
  let replayChain: Promise<unknown> = Promise.resolve();

  sdk.registerFunction(
    "mem::connector-outbox-replay",
    async (data: { mode?: "current" | "legacy"; limit?: number; accept?: number } = {}) => {
      const requestedLimit = Number.isFinite(data.limit) ? Number(data.limit) : 4;
      const limit = Math.min(20, Math.max(0, Math.floor(requestedLimit)));
      const requestedAccept = Number.isFinite(data.accept) ? Number(data.accept) : 1;
      const acceptBudget = Math.min(20, Math.max(1, Math.floor(requestedAccept)));
      const run = replayChain.then(() =>
        replayConnectorOutboxes({
          outboxes,
          baseUrl,
          secret: options.secret,
          fetchImpl: options.fetchImpl,
          timeoutMs: options.timeoutMs,
          limit,
          scanLimit: options.scanLimit,
          mode: data.mode === "legacy" ? "legacy" : "current",
          acceptBudget,
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
    inspectConnectorOutboxes(outboxes, options.scanLimit),
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
