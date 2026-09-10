import type { ISdk } from "../iii-compat.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  AccessLogExport,
  CommitLink,
  GraphEdge,
  GraphRejectedAssertion,
  GraphProjection,
  GraphSnapshot,
  MemorySlot,
  MeshPeer,
  ObservationProjection,
  RawObservation,
  RetentionScore,
  RoutineRun,
  SessionProjection,
  SnapshotEnvelope,
  SnapshotMeta,
  SnapshotPayload,
  SnapshotProjectionMarker,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { recordAudit } from "./audit.js";
import { collectExportData } from "./export-import.js";
import { writeInsight } from "./insight-index.js";
import { logger } from "../logger.js";

const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;
const SNAPSHOT_FORMAT_VERSION = 2;

const execFileAsync = promisify(execFile);

async function gitExec(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: dir });
  return stdout.trim();
}

async function ensureGitRepo(dir: string): Promise<void> {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, ".git"))) {
    await gitExec(dir, ["init"]);
    await gitExec(dir, ["config", "user.email", "agentmemory@local"]);
    await gitExec(dir, ["config", "user.name", "agentmemory"]);
  }
}

function digestPayload(payload: SnapshotPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function listOrEmpty<T>(kv: StateKV, scope: string): Promise<T[]> {
  return kv.list<T>(scope);
}

export async function collectSnapshotPayload(
  kv: StateKV,
): Promise<SnapshotPayload> {
  const exported = await collectExportData(kv, undefined, { strict: true });
  const graphSnapshot = await kv.get<GraphSnapshot>(KV.graphSnapshot, "current");
  if (graphSnapshot?.graphGeneration) {
    const nodes = (exported.graphNodes ?? []).filter(
      (node) => node.graphGeneration === graphSnapshot.graphGeneration,
    );
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = (exported.graphEdges ?? []).filter(
      (edge) =>
        edge.graphGeneration === graphSnapshot.graphGeneration &&
        nodeIds.has(edge.sourceNodeId) &&
        nodeIds.has(edge.targetNodeId),
    );
    exported.graphNodes = nodes.length > 0 ? nodes : undefined;
    exported.graphEdges = edges.length > 0 ? edges : undefined;
  } else if (graphSnapshot?.resetAt) {
    const nodes = (exported.graphNodes ?? []).filter(
      (node) => node.createdAt >= graphSnapshot.resetAt!,
    );
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = (exported.graphEdges ?? []).filter(
      (edge) =>
        edge.createdAt >= graphSnapshot.resetAt! &&
        nodeIds.has(edge.sourceNodeId) &&
        nodeIds.has(edge.targetNodeId),
    );
    exported.graphNodes = nodes.length > 0 ? nodes : undefined;
    exported.graphEdges = edges.length > 0 ? edges : undefined;
  }
  const rawObservations: Record<string, RawObservation[]> = {};
  const rawResults = await Promise.all(
    exported.sessions.map((session) =>
      listOrEmpty<RawObservation>(kv, KV.rawObservations(session.id)).then(
        (observations) => ({ sessionId: session.id, observations }),
      ),
    ),
  );
  for (const { sessionId, observations } of rawResults) {
    if (observations.length > 0) rawObservations[sessionId] = observations;
  }

  const [
    observationProjections,
    graphProjections,
    compressionPending,
    compressionFailed,
    summaryPending,
    summaryFailed,
    graphPending,
    graphFailed,
    routineRuns,
    slots,
    globalSlots,
    meshPeers,
    retentionScores,
    graphEdgeHistory,
    commits,
    graphRejected,
  ] = await Promise.all([
    listOrEmpty<ObservationProjection>(kv, KV.observationProjections),
    listOrEmpty<GraphProjection>(kv, KV.graphProjections),
    listOrEmpty<SnapshotProjectionMarker>(
      kv,
      KV.projectionPending("compression"),
    ),
    listOrEmpty<SnapshotProjectionMarker>(
      kv,
      KV.projectionFailed("compression"),
    ),
    listOrEmpty<SnapshotProjectionMarker>(kv, KV.projectionPending("summary")),
    listOrEmpty<SnapshotProjectionMarker>(kv, KV.projectionFailed("summary")),
    listOrEmpty<SnapshotProjectionMarker>(kv, KV.projectionPending("graph")),
    listOrEmpty<SnapshotProjectionMarker>(kv, KV.projectionFailed("graph")),
    listOrEmpty<RoutineRun>(kv, KV.routineRuns),
    listOrEmpty<MemorySlot>(kv, KV.slots),
    listOrEmpty<MemorySlot>(kv, KV.globalSlots),
    listOrEmpty<MeshPeer>(kv, KV.mesh),
    listOrEmpty<RetentionScore>(kv, KV.retentionScores),
    listOrEmpty<GraphEdge>(kv, KV.graphEdgeHistory),
    listOrEmpty<CommitLink>(kv, KV.commits),
    listOrEmpty<GraphRejectedAssertion>(kv, KV.graphRejected),
  ]);

  return {
    ...exported,
    ...(graphSnapshot?.graphGeneration
      ? { graphGeneration: graphSnapshot.graphGeneration }
      : {}),
    ...(graphSnapshot?.resetAt ? { graphResetAt: graphSnapshot.resetAt } : {}),
    rawObservations,
    observationProjections,
    graphProjections,
    projectionBacklogs: {
      compression: {
        pending: compressionPending,
        failed: compressionFailed,
      },
      summary: { pending: summaryPending, failed: summaryFailed },
      graph: { pending: graphPending, failed: graphFailed },
    },
    routineRuns: routineRuns.length > 0 ? routineRuns : undefined,
    slots: slots.length > 0 ? slots : undefined,
    globalSlots: globalSlots.length > 0 ? globalSlots : undefined,
    meshPeers: meshPeers.length > 0 ? meshPeers : undefined,
    retentionScores:
      retentionScores.length > 0 ? retentionScores : undefined,
    graphEdgeHistory:
      graphEdgeHistory.length > 0 ? graphEdgeHistory : undefined,
    commits: commits.length > 0 ? commits : undefined,
    graphRejected: graphRejected.length > 0 ? graphRejected : undefined,
  };
}

function snapshotEnvelope(payload: SnapshotPayload): SnapshotEnvelope {
  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    payload,
    integrity: { algorithm: "sha256", digest: digestPayload(payload) },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
}

function requireKeyedRecords(
  value: unknown,
  key: string,
  label: string,
): asserts value is Array<Record<string, unknown>> {
  requireArray(value, label);
  for (const record of value) {
    if (!isRecord(record) || typeof record[key] !== "string" || !record[key]) {
      throw new Error(`${label} entries require ${key}`);
    }
  }
}

function requireObservationBuckets(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const [sessionId, observations] of Object.entries(value)) {
    if (!sessionId) throw new Error(`${label} sessionId is required`);
    requireKeyedRecords(observations, "id", `${label}.${sessionId}`);
  }
}

