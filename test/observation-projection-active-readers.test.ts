import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObservationProjection, RawObservation } from "../src/types.js";
import { KV } from "../src/state/schema.js";
import { ProjectionCoordinator } from "../src/functions/projection-coordinator.js";
import { rebuildActiveProjectionIndex } from "../src/functions/observation-projection-index.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The three hot-path readers of mem:obs:projections -- the drain refresh, the
// health reconcile every 30 s, and the retry scheduler -- must read the active
// index once it is built, never the full scope (58,651 rows / 12.8 MB live,
// crossing the engine as one message). Every writer must keep the index in
// step, or those readers miss work.

const SESSION = "ses_active_index";

function rawObservation(id: string, index: number): RawObservation {
  return {
    id,
    captureId: `cap_${id}`,
    sessionId: SESSION,
    agentId: "worker",
    hookType: "stop",
    timestamp: `2026-09-11T00:00:${String(index).padStart(2, "0")}.000Z`,
    data: { text: `observation ${index}` },
  } as unknown as RawObservation;
}

function projection(
  id: string,
  status: ObservationProjection["status"],
  index = 0,
  attempts = 0,
): ObservationProjection {
  return {
    observationId: id,
    captureId: `cap_${id}`,
    sessionId: SESSION,
    status,
    attempts,
    updatedAt: `2026-09-11T00:00:${String(index).padStart(2, "0")}.000Z`,
  };
}

function countingKV() {
  const kv = mockKV();
  const reads = { full: 0, active: 0 };
  const list = kv.list.bind(kv);
  kv.list = (async <T,>(scope: string): Promise<T[]> => {
    if (scope === KV.observationProjections) reads.full += 1;
    if (scope === KV.observationProjectionsActive) reads.active += 1;
    return list<T>(scope);
  }) as typeof kv.list;
  return { kv, reads };
}

function activeIds(kv: ReturnType<typeof mockKV>): string[] {
  const rows = kv.store.get(KV.observationProjectionsActive);
  if (!rows) return [];
  return Array.from(rows.values())
    .filter((row) => typeof (row as ObservationProjection).observationId === "string")
    .map((row) => (row as ObservationProjection).observationId)
    .sort();
}

function statusOf(kv: ReturnType<typeof mockKV>, id: string): string | undefined {
  return (kv.store.get(KV.observationProjections)?.get(id) as ObservationProjection | undefined)?.status;
}

