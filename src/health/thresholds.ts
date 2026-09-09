import type { HealthSnapshot } from "../types.js";

interface ThresholdConfig {
  eventLoopLagWarnMs: number;
  eventLoopLagCriticalMs: number;
  cpuWarnPercent: number;
  cpuCriticalPercent: number;
  memoryWarnPercent: number;
  memoryCriticalPercent: number;
  memoryRssFloorBytes: number;
  kvLatencyWarnMs: number;
  pipelineBacklogWarnMs: number;
  nowMs: number;
}

const DEFAULTS: ThresholdConfig = {
  eventLoopLagWarnMs: 100,
  eventLoopLagCriticalMs: 500,
  cpuWarnPercent: 80,
  cpuCriticalPercent: 90,
  memoryWarnPercent: 80,
  memoryCriticalPercent: 95,
  memoryRssFloorBytes: 512 * 1024 * 1024,
  kvLatencyWarnMs: 2000,
  pipelineBacklogWarnMs: 5 * 60 * 1000,
  nowMs: 0,
};

export function evaluateHealth(
  snapshot: HealthSnapshot,
  config: Partial<ThresholdConfig> = {},
): { status: "healthy" | "degraded" | "critical"; alerts: string[]; notes: string[] } {
  const cfg = { ...DEFAULTS, ...config };
  const alerts: string[] = [];
  const notes: string[] = [];
  let critical = false;
  let degraded = false;

  if (
    snapshot.connectionState === "disconnected" ||
    snapshot.connectionState === "failed"
  ) {
    alerts.push(`connection_${snapshot.connectionState}`);
    critical = true;
  } else if (snapshot.connectionState === "reconnecting") {
    alerts.push("connection_reconnecting");
    degraded = true;
  }

  if (snapshot.kvConnectivity?.status === "error") {
    alerts.push("kv_connectivity_error");
    critical = true;
  } else if (
    snapshot.kvConnectivity?.status === "ok" &&
    typeof snapshot.kvConnectivity.latencyMs === "number" &&
    snapshot.kvConnectivity.latencyMs > cfg.kvLatencyWarnMs
  ) {
    alerts.push(
      `kv_latency_warn_${Math.round(snapshot.kvConnectivity.latencyMs)}ms`,
    );
    degraded = true;
  }

  if (snapshot.eventLoopLagMs > cfg.eventLoopLagCriticalMs) {
    alerts.push(
      `event_loop_lag_critical_${Math.round(snapshot.eventLoopLagMs)}ms`,
    );
    critical = true;
  } else if (snapshot.eventLoopLagMs > cfg.eventLoopLagWarnMs) {
    alerts.push(`event_loop_lag_warn_${Math.round(snapshot.eventLoopLagMs)}ms`);
    degraded = true;
  }

  if (snapshot.cpu.percent > cfg.cpuCriticalPercent) {
    alerts.push(`cpu_critical_${Math.round(snapshot.cpu.percent)}%`);
    critical = true;
  } else if (snapshot.cpu.percent > cfg.cpuWarnPercent) {
    alerts.push(`cpu_warn_${Math.round(snapshot.cpu.percent)}%`);
    degraded = true;
  }

  // Against the V8 ceiling when the snapshot carries it: heapTotal is what V8
  // has grown to, kept deliberately close to heapUsed, so heapUsed/heapTotal
  // alarms on ordinary operation. #158 papered over that with an RSS floor,
  // which only defers the false alarm until RSS crosses it -- the live worker
  // then reported memory_critical_98%_rss564mb while using 7.8% of its limit.
  const memDenominator =
    snapshot.memory.heapLimit && snapshot.memory.heapLimit > 0
      ? snapshot.memory.heapLimit
      : snapshot.memory.heapTotal;
  const memPercent =
    memDenominator > 0 ? (snapshot.memory.heapUsed / memDenominator) * 100 : 0;
  const rss = snapshot.memory.rss ?? 0;
  const rssAboveFloor = rss >= cfg.memoryRssFloorBytes;
  const memMb = Math.round(rss / (1024 * 1024));
  if (memPercent > cfg.memoryCriticalPercent && rssAboveFloor) {
    alerts.push(`memory_critical_${Math.round(memPercent)}%_rss${memMb}mb`);
    critical = true;
  } else if (memPercent > cfg.memoryWarnPercent && rssAboveFloor) {
    alerts.push(`memory_warn_${Math.round(memPercent)}%_rss${memMb}mb`);
    degraded = true;
  } else if (memPercent > cfg.memoryWarnPercent) {
    notes.push(`memory_heap_tight_${Math.round(memPercent)}%_rss${memMb}mb`);
  }

  const pipeline = snapshot.pipeline;
  if (pipeline) {
    for (const stage of ["compression", "summary", "graph"] as const) {
      const backlog = pipeline[stage];
      if (backlog.failed > 0) {
        alerts.push(`${stage}_projection_failed_${backlog.failed}`);
        degraded = true;
      }
      if (
        typeof backlog.oldestPendingAgeMs === "number" &&
        backlog.oldestPendingAgeMs > cfg.pipelineBacklogWarnMs
      ) {
        alerts.push(`${stage}_backlog_stale`);
        degraded = true;
      }
    }
    if (pipeline.graphSnapshot.dirty) {
      alerts.push("graph_snapshot_dirty");
      degraded = true;
    }
    const nowMs = cfg.nowMs > 0 ? cfg.nowMs : Date.now();
    const dirtySince = pipeline.index.dirtySince
      ? Date.parse(pipeline.index.dirtySince)
      : Number.NaN;
    if (
      pipeline.index.dirty &&
      Number.isFinite(dirtySince) &&
      nowMs - dirtySince > cfg.pipelineBacklogWarnMs
    ) {
      alerts.push("index_snapshot_stale");
      degraded = true;
    }
    // lastFailureAt is a high-water mark, so testing it against `dirty` alone
    // re-raises a days-old failure on every later dirty window. Alarm only when
    // the failure is the most recent outcome: no success since, or none ever.
    const lastIndexFailure = Date.parse(pipeline.index.lastFailureAt ?? "");
    const lastIndexSuccess = Date.parse(pipeline.index.lastSuccessAt ?? "");
    const failureIsCurrent =
      Number.isFinite(lastIndexFailure) &&
      (!Number.isFinite(lastIndexSuccess) ||
        lastIndexFailure > lastIndexSuccess);
    if (failureIsCurrent && pipeline.index.dirty) {
      alerts.push("index_snapshot_failed");
      degraded = true;
    }
  }

  const status = critical ? "critical" : degraded ? "degraded" : "healthy";
  return { status, alerts, notes };
}