function requireOptionalKeyedRecords(
  value: unknown,
  key: string,
  label: string,
): void {
  if (value !== undefined) requireKeyedRecords(value, key, label);
}

function validateProjectionBacklogs(value: unknown): void {
  if (!isRecord(value)) throw new Error("projectionBacklogs must be an object");
  for (const stage of ["compression", "graph"] as const) {
    const backlog = value[stage];
    if (!isRecord(backlog)) {
      throw new Error(`projectionBacklogs.${stage} must be an object`);
    }
    requireKeyedRecords(
      backlog.pending,
      "id",
      `projectionBacklogs.${stage}.pending`,
    );
    requireKeyedRecords(
      backlog.failed,
      "id",
      `projectionBacklogs.${stage}.failed`,
    );
  }
  const summary = value.summary;
  if (summary !== undefined) {
    if (!isRecord(summary)) {
      throw new Error("projectionBacklogs.summary must be an object");
    }
    requireKeyedRecords(
      summary.pending,
      "id",
      "projectionBacklogs.summary.pending",
    );
    requireKeyedRecords(
      summary.failed,
      "id",
      "projectionBacklogs.summary.failed",
    );
  }
}

function parseSnapshotEnvelope(content: string): SnapshotEnvelope {
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed) || parsed.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
    throw new Error(
      "Unsupported snapshot format; create a new formatVersion 2 snapshot",
    );
  }
  if (!isRecord(parsed.payload)) throw new Error("snapshot payload is required");
  if (
    !isRecord(parsed.integrity) ||
    parsed.integrity.algorithm !== "sha256" ||
    typeof parsed.integrity.digest !== "string" ||
    !/^[0-9a-f]{64}$/i.test(parsed.integrity.digest)
  ) {
    throw new Error("snapshot integrity metadata is invalid");
  }

  const payload = parsed.payload;
  if (
    payload.graphGeneration !== undefined &&
    (typeof payload.graphGeneration !== "string" || !payload.graphGeneration)
  ) {
    throw new Error("graphGeneration must be a non-empty string");
  }
  if (
    payload.graphResetAt !== undefined &&
    (typeof payload.graphResetAt !== "string" ||
      !Number.isFinite(Date.parse(payload.graphResetAt)))
  ) {
    throw new Error("graphResetAt must be an ISO timestamp");
  }
  requireKeyedRecords(payload.sessions, "id", "sessions");
  requireObservationBuckets(payload.observations, "observations");
  requireObservationBuckets(payload.rawObservations, "rawObservations");
  requireKeyedRecords(payload.memories, "id", "memories");
  requireKeyedRecords(payload.summaries, "sessionId", "summaries");
  requireOptionalKeyedRecords(
    payload.sessionProjections,
    "sessionId",
    "sessionProjections",
  );
  requireOptionalKeyedRecords(payload.profiles, "project", "profiles");
  requireOptionalKeyedRecords(payload.graphNodes, "id", "graphNodes");
  requireOptionalKeyedRecords(payload.graphEdges, "id", "graphEdges");
  requireOptionalKeyedRecords(
    payload.semanticMemories,
    "id",
    "semanticMemories",
  );
  requireOptionalKeyedRecords(
    payload.proceduralMemories,
    "id",
    "proceduralMemories",
  );
  for (const label of [
    "actions",
    "actionEdges",
    "routines",
    "signals",
    "checkpoints",
    "sentinels",
    "sketches",
    "crystals",
    "facets",
    "lessons",
    "insights",
    "routineRuns",
    "meshPeers",
    "graphEdgeHistory",
    "graphRejected",
  ]) {
    requireOptionalKeyedRecords(payload[label], "id", label);
  }
  requireOptionalKeyedRecords(payload.accessLogs, "memoryId", "accessLogs");
  requireKeyedRecords(
    payload.observationProjections,
    "observationId",
    "observationProjections",
  );
  requireKeyedRecords(
    payload.graphProjections,
    "sourceId",
    "graphProjections",
  );
  requireOptionalKeyedRecords(payload.slots, "label", "slots");
  requireOptionalKeyedRecords(payload.globalSlots, "label", "globalSlots");
  requireOptionalKeyedRecords(
    payload.retentionScores,
    "memoryId",
    "retentionScores",
  );
  requireOptionalKeyedRecords(payload.commits, "sha", "commits");
  validateProjectionBacklogs(payload.projectionBacklogs);

  const expected = digestPayload(payload as unknown as SnapshotPayload);
  if (expected !== parsed.integrity.digest) {
    throw new Error("snapshot integrity digest mismatch");
  }
  return parsed as unknown as SnapshotEnvelope;
}

