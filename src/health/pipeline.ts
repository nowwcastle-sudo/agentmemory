import type {
  GraphProjection,
  GraphSnapshot,
  IndexPersistenceStatus,
  MaintenanceProjection,
  PipelineHealth,
  ProjectionBacklog,
  ProjectionPipelineStage,
  SessionProjection,
} from "../types.js";
import type { ISdk } from "../iii-compat.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { listActiveProjections } from "../functions/observation-projection-index.js";
import { listActiveGraphProjections } from "../functions/graph-projection-index.js";
import { isAutoCompressEnabled } from "../config.js";
import type { ProjectionCoordinator } from "../functions/projection-coordinator.js";

type ProjectionMarker = {
  id: string;
  stage: ProjectionPipelineStage;
  since: string;
  updatedAt: string;
  lastError?: string;
};

export async function markProjectionPending(
  kv: StateKV,
  stage: ProjectionPipelineStage,
  id: string,
  since = new Date().toISOString(),
): Promise<void> {
  const existing = await kv
    .get<ProjectionMarker>(KV.projectionPending(stage), id)
    .catch(() => null);
  const now = new Date().toISOString();
  await kv.set(KV.projectionPending(stage), id, {
    id,
    stage,
    since: existing?.since ?? since,
    updatedAt: now,
  } satisfies ProjectionMarker);
  await kv.delete(KV.projectionFailed(stage), id).catch(() => {});
}

export async function markProjectionFailed(
  kv: StateKV,
  stage: ProjectionPipelineStage,
  id: string,
  lastError: string,
): Promise<void> {
  const pending = await kv
    .get<ProjectionMarker>(KV.projectionPending(stage), id)
    .catch(() => null);
  const now = new Date().toISOString();
  await kv.set(KV.projectionFailed(stage), id, {
    id,
    stage,
    since: pending?.since ?? now,
    updatedAt: now,
    lastError,
  } satisfies ProjectionMarker);
  await kv.delete(KV.projectionPending(stage), id).catch(() => {});
}

export async function markProjectionSucceeded(
  kv: StateKV,
  stage: ProjectionPipelineStage,
  id: string,
): Promise<void> {
  await kv.delete(KV.projectionPending(stage), id).catch(() => {});
  await kv.delete(KV.projectionFailed(stage), id).catch(() => {});
}

function oldestAge(markers: ProjectionMarker[], now: number): number | undefined {
  let oldest = Number.POSITIVE_INFINITY;
  for (const marker of markers) {
    const timestamp = Date.parse(marker.since);
    if (Number.isFinite(timestamp)) oldest = Math.min(oldest, timestamp);
  }
  return Number.isFinite(oldest) ? Math.max(0, now - oldest) : undefined;
}

async function collectBacklog(
  kv: StateKV,
  stage: ProjectionPipelineStage,
  now: number,
): Promise<ProjectionBacklog> {
  const [pending, failed] = await Promise.all([
    kv.list<ProjectionMarker>(KV.projectionPending(stage)).catch(() => []),
    kv.list<ProjectionMarker>(KV.projectionFailed(stage)).catch(() => []),
  ]);
  const oldestPendingAgeMs = oldestAge(pending, now);
  const oldestFailedAgeMs = oldestAge(failed, now);
  return {
    pending: pending.length,
    failed: failed.length,
    ...(oldestPendingAgeMs === undefined ? {} : { oldestPendingAgeMs }),
    ...(oldestFailedAgeMs === undefined ? {} : { oldestFailedAgeMs }),
  };
}

