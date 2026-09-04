import { describe, expect, it, vi } from "vitest";
import type { HealthSnapshot, IndexPersistenceStatus } from "../src/types.js";
import { KV } from "../src/state/schema.js";
import { evaluateHealth } from "../src/health/thresholds.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { mockKV } from "./helpers/mocks.js";
import { mockSdk } from "./helpers/mocks.js";
import { ProjectionCoordinator } from "../src/functions/projection-coordinator.js";

function baseHealth(): HealthSnapshot {
  return {
    connectionState: "connected",
    workers: [],
    memory: { heapUsed: 1, heapTotal: 10, rss: 1, external: 0 },
    cpu: { userMicros: 0, systemMicros: 0, percent: 0 },
    eventLoopLagMs: 0,
    uptimeSeconds: 1,
    kvConnectivity: { status: "ok" },
    status: "healthy",
    alerts: [],
  };
}

describe("pipeline health markers", () => {
  it("reports coordinator stage timing without exposing source identifiers", async () => {
    const { collectPipelineHealth } = await import(
      "../src/health/pipeline.js"
    );
    const kv = mockKV();
    const coordinator = new ProjectionCoordinator();
    let release!: () => void;
    const active = coordinator.run(
      { stage: "compression", sourceId: "private-observation-id" },
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    coordinator.request("summary", vi.fn());

    const pipeline = await collectPipelineHealth(kv as never, null, coordinator);

    expect(pipeline.projectionCoordinator).toEqual({
      activeStage: "compression",
      activeSince: expect.any(String),
      deferredStages: ["summary"],
    });
    expect(JSON.stringify(pipeline)).not.toContain("private-observation-id");
    const health = baseHealth();
    health.pipeline = pipeline;
    expect(evaluateHealth(health).status).toBe("healthy");

    release();
    await active;
  });

  it("moves a projection through pending, failed, retry, and succeeded", async () => {
    const {
      collectPipelineHealth,
      markProjectionFailed,
      markProjectionPending,
      markProjectionSucceeded,
    } = await import("../src/health/pipeline.js");
    const kv = mockKV();
    const old = new Date(Date.now() - 6 * 60 * 1000).toISOString();

    await markProjectionPending(kv as never, "compression", "obs-1", old);
    let status = await collectPipelineHealth(kv as never, null);
    expect(status.compression).toMatchObject({
      pending: 1,
      failed: 0,
      oldestPendingAgeMs: expect.any(Number),
    });

    await markProjectionFailed(
      kv as never,
      "compression",
      "obs-1",
      "compression_failed",
    );
    status = await collectPipelineHealth(kv as never, null);
    expect(status.compression).toMatchObject({ pending: 0, failed: 1 });

    await markProjectionPending(kv as never, "compression", "obs-1", old);
    status = await collectPipelineHealth(kv as never, null);
    expect(status.compression).toMatchObject({ pending: 1, failed: 0 });

    await markProjectionSucceeded(kv as never, "compression", "obs-1");
    status = await collectPipelineHealth(kv as never, null);
    expect(status.compression).toMatchObject({ pending: 0, failed: 0 });
  });

  it("does not rewrite unchanged canonical projection markers", async () => {
    const { reconcilePipelineMarkers } = await import(
      "../src/health/pipeline.js"
    );
    const kv = mockKV();
    await kv.set(KV.graphProjections, "memory:succeeded", {
      sourceKind: "memory",
      sourceId: "succeeded",
      projectId: "project-1",
      visibility: "project",
      status: "succeeded",
      attempts: 1,
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
    await kv.set(KV.graphProjections, "memory:pending", {
      sourceKind: "memory",
      sourceId: "pending",
      projectId: "project-1",
      visibility: "project",
      status: "pending",
      attempts: 1,
      updatedAt: "2026-08-28T00:01:00.000Z",
    });
    await kv.set(KV.graphProjections, "memory:failed", {
      sourceKind: "memory",
      sourceId: "failed",
      projectId: "project-1",
      visibility: "project",
      status: "failed",
      attempts: 1,
      updatedAt: "2026-08-28T00:02:00.000Z",
      lastError: "provider_unavailable",
    });

    await reconcilePipelineMarkers(kv as never);
    const set = vi.spyOn(kv, "set");
    const remove = vi.spyOn(kv, "delete");

    await reconcilePipelineMarkers(kv as never);

    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("degrades health for failed and stale summary projections", async () => {
    const {
      collectPipelineHealth,
      markProjectionFailed,
      markProjectionPending,
    } = await import("../src/health/pipeline.js");
    const kv = mockKV();
    const old = new Date(Date.now() - 6 * 60 * 1000).toISOString();

    await markProjectionFailed(
      kv as never,
      "summary" as never,
      "ses-failed",
      "summary_failed",
    );
    await markProjectionPending(
      kv as never,
      "summary" as never,
      "ses-pending",
      old,
    );

    const pipeline = await collectPipelineHealth(kv as never, null);
    expect((pipeline as { summary?: unknown }).summary).toMatchObject({
      pending: 1,
      failed: 1,
      oldestPendingAgeMs: expect.any(Number),
    });

    const health = baseHealth();
    health.pipeline = pipeline;
    const evaluated = evaluateHealth(health, {
      pipelineBacklogWarnMs: 300_000,
    });
    expect(evaluated.status).toBe("degraded");
    expect(evaluated.alerts).toEqual(
      expect.arrayContaining([
        "summary_projection_failed_1",
        "summary_backlog_stale",
      ]),
    );
  });

  it("exposes graph dirty state and persisted index snapshot status", async () => {
    const { collectPipelineHealth } = await import(
      "../src/health/pipeline.js"
    );
    const kv = mockKV();
    await kv.set(KV.graphSnapshot, "current", {
      version: 1,
      topNodes: [],
      topEdges: [],
      topDegrees: {},
      stats: { totalNodes: 1, totalEdges: 0, nodesByType: {}, edgesByType: {} },
      updatedAt: "2026-08-28T00:00:00.000Z",
      dirty: true,
    });
    const index: IndexPersistenceStatus = {
      dirty: true,
      dirtySince: "2026-08-28T00:00:00.000Z",
      lastFailureAt: "2026-08-28T00:01:00.000Z",
      lastError: "index_save_failed",
    };

    const status = await collectPipelineHealth(kv as never, index);

    expect(status.graphSnapshot).toMatchObject({ present: true, dirty: true });
    expect(status.index).toEqual(index);
  });

  it("degrades on failed or stale work and recovers when queues clear", async () => {
    const unhealthy = baseHealth();
    unhealthy.pipeline = {
      collectedAt: new Date().toISOString(),
      compression: { pending: 1, failed: 1, oldestPendingAgeMs: 360_000 },
      summary: { pending: 0, failed: 0 },
      graph: { pending: 0, failed: 0 },
      graphSnapshot: { present: true, dirty: true },
      index: { dirty: true, dirtySince: "2026-08-28T00:00:00.000Z" },
    };

    const degraded = evaluateHealth(unhealthy, {
      pipelineBacklogWarnMs: 300_000,
      nowMs: Date.parse("2026-08-28T00:10:00.000Z"),
    });
    expect(degraded.status).toBe("degraded");
    expect(degraded.alerts).toEqual(
      expect.arrayContaining([
        "compression_projection_failed_1",
        "compression_backlog_stale",
        "graph_snapshot_dirty",
        "index_snapshot_stale",
      ]),
    );

    const recovered = baseHealth();
    recovered.pipeline = {
      collectedAt: new Date().toISOString(),
      compression: { pending: 0, failed: 0 },
      summary: { pending: 0, failed: 0 },
      graph: { pending: 0, failed: 0 },
      graphSnapshot: { present: true, dirty: false },
      index: {
        dirty: false,
        lastSuccessAt: "2026-08-28T00:10:00.000Z",
      },
    };
    expect(evaluateHealth(recovered).status).toBe("healthy");
  });

  it("reports pipeline backlog through mem::diagnose", async () => {
    const { markProjectionFailed } = await import(
      "../src/health/pipeline.js"
    );
    const { registerDiagnosticsFunction } = await import(
      "../src/functions/diagnostics.js"
    );
    const kv = mockKV();
    const sdk = mockSdk();
    await markProjectionFailed(
      kv as never,
      "graph",
      "memory:mem-1",
      "graph_projection_failed",
    );
    registerDiagnosticsFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::diagnose", {
      categories: ["pipeline"],
    })) as {
      checks: Array<{ name: string; status: string }>;
      summary: { fail: number };
    };

    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "graph-projection-failed",
          status: "fail",
        }),
      ]),
    );
    expect(result.summary.fail).toBeGreaterThan(0);
  });

  it("reports failed summary projections through mem::diagnose", async () => {
    const { markProjectionFailed } = await import(
      "../src/health/pipeline.js"
    );
    const { registerDiagnosticsFunction } = await import(
      "../src/functions/diagnostics.js"
    );
    const kv = mockKV();
    const sdk = mockSdk();
    await markProjectionFailed(
      kv as never,
      "summary" as never,
      "ses-failed",
      "summary_projection_failed",
    );
    registerDiagnosticsFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::diagnose", {
      categories: ["pipeline"],
    })) as {
      checks: Array<{ name: string; status: string }>;
    };

    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "summary-projection-failed",
          status: "fail",
        }),
      ]),
    );
  });

  it("retries canonical projection backlog before reporting recovery", async () => {
    const {
      markProjectionSucceeded,
    } = await import("../src/health/pipeline.js");
    const { registerDiagnosticsFunction } = await import(
      "../src/functions/diagnostics.js"
    );
    const kv = mockKV();
    const sdk = mockSdk();
    const compressionRetry = vi.fn(async (data: unknown) => {
      const request = data as { observationId: string };
      const projection = await kv.get<Record<string, unknown>>(
        KV.observationProjections,
        request.observationId,
      );
      await kv.set(KV.observationProjections, request.observationId, {
        ...projection,
        status: "succeeded",
        updatedAt: "2026-08-28T00:01:00.000Z",
      });
      await markProjectionSucceeded(
        kv as never,
        "compression",
        request.observationId,
      );
      return { success: true };
    });
    const graphRetry = vi.fn(async (data: unknown) => {
      const request = data as {
        sources: Array<{ sourceKind: string; sourceId: string }>;
      };
      for (const source of request.sources) {
        const key = `${source.sourceKind}:${source.sourceId}`;
        const projection = await kv.get<Record<string, unknown>>(
          KV.graphProjections,
          key,
        );
        await kv.set(KV.graphProjections, key, {
          ...projection,
          status: "succeeded",
          updatedAt: "2026-08-28T00:01:00.000Z",
        });
        await markProjectionSucceeded(kv as never, "graph", key);
      }
      return { success: true };
    });

    await kv.set(KV.observationProjections, "obs-pending", {
      observationId: "obs-pending",
      captureId: "capture-pending",
      sessionId: "ses-pending",
      status: "pending",
      attempts: 0,
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
    await kv.set(KV.graphProjections, "memory:mem-running", {
      sourceKind: "memory",
      sourceId: "mem-running",
      projectId: "project-1",
      visibility: "project",
      status: "running",
      attempts: 1,
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
    sdk.registerFunction("mem::project-observation", compressionRetry);
    sdk.registerFunction("mem::project-graph-sources", graphRetry);
    registerDiagnosticsFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::pipeline-reconcile", {})) as {
      success: boolean;
      attempted: { compression: number; graph: number };
      compression: { pending: number; failed: number };
      graph: { pending: number; failed: number };
    };

    expect(compressionRetry).toHaveBeenCalledWith({
      observationId: "obs-pending",
      sessionId: "ses-pending",
    });
    expect(graphRetry).toHaveBeenCalledWith({
      sources: [{ sourceKind: "memory", sourceId: "mem-running" }],
    });
    expect(result).toMatchObject({
      success: true,
      attempted: { compression: 1, graph: 1 },
      compression: { pending: 0, failed: 0 },
      graph: { pending: 0, failed: 0 },
    });
  });

  it("rebuilds legacy backlog markers without falsely reporting recovery", async () => {
    const { registerDiagnosticsFunction } = await import(
      "../src/functions/diagnostics.js"
    );
    const kv = mockKV();
    const sdk = mockSdk();
    await kv.set(KV.observationProjections, "obs-legacy", {
      observationId: "obs-legacy",
      captureId: "capture-legacy",
      sessionId: "ses-legacy",
      status: "failed",
      attempts: 1,
      updatedAt: "2026-08-28T00:00:00.000Z",
      lastError: "legacy_failure",
    });
    registerDiagnosticsFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::pipeline-reconcile", {})) as {
      success: boolean;
      attempted: { compression: number };
      compression: { failed: number };
    };

    expect(result).toMatchObject({
      success: false,
      attempted: { compression: 1 },
      compression: { failed: 1 },
    });
    expect(await kv.list(KV.projectionFailed("compression"))).toHaveLength(1);
  });

  it("returns a server error when the pipeline backlog remains unresolved", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, kv as never);
    sdk.registerFunction("mem::pipeline-reconcile", async () => ({
      success: false,
      attempted: { compression: 1, graph: 0 },
      compression: { pending: 1, failed: 0 },
      graph: { pending: 0, failed: 0 },
    }));

    const response = (await sdk.trigger("api::pipeline-reconcile", {
      body: {},
    })) as { status_code: number; body: { success: boolean } };

    expect(response.status_code).toBe(500);
    expect(response.body.success).toBe(false);
  });

  it("runs automatic backlog recovery on a bounded interval", async () => {
    vi.useFakeTimers();
    try {
      const { startPipelineReconcileLoop } = await import(
        "../src/health/pipeline.js"
      );
      const sdk = mockSdk();
      const reconcile = vi.fn(async () => ({ success: true }));
      sdk.registerFunction("mem::pipeline-reconcile", reconcile);

      const loop = startPipelineReconcileLoop(sdk as never, 60_000);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledWith({ automatic: true });
      loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps each automatic recovery tick at one compression and one graph source", async () => {
    const { reconcilePipelineWork } = await import(
      "../src/health/pipeline.js"
    );
    const kv = mockKV();
    const sdk = mockSdk();
    const compressionRetry = vi.fn(async () => ({ success: true }));
    const graphRetry = vi.fn(async () => ({ success: true }));
    sdk.registerFunction("mem::project-observation", compressionRetry);
    sdk.registerFunction("mem::project-graph-sources", graphRetry);
    const updatedAt = "2026-08-28T00:00:00.000Z";

    for (let index = 0; index < 3; index++) {
      await kv.set(KV.observationProjections, `obs-${index}`, {
        observationId: `obs-${index}`,
        captureId: `capture-${index}`,
        sessionId: `ses-${index}`,
        status: "failed",
        attempts: 1,
        updatedAt,
        lastError: "provider_unavailable",
      });
      await kv.set(KV.graphProjections, `memory:mem-${index}`, {
        sourceKind: "memory",
        sourceId: `mem-${index}`,
        projectId: "project-1",
        visibility: "project",
        status: "failed",
        attempts: 1,
        updatedAt,
        lastError: "provider_unavailable",
      });
    }

    const result = await reconcilePipelineWork(sdk as never, kv as never, {
      automatic: true,
      now: Date.parse(updatedAt) + 60_000,
    });

    expect(result.attempted).toEqual({
      compression: 1,
      summary: 0,
      graph: 1,
      maintenance: 0,
    });
    expect(compressionRetry).toHaveBeenCalledTimes(1);
    expect(compressionRetry).toHaveBeenCalledWith({
      observationId: "obs-0",
      sessionId: "ses-0",
    });
    expect(graphRetry).toHaveBeenCalledTimes(1);
    expect(graphRetry).toHaveBeenCalledWith({
      sources: [{ sourceKind: "memory", sourceId: "mem-0" }],
    });
  });

  it("caps manual zero-LLM recovery before the HTTP invocation timeout", async () => {
    const { reconcilePipelineWork } = await import(
      "../src/health/pipeline.js"
    );
    const kv = mockKV();
    const sdk = mockSdk();
    const compressionRetry = vi.fn(async () => ({ success: true }));
    sdk.registerFunction("mem::project-observation", compressionRetry);

    for (let index = 0; index < 3; index++) {
      await kv.set(KV.observationProjections, `manual-obs-${index}`, {
        observationId: `manual-obs-${index}`,
        captureId: `manual-capture-${index}`,
        sessionId: `manual-session-${index}`,
        status: "failed",
        attempts: 1,
        updatedAt: "2026-08-28T00:00:00.000Z",
        lastError: "historical_provider_failure",
      });
    }

    const result = await reconcilePipelineWork(sdk as never, kv as never);

    expect(result.attempted).toMatchObject({ compression: 1 });
    expect(compressionRetry).toHaveBeenCalledTimes(1);
    expect(compressionRetry).toHaveBeenCalledWith({
      observationId: "manual-obs-0",
      sessionId: "manual-session-0",
    });
  });

  it("spends one global provider slot on summary before semantic graph", async () => {
    const { reconcilePipelineWork } = await import(
      "../src/health/pipeline.js"
    );
    const kv = mockKV();
    const sdk = mockSdk();
    const updatedAt = "2026-08-28T00:00:00.000Z";
    const now = Date.parse(updatedAt) + 60_000;
    const summaryRetry = vi.fn(async (data: unknown) => {
      const request = data as { sessionId: string };
      const projection = await kv.get<Record<string, unknown>>(
        KV.sessionProjections,
        request.sessionId,
      );
      await kv.set(KV.sessionProjections, request.sessionId, {
        ...projection,
        status: "succeeded",
        updatedAt: new Date(now).toISOString(),
      });
      return { success: true };
    });
    const graphRetry = vi.fn(async (data: unknown) => {
      const request = data as {
        sources: Array<{ sourceKind: string; sourceId: string }>;
      };
      for (const source of request.sources) {
        const key = `${source.sourceKind}:${source.sourceId}`;
        const projection = await kv.get<Record<string, unknown>>(
          KV.graphProjections,
          key,
        );
        await kv.set(KV.graphProjections, key, {
          ...projection,
          status: "succeeded",
          updatedAt: new Date(now).toISOString(),
        });
      }
      return { success: true };
    });
    sdk.registerFunction("mem::project-session", summaryRetry);
    sdk.registerFunction("mem::project-graph-sources", graphRetry);
    await kv.set(KV.sessionProjections, "ses-due", {
      sessionId: "ses-due",
      status: "failed",
      attempts: 1,
      observationCount: 1,
      updatedAt,
      lastError: "provider_unavailable",
    });
    await kv.set(KV.graphProjections, "summary:ses-other", {
      sourceKind: "summary",
      sourceId: "ses-other",
      sessionId: "ses-other",
      projectId: "project-1",
      visibility: "project",
      status: "failed",
      attempts: 1,
      requestedExtractionLevel: "semantic",
      updatedAt,
      lastError: "provider_unavailable",
    });

    const first = await reconcilePipelineWork(sdk as never, kv as never, {
      automatic: true,
      now,
    });
    expect(first.attempted).toEqual({
      compression: 0,
      summary: 1,
      graph: 0,
      maintenance: 0,
    });
    expect(summaryRetry).toHaveBeenCalledTimes(1);
    expect(graphRetry).not.toHaveBeenCalled();

    const second = await reconcilePipelineWork(sdk as never, kv as never, {
      automatic: true,
      now: now + 60_000,
    });
    expect(second.attempted).toEqual({
      compression: 0,
      summary: 0,
      graph: 1,
      maintenance: 0,
    });
    expect(graphRetry).toHaveBeenCalledTimes(1);
    expect(graphRetry).toHaveBeenCalledWith({
      mode: "semantic",
      sources: [
        {
          sourceKind: "summary",
          sourceId: "ses-other",
          sessionId: "ses-other",
        },
      ],
    });
  });

  it("spends the provider slot on summary before durable maintenance", async () => {
    const { reconcilePipelineWork } = await import(
      "../src/health/pipeline.js"
    );
    const kv = mockKV();
    const sdk = mockSdk();
    const updatedAt = "2026-08-28T00:00:00.000Z";
    const now = Date.parse(updatedAt) + 60_000;
    const summaryRetry = vi.fn(async (data: unknown) => {
      const request = data as { sessionId: string };
      const projection = await kv.get<Record<string, unknown>>(
        KV.sessionProjections,
        request.sessionId,
      );
      await kv.set(KV.sessionProjections, request.sessionId, {
        ...projection,
        status: "succeeded",
        updatedAt: new Date(now).toISOString(),
      });
      return { success: true };
    });
    const maintenanceRetry = vi.fn(async () => {
      const projection = await kv.get<Record<string, unknown>>(
        "mem:maintenance:projections",
        "global",
      );
      await kv.set("mem:maintenance:projections", "global", {
        ...projection,
        status: "succeeded",
        processedGeneration: 1,
        updatedAt: new Date(now + 60_000).toISOString(),
      });
      return { success: true };
    });
    sdk.registerFunction("mem::project-session", summaryRetry);
    sdk.registerFunction("mem::project-maintenance", maintenanceRetry);
    await kv.set(KV.sessionProjections, "ses-priority", {
      sessionId: "ses-priority",
      status: "failed",
      attempts: 1,
      observationCount: 1,
      updatedAt,
      lastError: "provider_unavailable",
    });
    await kv.set("mem:maintenance:projections", "global", {
      id: "global",
      status: "pending",
      requestedGeneration: 1,
      processedGeneration: 0,
      stage: "semantic",
      attempts: 0,
      requestedAt: updatedAt,
      updatedAt,
    });

    const first = (await reconcilePipelineWork(
      sdk as never,
      kv as never,
      { automatic: true, now },
    )) as { attempted: { summary: number; maintenance: number } };
    expect(first.attempted).toMatchObject({ summary: 1, maintenance: 0 });
    expect(summaryRetry).toHaveBeenCalledTimes(1);
    expect(maintenanceRetry).not.toHaveBeenCalled();

    const second = (await reconcilePipelineWork(
      sdk as never,
      kv as never,
      { automatic: true, now: now + 60_000 },
    )) as { attempted: { summary: number; maintenance: number } };
    expect(second.attempted).toMatchObject({ summary: 0, maintenance: 1 });
    expect(maintenanceRetry).toHaveBeenCalledTimes(1);
  });

  it("allows zero-LLM synthetic compression beside one summary retry", async () => {
    vi.stubEnv("AGENTMEMORY_AUTO_COMPRESS", "false");
    try {
      const { reconcilePipelineWork } = await import(
        "../src/health/pipeline.js"
      );
      const kv = mockKV();
      const sdk = mockSdk();
      const updatedAt = "2026-08-28T00:00:00.000Z";
      const now = Date.parse(updatedAt) + 60_000;
      const compressionRetry = vi.fn(async (data: unknown) => {
        const request = data as { observationId: string };
        const projection = await kv.get<Record<string, unknown>>(
          KV.observationProjections,
          request.observationId,
        );
        await kv.set(KV.observationProjections, request.observationId, {
          ...projection,
          status: "succeeded",
          updatedAt: new Date(now).toISOString(),
        });
        return { success: true };
      });
      const summaryRetry = vi.fn(async (data: unknown) => {
        const request = data as { sessionId: string };
        const projection = await kv.get<Record<string, unknown>>(
          KV.sessionProjections,
          request.sessionId,
        );
        await kv.set(KV.sessionProjections, request.sessionId, {
          ...projection,
          status: "succeeded",
          updatedAt: new Date(now).toISOString(),
        });
        return { success: true };
      });
      sdk.registerFunction("mem::project-observation", compressionRetry);
      sdk.registerFunction("mem::project-session", summaryRetry);
      await kv.set(KV.observationProjections, "obs-due", {
        observationId: "obs-due",
        captureId: "cap-due",
        sessionId: "ses-due",
        status: "failed",
        attempts: 1,
        updatedAt,
        lastError: "provider_unavailable",
      });
      await kv.set(KV.sessionProjections, "ses-due", {
        sessionId: "ses-due",
        status: "failed",
        attempts: 1,
        observationCount: 1,
        updatedAt,
        lastError: "provider_unavailable",
      });

      const result = await reconcilePipelineWork(sdk as never, kv as never, {
        automatic: true,
        now,
      });

      expect(result.attempted).toEqual({
        compression: 1,
        summary: 1,
        graph: 0,
        maintenance: 0,
      });
      expect(compressionRetry).toHaveBeenCalledTimes(1);
      expect(summaryRetry).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("waits for the retry delay before automatically replaying fresh work", async () => {
    const { reconcilePipelineWork } = await import(
      "../src/health/pipeline.js"
    );
    const kv = mockKV();
    const sdk = mockSdk();
    const updatedAt = "2026-08-28T00:00:00.000Z";
    const base = Date.parse(updatedAt);
    const retry = vi.fn(async (data: unknown) => {
      const request = data as { observationId: string };
      const projection = await kv.get<Record<string, unknown>>(
        KV.observationProjections,
        request.observationId,
      );
      await kv.set(KV.observationProjections, request.observationId, {
        ...projection,
        status: "succeeded",
        updatedAt: new Date(base + 30_000).toISOString(),
      });
      return { success: true };
    });
    sdk.registerFunction("mem::project-observation", retry);
    sdk.registerFunction("mem::project-graph-sources", async () => ({
      success: true,
    }));
    await kv.set(KV.observationProjections, "obs-fresh", {
      observationId: "obs-fresh",
      captureId: "capture-fresh",
      sessionId: "ses-fresh",
      status: "pending",
      attempts: 0,
      updatedAt,
    });

    const early = await reconcilePipelineWork(sdk as never, kv as never, {
      automatic: true,
      now: base + 29_999,
    });
    expect(early).toMatchObject({
      success: false,
      attempted: { compression: 0 },
      compression: { pending: 1 },
    });
    expect(retry).not.toHaveBeenCalled();

    const due = await reconcilePipelineWork(sdk as never, kv as never, {
      automatic: true,
      now: base + 30_000,
    });
    expect(due).toMatchObject({
      success: true,
      attempted: { compression: 1 },
      compression: { pending: 0, failed: 0 },
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