const CANONICAL_ROOT_SCOPES = [
  KV.sessions,
  KV.memories,
  KV.summaries,
  KV.profiles,
  KV.graphNodes,
  KV.graphEdges,
  KV.semantic,
  KV.procedural,
  KV.actions,
  KV.actionEdges,
  KV.routines,
  KV.routineRuns,
  KV.signals,
  KV.checkpoints,
  KV.sentinels,
  KV.sketches,
  KV.crystals,
  KV.facets,
  KV.lessons,
  KV.insights,
  KV.accessLog,
  KV.observationProjections,
  KV.sessionProjections,
  KV.graphProjections,
  KV.projectionPending("compression"),
  KV.projectionFailed("compression"),
  KV.projectionPending("summary"),
  KV.projectionFailed("summary"),
  KV.projectionPending("graph"),
  KV.projectionFailed("graph"),
  KV.slots,
  KV.globalSlots,
  KV.mesh,
  KV.retentionScores,
  KV.graphEdgeHistory,
  KV.commits,
  KV.graphRejected,
] as const;

async function findNonEmptyCanonicalScope(kv: StateKV): Promise<string | null> {
  for (const scope of CANONICAL_ROOT_SCOPES) {
    if ((await kv.list(scope)).length > 0) return scope;
  }
  return null;
}