export async function collectPipelineHealth(
  kv: StateKV,
  liveIndexStatus?: IndexPersistenceStatus | null,
  coordinator?: ProjectionCoordinator,
): Promise<PipelineHealth> {
  const now = Date.now();
  const [compression, summary, graph, snapshot, persistedIndex] = await Promise.all([
    collectBacklog(kv, "compression", now),
    collectBacklog(kv, "summary", now),
    collectBacklog(kv, "graph", now),
    kv.get<GraphSnapshot>(KV.graphSnapshot, "current").catch(() => null),
    liveIndexStatus === undefined
      ? kv
          .get<IndexPersistenceStatus>(KV.indexStatus, "current")
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  const index = liveIndexStatus ?? persistedIndex ?? { dirty: false };
  return {
    collectedAt: new Date(now).toISOString(),
    compression,
    summary,
    graph,
    graphSnapshot: {
      present: Boolean(snapshot),
      dirty: snapshot?.dirty === true,
      ...(snapshot?.updatedAt ? { updatedAt: snapshot.updatedAt } : {}),
    },
    index,
    ...(coordinator
      ? { projectionCoordinator: coordinator.status() }
      : {}),
  };
}

export async function reconcilePipelineMarkers(
  kv: StateKV,
): Promise<{
  compression: { pending: number; failed: number };
  summary: { pending: number; failed: number };
  graph: { pending: number; failed: number };
}> {
  const [observations, sessions, graphs] = await Promise.all([
    // Only non-succeeded rows; a succeeded row's stale marker is removed by
    // the "not known" branch below, the same outcome as before.
    listActiveProjections(kv),
    kv.list<SessionProjection>(KV.sessionProjections),
    // Non-succeeded rows only: the full scope is 130k rows / 46.6 MB live.
    listActiveGraphProjections(kv),
  ]);

  const reconcileStage = async (
    stage: ProjectionPipelineStage,
    states: Array<{
      id: string;
      status: "pending" | "running" | "succeeded" | "failed";
      updatedAt: string;
      lastError?: string;
    }>,
  ): Promise<{ pending: number; failed: number }> => {
    const known = new Set(states.map((state) => state.id));
    const [pendingMarkers, failedMarkers] = await Promise.all([
      kv.list<ProjectionMarker>(KV.projectionPending(stage)).catch(() => []),
      kv.list<ProjectionMarker>(KV.projectionFailed(stage)).catch(() => []),
    ]);
    const pendingById = new Map(
      pendingMarkers.map((marker) => [marker.id, marker]),
    );
    const failedById = new Map(
      failedMarkers.map((marker) => [marker.id, marker]),
    );
    for (const marker of pendingMarkers) {
      if (!known.has(marker.id)) {
        await kv.delete(KV.projectionPending(stage), marker.id).catch(() => {});
      }
    }
    for (const marker of failedMarkers) {
      if (!known.has(marker.id)) {
        await kv.delete(KV.projectionFailed(stage), marker.id).catch(() => {});
      }
    }

    let pending = 0;
    let failed = 0;
    for (const state of states) {
      if (state.status === "succeeded") {
        if (pendingById.has(state.id)) {
          await kv.delete(KV.projectionPending(stage), state.id).catch(() => {});
        }
        if (failedById.has(state.id)) {
          await kv.delete(KV.projectionFailed(stage), state.id).catch(() => {});
        }
      } else if (state.status === "failed") {
        const lastError = state.lastError ?? `${stage}_projection_failed`;
        const marker = failedById.get(state.id);
        if (
          pendingById.has(state.id) ||
          !marker ||
          marker.lastError !== lastError
        ) {
          await markProjectionFailed(kv, stage, state.id, lastError);
        }
        failed += 1;
      } else {
        if (failedById.has(state.id) || !pendingById.has(state.id)) {
          await markProjectionPending(kv, stage, state.id, state.updatedAt);
        }
        pending += 1;
      }
    }
    return { pending, failed };
  };

  const [compression, summary, graph] = await Promise.all([
    reconcileStage(
      "compression",
      observations.map((projection) => ({
        id: projection.observationId,
        status: projection.status,
        updatedAt: projection.updatedAt,
        lastError: projection.lastError,
      })),
    ),
    reconcileStage(
      "summary",
      sessions.map((projection) => ({
        id: projection.sessionId,
        status: projection.status,
        updatedAt: projection.updatedAt,
        lastError: projection.lastError,
      })),
    ),
    reconcileStage(
      "graph",
      graphs.map((projection) => ({
        id: `${projection.sourceKind}:${projection.sourceId}`,
        status: projection.status,
        updatedAt: projection.updatedAt,
        lastError: projection.lastError,
      })),
    ),
  ]);
  return { compression, summary, graph };
}

const AUTOMATIC_RETRY_BASE_MS = 30_000;
const AUTOMATIC_RETRY_MAX_MS = 5 * 60_000;
const AUTOMATIC_RETRY_BATCH_SIZE = 1;
/**
 * Automatic retries stop here. Live store 2026-09-11: two compression
 * projections at 433 and 180 attempts, each retry a 180 s state::set timeout,
 * retried every five minutes -- a coordinator slot held by a doomed call
 * most of the time. A manual reconcile (automatic: false) still retries them.
 */
export const AUTOMATIC_RETRY_MAX_ATTEMPTS = 25;

function isRetryDue(
  state: {
    status: "pending" | "running" | "succeeded" | "failed";
    attempts: number;
    updatedAt: string;
  },
  automatic: boolean,
  now: number,
): boolean {
  if (state.status === "succeeded") return false;
  if (!automatic) return true;
  if (state.attempts >= AUTOMATIC_RETRY_MAX_ATTEMPTS) return false;

  const updatedAt = Date.parse(state.updatedAt);
  if (!Number.isFinite(updatedAt)) return true;
  const delay =
    state.status === "failed"
      ? Math.min(
          AUTOMATIC_RETRY_MAX_MS,
          AUTOMATIC_RETRY_BASE_MS * 2 ** Math.min(Math.max(state.attempts - 1, 0), 4),
        )
      : AUTOMATIC_RETRY_BASE_MS;
  return now - updatedAt >= delay;
}

export async function reconcilePipelineWork(
  sdk: ISdk,
  kv: StateKV,
  options: { automatic?: boolean; now?: number } = {},
): Promise<{
  success: boolean;
  attempted: {
    compression: number;
    summary: number;
    graph: number;
    maintenance: number;
  };
  compression: { pending: number; failed: number };
  summary: { pending: number; failed: number };
  graph: { pending: number; failed: number };
}> {
  return withKeyedLock("pipeline-reconcile", async () => {
    const automatic = options.automatic === true;
    const now = options.now ?? Date.now();
    const observations = await listActiveProjections(kv);
    const dueCompression = observations.filter((projection) =>
      isRetryDue(projection, automatic, now),
    );
    const autoCompress = isAutoCompressEnabled();
    const compression = dueCompression.slice(0, AUTOMATIC_RETRY_BATCH_SIZE);

    for (const projection of compression) {
      await sdk
        .trigger({
          function_id: "mem::project-observation",
          payload: {
            observationId: projection.observationId,
            sessionId: projection.sessionId,
          },
        })
        .catch(() => {});
    }

    let providerWorkRemaining =
      autoCompress && compression.length > 0 ? 0 : 1;
    const sessionStates = await kv.list<SessionProjection>(
      KV.sessionProjections,
    );
    const dueSummary = sessionStates.filter((projection) =>
      isRetryDue(projection, automatic, now),
    );
    const summary =
      providerWorkRemaining > 0
        ? dueSummary.slice(0, AUTOMATIC_RETRY_BATCH_SIZE)
        : [];
    for (const projection of summary) {
      await sdk
        .trigger({
          function_id: "mem::project-session",
          payload: { sessionId: projection.sessionId },
        })
        .catch(() => {});
    }
    if (summary.length > 0) providerWorkRemaining = 0;

    const graphStates = await listActiveGraphProjections(kv);
    const dueGraph = graphStates.filter((projection) =>
      isRetryDue(projection, automatic, now),
    );
    const graph: GraphProjection[] = [];
    for (const projection of dueGraph) {
      const providerBearing =
        projection.requestedExtractionLevel !== "structural";
      if (providerBearing && providerWorkRemaining === 0) continue;
      graph.push(projection);
      if (providerBearing) providerWorkRemaining = 0;
      if (automatic && graph.length >= AUTOMATIC_RETRY_BATCH_SIZE) break;
    }

    const graphGroups = new Map<
      "configured" | "structural" | "semantic",
      GraphProjection[]
    >();
    for (const projection of graph) {
      const mode = projection.requestedExtractionLevel ?? "configured";
      const group = graphGroups.get(mode) ?? [];
      group.push(projection);
      graphGroups.set(mode, group);
    }
    for (const [mode, projections] of graphGroups) {
      await sdk
        .trigger({
          function_id: "mem::project-graph-sources",
          payload: {
            ...(mode === "configured" ? {} : { mode }),
            sources: projections.map((projection) => ({
              sourceKind: projection.sourceKind,
              sourceId: projection.sourceId,
              ...(projection.sessionId
                ? { sessionId: projection.sessionId }
                : {}),
            })),
          },
        })
        .catch(() => {});
    }

    const maintenanceStates = await kv.list<MaintenanceProjection>(
      KV.maintenanceProjections,
    );
    const dueMaintenance = maintenanceStates.filter((projection) =>
      isRetryDue(projection, automatic, now),
    );
    const maintenance =
      providerWorkRemaining > 0
        ? dueMaintenance.slice(0, AUTOMATIC_RETRY_BATCH_SIZE)
        : [];
    for (const projection of maintenance) {
      await sdk
        .trigger({
          function_id: "mem::project-maintenance",
          payload: { projectionId: projection.id },
        })
        .catch(() => {});
    }

    const backlog = await reconcilePipelineMarkers(kv);
    const success =
      backlog.compression.pending === 0 &&
      backlog.compression.failed === 0 &&
      backlog.summary.pending === 0 &&
      backlog.summary.failed === 0 &&
      backlog.graph.pending === 0 &&
      backlog.graph.failed === 0;
    return {
      success,
      attempted: {
        compression: compression.length,
        summary: summary.length,
        graph: graph.length,
        maintenance: maintenance.length,
      },
      ...backlog,
    };
  });
}

export function startPipelineReconcileLoop(
  sdk: ISdk,
  intervalMs = 60_000,
): { stop: () => void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    sdk
      .trigger({
        function_id: "mem::pipeline-reconcile",
        payload: { automatic: true },
      })
      .catch(() => {})
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
