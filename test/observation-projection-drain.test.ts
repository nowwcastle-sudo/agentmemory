import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObservationProjection, RawObservation } from "../src/types.js";
import { KV } from "../src/state/schema.js";
import { ProjectionCoordinator } from "../src/functions/projection-coordinator.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SESSION = "ses_drain_backlog";

function rawObservation(id: string, index: number): RawObservation {
  return {
    id,
    captureId: `capture-${id}`,
    sessionId: SESSION,
    timestamp: `2026-09-04T00:00:${String(index).padStart(2, "0")}.000Z`,
    hookType: "conversation",
    raw: { prompt: `backlog item ${index}` },
  } satisfies RawObservation;
}

function pendingProjection(id: string, index: number): ObservationProjection {
  return {
    observationId: id,
    captureId: `capture-${id}`,
    sessionId: SESSION,
    status: "pending",
    attempts: 0,
    updatedAt: `2026-09-04T00:00:${String(index).padStart(2, "0")}.000Z`,
  } satisfies ObservationProjection;
}

/** Seeds observations that were queued but never projected — a real backlog. */
async function seedBacklog(
  kv: ReturnType<typeof mockKV>,
  count: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `obs_backlog_${index}`;
    ids.push(id);
    await kv.set(KV.rawObservations(SESSION), id, rawObservation(id, index));
    await kv.set(KV.observationProjections, id, pendingProjection(id, index));
  }
  return ids;
}

async function registerPipeline(
  sdk: ReturnType<typeof mockSdk>,
  kv: ReturnType<typeof mockKV>,
) {
  const { registerObservationProjectionFunction } = await import(
    "../src/functions/observation-projection.js"
  );
  return registerObservationProjectionFunction(
    sdk as never,
    kv as never,
    undefined,
    undefined,
    new ProjectionCoordinator(),
  );
}

function stubProjectionWork(sdk: ReturnType<typeof mockSdk>) {
  sdk.registerFunction("mem::compress", async () => ({ success: true }));
  sdk.registerFunction("mem::project-graph-sources", async () => ({
    success: true,
  }));
}

/**
 * Reads the backing store directly. Polling through `kv.list` would land in the
 * same counter the batching test asserts on.
 */
function succeededCount(kv: ReturnType<typeof mockKV>): number {
  const rows = kv.store.get(KV.observationProjections);
  if (!rows) return 0;
  return Array.from(rows.values()).filter(
    (row) => (row as ObservationProjection).status === "succeeded",
  ).length;
}