async function writeRecords<T>(
  kv: StateKV,
  scope: string,
  records: readonly T[] | undefined,
  key: (record: T) => string,
): Promise<void> {
  for (const record of records ?? []) await kv.set(scope, key(record), record);
}

async function restoreSnapshotPayload(
  kv: StateKV,
  payload: SnapshotPayload,
): Promise<void> {
  await writeRecords(kv, KV.sessions, payload.sessions, (record) => record.id);
  for (const [sessionId, observations] of Object.entries(payload.rawObservations)) {
    await writeRecords(kv, KV.rawObservations(sessionId), observations, (r) => r.id);
  }
  for (const [sessionId, observations] of Object.entries(payload.observations)) {
    await writeRecords(kv, KV.observations(sessionId), observations, (r) => r.id);
  }
  await writeRecords(kv, KV.memories, payload.memories, (record) => record.id);
  await writeRecords(
    kv,
    KV.summaries,
    payload.summaries,
    (record) => record.sessionId,
  );
  await writeRecords(
    kv,
    KV.sessionProjections,
    payload.sessionProjections,
    (record: SessionProjection) => record.sessionId,
  );
  await writeRecords(kv, KV.profiles, payload.profiles, (record) => record.project);
  await writeRecords(kv, KV.graphNodes, payload.graphNodes, (record) => record.id);
  await writeRecords(kv, KV.graphEdges, payload.graphEdges, (record) => record.id);
  await writeRecords(
    kv,
    KV.semantic,
    payload.semanticMemories,
    (record) => record.id,
  );
  await writeRecords(
    kv,
    KV.procedural,
    payload.proceduralMemories,
    (record) => record.id,
  );
  await writeRecords(kv, KV.actions, payload.actions, (record) => record.id);
  await writeRecords(
    kv,
    KV.actionEdges,
    payload.actionEdges,
    (record) => record.id,
  );
  await writeRecords(kv, KV.routines, payload.routines, (record) => record.id);
  await writeRecords(kv, KV.signals, payload.signals, (record) => record.id);
  await writeRecords(
    kv,
    KV.checkpoints,
    payload.checkpoints,
    (record) => record.id,
  );
  await writeRecords(
    kv,
    KV.sentinels,
    payload.sentinels,
    (record) => record.id,
  );
  await writeRecords(kv, KV.sketches, payload.sketches, (record) => record.id);
  await writeRecords(kv, KV.crystals, payload.crystals, (record) => record.id);
  await writeRecords(kv, KV.facets, payload.facets, (record) => record.id);
  await writeRecords(kv, KV.lessons, payload.lessons, (record) => record.id);
  // Through writeInsight rather than writeRecords: the index is derived
  // state and a restore must leave it consistent, like the graph snapshot.
  for (const insight of payload.insights ?? []) await writeInsight(kv, insight);
  await writeRecords(
    kv,
    KV.accessLog,
    payload.accessLogs,
    (record: AccessLogExport) => record.memoryId,
  );
  await writeRecords(
    kv,
    KV.observationProjections,
    payload.observationProjections,
    (record) => record.observationId,
  );
  await writeRecords(
    kv,
    KV.graphProjections,
    payload.graphProjections,
    (record) => `${record.sourceKind}:${record.sourceId}`,
  );
  for (const stage of ["compression", "graph"] as const) {
    await writeRecords(
      kv,
      KV.projectionPending(stage),
      payload.projectionBacklogs[stage].pending,
      (record) => record.id,
    );
    await writeRecords(
      kv,
      KV.projectionFailed(stage),
      payload.projectionBacklogs[stage].failed,
      (record) => record.id,
    );
  }
  if (payload.projectionBacklogs.summary) {
    await writeRecords(
      kv,
      KV.projectionPending("summary"),
      payload.projectionBacklogs.summary.pending,
      (record) => record.id,
    );
    await writeRecords(
      kv,
      KV.projectionFailed("summary"),
      payload.projectionBacklogs.summary.failed,
      (record) => record.id,
    );
  }
  await writeRecords(kv, KV.routineRuns, payload.routineRuns, (record) => record.id);
  await writeRecords(kv, KV.slots, payload.slots, (record) => record.label);
  await writeRecords(
    kv,
    KV.globalSlots,
    payload.globalSlots,
    (record) => record.label,
  );
  await writeRecords(kv, KV.mesh, payload.meshPeers, (record) => record.id);
  await writeRecords(
    kv,
    KV.retentionScores,
    payload.retentionScores,
    (record) => record.memoryId,
  );
  await writeRecords(
    kv,
    KV.graphEdgeHistory,
    payload.graphEdgeHistory,
    (record) => record.id,
  );
  await writeRecords(kv, KV.graphRejected, payload.graphRejected, (record) => record.id);
  await writeRecords(kv, KV.commits, payload.commits, (record) => record.sha);
}

