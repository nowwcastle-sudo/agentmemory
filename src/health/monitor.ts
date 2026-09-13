import type { ISdk } from "../iii-compat.js";
import { availableParallelism } from "node:os";
import v8 from "node:v8";
import type { HealthSnapshot } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { getKvListStats } from "../state/kv-list-stats.js";
import { evaluateHealth } from "./thresholds.js";
import { collectPipelineHealth } from "./pipeline.js";
import { getIndexPersistenceStatus } from "../functions/search.js";
import {
  defaultConnectorOutboxes,
  inspectConnectorOutboxes,
  type ConnectorOutbox,
} from "../functions/connector-outbox.js";
import type { ProjectionCoordinator } from "../functions/projection-coordinator.js";

export function registerHealthMonitor(
  sdk: ISdk,
  kv: StateKV,
  connectorOutboxes: ConnectorOutbox[] = defaultConnectorOutboxes(),
  coordinator?: ProjectionCoordinator,
): { stop: () => void } {
  let connectionState = "connected";
  let prevCpuUsage = process.cpuUsage();
  let prevCpuTime = Date.now();
  let collecting = false;
  let stopped = false;

  if (typeof sdk.on === "function") {
    sdk.on("connection_state", (state?: unknown) => {
      connectionState = state as string;
    });
  }

  async function collectHealth(): Promise<HealthSnapshot> {
    const mem = process.memoryUsage();
    const currentCpu = process.cpuUsage();
    const now = Date.now();
    const uptime = process.uptime();

    const elapsedMs = now - prevCpuTime;
    const userDelta = currentCpu.user - prevCpuUsage.user;
    const systemDelta = currentCpu.system - prevCpuUsage.system;
    const cpuPercent =
      elapsedMs > 0
        ? (((userDelta + systemDelta) / 1000 / elapsedMs) * 100) /
          availableParallelism()
        : 0;
    prevCpuUsage = currentCpu;
    prevCpuTime = now;

    const startMark = performance.now();
    await new Promise((resolve) => setImmediate(resolve));
    const eventLoopLagMs = performance.now() - startMark;

    let workers: HealthSnapshot["workers"] = [];
    try {
      const result = await sdk.trigger<
        unknown,
        { workers?: HealthSnapshot["workers"] }
      >({ function_id: "engine::workers::list", payload: {} });
      if (result?.workers) workers = result.workers;
    } catch {}

    const KV_PROBE_TIMEOUT = 5000;
    let kvConnectivity: { status: string; latencyMs?: number; error?: string };
    const kvStart = performance.now();
    try {
      await Promise.race([
        (async () => {
          await kv.set(KV.health, "_probe", { ts: Date.now() });
          await kv.get(KV.health, "_probe");
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), KV_PROBE_TIMEOUT),
        ),
      ]);
      kvConnectivity = { status: "ok", latencyMs: Math.round((performance.now() - kvStart) * 100) / 100 };
    } catch {
      kvConnectivity = { status: "error", error: "kv_probe_failed", latencyMs: Math.round((performance.now() - kvStart) * 100) / 100 };
    }

    const snapshot: HealthSnapshot = {
      connectionState,
      workers,
      memory: {
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        rss: mem.rss,
        external: mem.external,
        heapLimit: v8.getHeapStatistics().heap_size_limit,
      },
      cpu: {
        userMicros: currentCpu.user,
        systemMicros: currentCpu.system,
        percent: Math.round(cpuPercent * 100) / 100,
      },
      eventLoopLagMs,
      uptimeSeconds: uptime,
      kvConnectivity,
      kvLists: getKvListStats(20),
      status: "healthy",
      alerts: [],
    };

    snapshot.pipeline = await collectPipelineHealth(
      kv,
      getIndexPersistenceStatus() ?? undefined,
      coordinator,
    );
    snapshot.connectorOutbox = await inspectConnectorOutboxes(
      connectorOutboxes,
    );

    const evaluated = evaluateHealth(snapshot);
    snapshot.status = evaluated.status;
    snapshot.alerts = evaluated.alerts;
    snapshot.notes = evaluated.notes;

    await kv.set(KV.health, "latest", snapshot).catch(() => {});
    return snapshot;
  }

  const collectOnce = (): void => {
    if (stopped || collecting) return;
    collecting = true;
    collectHealth()
      .catch(() => {})
      .finally(() => {
        collecting = false;
      });
  };

  collectOnce();
  const interval = setInterval(collectOnce, 30_000);
  interval.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
  };
}

export async function getLatestHealth(
  kv: StateKV,
): Promise<HealthSnapshot | null> {
  return kv.get<HealthSnapshot>(KV.health, "latest");
}