describe("observation projection backlog recovery", () => {
  beforeEach(() => {
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "true";
  });

  afterEach(() => {
    delete process.env["AGENTMEMORY_PROJECTION_RECOVERY_INTERVAL_MS"];
  });

  it("keeps startup recovery capped at one projection", async () => {
    // Guards the existing liveness contract: registering the pipeline must not
    // start draining a backlog on its own.
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const recovery = await registerPipeline(sdk, kv);
    stubProjectionWork(sdk);
    await seedBacklog(kv, 3);

    recovery.startRecovery();
    await vi.waitFor(() => expect(succeededCount(kv)).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(succeededCount(kv)).toBe(1);
  });

  it("drains a backlog once paced recovery is running", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const recovery = await registerPipeline(sdk, kv);
    stubProjectionWork(sdk);
    await seedBacklog(kv, 5);

    // Paced recovery hands the drain one credit per tick, so a backlog clears
    // without ever holding more than one worker slot.
    const stop = recovery.startPacedRecovery({ intervalMs: 5 });
    try {
      await vi.waitFor(() => expect(succeededCount(kv)).toBe(5), {
        timeout: 5000,
      });
    } finally {
      stop();
    }
    expect(await kv.list(KV.projectionPending("compression"))).toHaveLength(0);
  });

  it("stops re-scanning the projection scope once the backlog is empty", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    // The drain reads the active index, not the full projection scope.
    let projectionListReads = 0;
    const list = kv.list.bind(kv);
    kv.list = (async <T,>(scope: string): Promise<T[]> => {
      if (scope === KV.observationProjectionsActive) projectionListReads += 1;
      return list<T>(scope);
    }) as typeof kv.list;

    const recovery = await registerPipeline(sdk, kv);
    stubProjectionWork(sdk);
    await seedBacklog(kv, 2);

    const stop = recovery.startPacedRecovery({ intervalMs: 5 });
    try {
      await vi.waitFor(() => expect(succeededCount(kv)).toBe(2), {
        timeout: 5000,
      });
      // One empty scan arms the cooldown; further ticks must not re-scan.
      await vi.waitFor(() => expect(projectionListReads).toBeGreaterThan(1));
      const settled = projectionListReads;
      await new Promise((resolve) => setTimeout(resolve, 60)); // ≥ 10 ticks
      expect(projectionListReads).toBe(settled);
    } finally {
      stop();
    }
  });

  it("reports the interval the drain actually uses: 2 s by default, 0 when disabled", async () => {
    const { configuredRecoveryIntervalMs } = await import(
      "../src/functions/observation-projection.js"
    );
    delete process.env["AGENTMEMORY_PROJECTION_RECOVERY_INTERVAL_MS"];
    expect(configuredRecoveryIntervalMs()).toBe(2_000);
    process.env["AGENTMEMORY_PROJECTION_RECOVERY_INTERVAL_MS"] = "0";
    expect(configuredRecoveryIntervalMs()).toBe(0);
    process.env["AGENTMEMORY_PROJECTION_RECOVERY_INTERVAL_MS"] = "junk";
    expect(configuredRecoveryIntervalMs()).toBe(2_000);
  });

  it("treats an interval of 0 as disabled", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const recovery = await registerPipeline(sdk, kv);
    stubProjectionWork(sdk);
    await seedBacklog(kv, 2);

    const stop = recovery.startPacedRecovery({ intervalMs: 0 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(succeededCount(kv)).toBe(0);
    } finally {
      stop();
    }
  });

  it("reads the projection list once per batch rather than once per item", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    let projectionListReads = 0;
    let fullScopeReads = 0;
    const list = kv.list.bind(kv);
    kv.list = (async <T,>(scope: string): Promise<T[]> => {
      if (scope === KV.observationProjectionsActive) projectionListReads += 1;
      if (scope === KV.observationProjections) fullScopeReads += 1;
      return list<T>(scope);
    }) as typeof kv.list;

    const recovery = await registerPipeline(sdk, kv);
    stubProjectionWork(sdk);
    await seedBacklog(kv, 6);

    const stop = recovery.startPacedRecovery({ intervalMs: 5 });
    try {
      await vi.waitFor(() => expect(succeededCount(kv)).toBe(6), {
        timeout: 5000,
      });
    } finally {
      stop();
    }

    // Six items must not cost six full scans of the projection scope: that
    // O(n^2) is what stalls a large backlog.
    expect(projectionListReads).toBeLessThanOrEqual(3);
    // The full scope is read once, to build the index, and never again.
    expect(fullScopeReads).toBeLessThanOrEqual(1);
  });
  it("drains the backlog with as many projections in flight as the coordinator admits", async () => {
    process.env["AGENTMEMORY_PROJECTION_RECOVERY_INTERVAL_MS"] = "5";
    const kv = mockKV();
    const sdk = mockSdk({ looseTrigger: true });
    await seedBacklog(kv, 12);

    let inFlight = 0;
    let peakInFlight = 0;
    const releases: Array<() => void> = [];
    sdk.registerFunction("mem::compress", async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
        // Let every admitted projection reach this point before any returns.
        if (releases.length >= 4) for (const release of releases.splice(0)) release();
      });
      inFlight -= 1;
      return { success: true };
    });
    sdk.registerFunction("mem::project-graph-sources", async () => ({
      success: true,
    }));

    const recovery = await registerPipeline(sdk, kv);
    const stopPacer = recovery.startPacedRecovery({ intervalMs: 50 });
    const deadline = Date.now() + 4000;
    while (peakInFlight < 4 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    stopPacer();
    for (const release of releases.splice(0)) release();

    // One at a time was the old ceiling: the coordinator admits six, so the
    // drain has to ask for more than one.
    expect(peakInFlight).toBeGreaterThan(1);
  });
  it("tops the drain up while it is still running instead of waiting for it to finish", async () => {
    const kv = mockKV();
    const sdk = mockSdk({ looseTrigger: true });
    await seedBacklog(kv, 20);

    const started: string[] = [];
    let blockForever!: () => void;
    sdk.registerFunction("mem::compress", async (data: unknown) => {
      const request = data as { observationId: string };
      started.push(request.observationId);
      // The first admitted projection never settles, so the drain pass never
      // ends. A pacer that only mints while idle would stop here forever.
      if (started.length === 1) {
        await new Promise<void>((resolve) => {
          blockForever = resolve;
        });
      }
      return { success: true };
    });
    sdk.registerFunction("mem::project-graph-sources", async () => ({
      success: true,
    }));

    const recovery = await registerPipeline(sdk, kv);
    const stopPacer = recovery.startPacedRecovery({ intervalMs: 50 });
    try {
      const deadline = Date.now() + 5000;
      while (started.length < 20 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(started.length).toBe(20);
    } finally {
      stopPacer();
      blockForever?.();
    }
  });
});