async function seedGraphGeneration(
  kv: StateKV,
  payload: SnapshotPayload,
): Promise<void> {
  if (!payload.graphGeneration && !payload.graphResetAt) return;
  const seed: GraphSnapshot = {
    version: 1,
    topNodes: [],
    topEdges: [],
    topDegrees: {},
    stats: {
      totalNodes: 0,
      totalEdges: 0,
      nodesByType: {},
      edgesByType: {},
    },
    updatedAt: new Date(0).toISOString(),
    dirty: true,
    ...(payload.graphGeneration
      ? { graphGeneration: payload.graphGeneration }
      : {}),
    ...(payload.graphResetAt ? { resetAt: payload.graphResetAt } : {}),
  };
  await kv.set(KV.graphSnapshot, "current", seed);
}

function snapshotStats(payload: SnapshotPayload): SnapshotMeta["stats"] {
  return {
    sessions: payload.sessions.length,
    observations: Object.values(payload.observations).reduce(
      (sum, observations) => sum + observations.length,
      0,
    ),
    memories: payload.memories.length,
    graphNodes: payload.graphNodes?.length ?? 0,
    rawObservations: Object.values(payload.rawObservations).reduce(
      (sum, observations) => sum + observations.length,
      0,
    ),
    graphEdges: payload.graphEdges?.length ?? 0,
  };
}