describe("active index readers", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "true";
  });
  afterEach(() => {
    delete process.env["AGENTMEMORY_PROJECTION_RECOVERY_INTERVAL_MS"];
  });

  it("drain reads only the active index once built, and its writes keep the index in step", async () => {
    const { registerObservationProjectionFunction } = await import(
      "../src/functions/observation-projection.js"
    );
    const sdk = mockSdk({ looseTrigger: true });
    const { kv, reads } = countingKV();
    sdk.registerFunction("mem::compress", async () => ({ success: true }));
    sdk.registerFunction("mem::project-graph-sources", async () => ({ success: true }));

    for (let index = 0; index < 3; index += 1) {
      const id = `obs_${index}`;
      await kv.set(KV.rawObservations(SESSION), id, rawObservation(id, index));
      await kv.set(KV.observationProjections, id, projection(id, "pending", index));
    }
    await kv.set(KV.observationProjections, "obs_done", projection("obs_done", "succeeded", 9, 1));
    await rebuildActiveProjectionIndex(kv as never);
    expect(activeIds(kv)).toEqual(["obs_0", "obs_1", "obs_2"]);
    reads.full = 0;
    reads.active = 0;

    const recovery = registerObservationProjectionFunction(
      sdk as never,
      kv as never,
      undefined,
      undefined,
      undefined,
      new ProjectionCoordinator(),
    );
    const stop = recovery.startPacedRecovery({ intervalMs: 5 });
    try {
      await vi.waitFor(
        () => {
          expect(statusOf(kv, "obs_0")).toBe("succeeded");
          expect(statusOf(kv, "obs_1")).toBe("succeeded");
          expect(statusOf(kv, "obs_2")).toBe("succeeded");
        },
        { timeout: 5000 },
      );
    } finally {
      stop();
    }

    expect(reads.full).toBe(0);
    expect(reads.active).toBeGreaterThan(0);
    // Succeeded rows leave the index; the drain's own writes did that.
    expect(activeIds(kv)).toEqual([]);
  });

  it("reconcile reads the active index once built and reaches the same counts", async () => {
    const { reconcilePipelineMarkers } = await import("../src/health/pipeline.js");
    const { kv, reads } = countingKV();
    await kv.set(KV.observationProjections, "p", projection("p", "pending", 1));
    await kv.set(KV.observationProjections, "f", { ...projection("f", "failed", 2, 2), lastError: "boom" });
    await kv.set(KV.observationProjections, "s", projection("s", "succeeded", 3, 1));
    // A stale pending marker for a row that has since succeeded.
    await kv.set(KV.projectionPending("compression"), "s", { id: "s", updatedAt: "2026-09-11T00:00:03.000Z" });

    // First call: index not built yet, so the full scope is read exactly once.
    const first = await reconcilePipelineMarkers(kv as never);
    expect(first.compression).toEqual({ pending: 1, failed: 1 });
    expect(reads.full).toBe(1);

    reads.full = 0;
    reads.active = 0;
    const second = await reconcilePipelineMarkers(kv as never);
    expect(second.compression).toEqual({ pending: 1, failed: 1 });
    expect(reads.full).toBe(0);
    expect(reads.active).toBe(1);
    expect(kv.store.get(KV.projectionPending("compression"))?.has("s")).toBe(false);
    expect(kv.store.get(KV.projectionPending("compression"))?.has("p")).toBe(true);
    expect(kv.store.get(KV.projectionFailed("compression"))?.has("f")).toBe(true);
  });

  it("retry scheduler reads the active index and retries only what is in it", async () => {
    const { reconcilePipelineWork } = await import("../src/health/pipeline.js");
    const sdk = mockSdk({ looseTrigger: true });
    const { kv, reads } = countingKV();
    const retried: string[] = [];
    sdk.registerFunction("mem::project-observation", async (data: { observationId: string }) => {
      retried.push(data.observationId);
      return { success: true };
    });
    await kv.set(KV.observationProjections, "f", { ...projection("f", "failed", 1, 1), lastError: "boom" });
    await kv.set(KV.observationProjections, "s", projection("s", "succeeded", 2, 1));
    await rebuildActiveProjectionIndex(kv as never);
    reads.full = 0;
    reads.active = 0;

    await reconcilePipelineWork(sdk as never, kv as never, { automatic: false });

    expect(reads.full).toBe(0);
    expect(reads.active).toBeGreaterThan(0);
    expect(retried).toEqual(["f"]);
  });

  it("a fresh observation's pending projection lands in the active index", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const { registerObservationProjectionFunction } = await import(
      "../src/functions/observation-projection.js"
    );
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "false";
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerObservationProjectionFunction(
      sdk as never,
      kv as never,
      undefined,
      undefined,
      undefined,
      new ProjectionCoordinator(),
    );
    registerObserveFunction(sdk as never, kv as never);
    await rebuildActiveProjectionIndex(kv as never);

    const result = (await sdk.trigger("mem::observe", {
      captureId: "cap_fresh",
      agentId: "reviewer",
      sourceClient: "codex",
      sessionId: SESSION,
      project: "/home/user/agentmemory",
      projectName: "agentmemory",
      cwd: "/home/user/agentmemory",
      hookType: "subagent_stop",
      timestamp: "2026-09-11T00:00:00.000Z",
      data: { agent_id: "reviewer", agent_type: "reviewer", last_message: "Found graph race" },
    })) as { observationId: string };

    expect(statusOf(kv, result.observationId)).toBe("pending");
    expect(activeIds(kv)).toEqual([result.observationId]);
  });
});