export function registerSnapshotFunction(
  sdk: ISdk,
  kv: StateKV,
  snapshotDir: string,
): void {
  let snapshotInFlight = false;

  sdk.registerFunction("mem::snapshot-create", async (data?: { message?: string }) => {
    if (snapshotInFlight) {
      return { success: true, message: "Snapshot already in progress" };
    }
    snapshotInFlight = true;

    try {
      await ensureGitRepo(snapshotDir);
      const payload = await collectSnapshotPayload(kv);
      const envelope = snapshotEnvelope(payload);
      writeFileSync(
        join(snapshotDir, "state.json"),
        JSON.stringify(envelope, null, 2),
        "utf-8",
      );
      await gitExec(snapshotDir, ["add", "."]);

      const message = data?.message || `Snapshot ${envelope.createdAt}`;
      try {
        await gitExec(snapshotDir, ["commit", "-m", message]);
      } catch (commitError) {
        const error =
          commitError instanceof Error ? commitError.message : String(commitError);
        if (error.includes("nothing to commit")) {
          return { success: true, message: "No changes to snapshot" };
        }
        throw commitError;
      }

      const commitHash = await gitExec(snapshotDir, ["rev-parse", "HEAD"]);
      const meta: SnapshotMeta = {
        id: generateId("snap"),
        commitHash,
        createdAt: envelope.createdAt,
        message,
        stats: snapshotStats(payload),
      };
      await recordAudit(kv, "export", "mem::snapshot-create", [meta.id], {
        commitHash,
        stats: meta.stats,
        integrity: envelope.integrity,
      });
      logger.info("Snapshot created", { commitHash });
      return { success: true, snapshot: meta };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Snapshot failed", { error: message });
      return { success: false, error: message };
    } finally {
      snapshotInFlight = false;
    }
  });

  sdk.registerFunction("mem::snapshot-list", async () => {
    try {
      if (!existsSync(join(snapshotDir, ".git"))) return { snapshots: [] };
      const log = await gitExec(snapshotDir, [
        "log",
        "--format=%H|%aI|%s",
        "-20",
      ]);
      const snapshots = log
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parts = line.split("|");
          const [commitHash, createdAt] = parts;
          return {
            commitHash,
            createdAt,
            message: parts.slice(2).join("|"),
          };
        });
      return { snapshots };
    } catch {
      return { snapshots: [] };
    }
  });

  sdk.registerFunction(
    "mem::snapshot-restore",
    async (data: { commitHash: string } | undefined) => {
      if (!data || typeof data.commitHash !== "string" || !data.commitHash.trim()) {
        return { success: false, error: "commitHash is required" };
      }
      if (!COMMIT_HASH_RE.test(data.commitHash)) {
        return { success: false, error: "Invalid commitHash format" };
      }

      let targetModified = false;
      try {
        const content = await gitExec(snapshotDir, [
          "show",
          `${data.commitHash}:state.json`,
        ]);
        const envelope = parseSnapshotEnvelope(content);
        const nonEmptyScope = await findNonEmptyCanonicalScope(kv);
        if (nonEmptyScope) {
          return {
            success: false,
            error:
              `Snapshot restore requires an empty isolated target; ` +
              `${nonEmptyScope} is not empty`,
          };
        }

        targetModified = true;
        await restoreSnapshotPayload(kv, envelope.payload);
        await seedGraphGeneration(kv, envelope.payload);
        const graphResult = (await sdk.trigger({
          function_id: "mem::graph-snapshot-rebuild",
          payload: { force: true },
        })) as { success?: boolean; error?: string };
        if (graphResult?.success !== true) {
          throw new Error(graphResult?.error || "graph rebuild failed");
        }
        const indexResult = (await sdk.trigger({
          function_id: "mem::index-reconcile",
          payload: {},
        })) as { success?: boolean; error?: string };
        if (indexResult?.success !== true) {
          throw new Error(indexResult?.error || "index rebuild failed");
        }

        const verifiedPayload = await collectSnapshotPayload(kv);
        verifiedPayload.exportedAt = envelope.payload.exportedAt;
        if (!envelope.payload.projectionBacklogs.summary) {
          delete verifiedPayload.projectionBacklogs.summary;
        }
        if (digestPayload(verifiedPayload) !== envelope.integrity.digest) {
          throw new Error("restored canonical payload digest mismatch");
        }

        const stats = snapshotStats(envelope.payload);
        await recordAudit(kv, "import", "mem::snapshot-restore", [], {
          commitHash: data.commitHash,
          stats,
          verified: true,
        });
        logger.info("Snapshot restored", { commitHash: data.commitHash, stats });
        return {
          success: true,
          commitHash: data.commitHash,
          verified: true,
          stats,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Snapshot restore failed", { error: message });
        return {
          success: false,
          error: message,
          targetState: targetModified ? "discard_required" : "unchanged",
        };
      }
    },
  );
}
