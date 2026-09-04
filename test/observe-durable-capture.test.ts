import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CompressedObservation,
  HookPayload,
  ObservationProjection,
  RawObservation,
  Session,
} from "../src/types.js";
import { KV } from "../src/state/schema.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { ProjectionCoordinator } from "../src/functions/projection-coordinator.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function payload(captureId: string): HookPayload {
  return {
    captureId,
    agentId: "reviewer",
    sourceClient: "codex",
    sessionId: "ses_durable_capture",
    project: "/home/user/agentmemory",
    projectName: "agentmemory",
    cwd: "/home/user/agentmemory",
    hookType: "subagent_stop",
    timestamp: "2026-08-28T00:00:00.000Z",
    data: {
      agent_id: "reviewer",
      agent_type: "reviewer",
      last_message: "Found graph race",
    },
  };
}

function failingDerivedKV() {
  const kv = mockKV();
  let failNextDerivedWrite = true;
  const set = kv.set.bind(kv);
  kv.set = async <T>(scope: string, key: string, data: T): Promise<T> => {
    if (
      failNextDerivedWrite &&
      scope === KV.observations("ses_durable_capture") &&
      typeof data === "object" &&
      data !== null &&
      typeof (data as Record<string, unknown>)["title"] === "string"
    ) {
      failNextDerivedWrite = false;
      throw new Error("injected derived write failure");
    }
    return set(scope, key, data);
  };
  return kv;
}

async function registerObservationPipeline(
  sdk: ReturnType<typeof mockSdk>,
  kv: ReturnType<typeof mockKV>,
): Promise<void> {
  const { registerObservationProjectionFunction } = await import(
    "../src/functions/observation-projection.js"
  );
  registerObservationProjectionFunction(
    sdk as never,
    kv as never,
    undefined,
    undefined,
    new ProjectionCoordinator(),
  );
}

describe("mem::observe durable capture", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "false";
  });

  it("stores sanitized raw data independently from the derived observation", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    await registerObservationPipeline(sdk, kv);
    registerObserveFunction(sdk as never, kv as never);

    const input = payload("capture-subagent-1");
    const result = (await sdk.trigger("mem::observe", input)) as {
      observationId: string;
      captureId: string;
    };

    const raw = await kv.get<RawObservation>(
      KV.rawObservations(input.sessionId),
      result.observationId,
    );
    await vi.waitFor(async () =>
      expect(
        await kv.get<CompressedObservation>(
          KV.observations(input.sessionId),
          result.observationId,
        ),
      ).toMatchObject({ type: "subagent" }),
    );
    const derived = await kv.get<CompressedObservation>(
      KV.observations(input.sessionId),
      result.observationId,
    );

    expect(raw?.raw).toEqual({
      agent_id: "reviewer",
      agent_type: "reviewer",
      last_message: "Found graph race",
    });
    expect(raw?.captureId).toBe("capture-subagent-1");
    expect(raw?.agentId).toBe("reviewer");
    expect(raw?.sourceClient).toBe("codex");
    expect(raw?.projectName).toBe("agentmemory");
    expect(derived?.type).toBe("subagent");
    expect(derived?.sourceClient).toBe("codex");
    expect(derived?.projectName).toBe("agentmemory");
    expect(await kv.get<Session>(KV.sessions, input.sessionId)).toMatchObject({
      project: "/home/user/agentmemory",
      projectName: "agentmemory",
      sourceClient: "codex",
    });
  });

  it("publishes new projections to one of two durable queue lanes", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const calls: Array<Record<string, unknown>> = [];
    const trigger = sdk.trigger.bind(sdk);
    sdk.trigger = vi.fn(async (request: unknown, data?: unknown) => {
      if (
        typeof request === "object" &&
        request !== null &&
        (request as { function_id?: string }).function_id ===
          "iii::durable::publish"
      ) {
        calls.push(request as Record<string, unknown>);
        return { messageReceiptId: "queued" };
      }
      return trigger(request as never, data);
    }) as never;
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", payload("capture-queued-projection"));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      function_id: "iii::durable::publish",
      payload: {
        topic: expect.stringMatching(/^agentmemory\.observation\.projection\.[01]$/),
        data: {
          observationId: expect.any(String),
          sessionId: "ses_durable_capture",
        },
      },
    });
    expect(calls[0]).toHaveProperty("action");
  });

  it("acknowledges durable raw capture without waiting for projection dispatch", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const trigger = sdk.trigger.bind(sdk);
    let releasePublish!: () => void;
    sdk.trigger = vi.fn(async (request: unknown, data?: unknown) => {
      if (
        typeof request === "object" &&
        request !== null &&
        (request as { function_id?: string }).function_id ===
          "iii::durable::publish"
      ) {
        await new Promise<void>((resolve) => {
          releasePublish = resolve;
        });
        return { messageReceiptId: "queued" };
      }
      return trigger(request as never, data);
    }) as never;
    registerObserveFunction(sdk as never, kv as never);

    let settled = false;
    const observation = sdk
      .trigger("mem::observe", payload("capture-slow-dispatch"))
      .then((result) => {
        settled = true;
        return result as { observationId: string };
      });

    await vi.waitFor(() => expect(releasePublish).toBeTypeOf("function"));
    await Promise.resolve();
    expect(settled).toBe(true);
    const result = await observation;
    expect(
      await kv.get(
        KV.rawObservations("ses_durable_capture"),
        result.observationId,
      ),
    ).toBeTruthy();
    const projection = await kv.get<ObservationProjection>(
      KV.observationProjections,
      result.observationId,
    );
    expect(projection).toBeTruthy();
    expect(projection?.status).not.toBe("failed");

    releasePublish();
  });

  it("acknowledges durable raw capture without waiting for live stream publication", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const trigger = sdk.trigger.bind(sdk);
    const releaseStreams: Array<() => void> = [];
    sdk.trigger = vi.fn(async (request: unknown, data?: unknown) => {
      const functionId =
        typeof request === "object" && request !== null
          ? String((request as { function_id?: string }).function_id)
          : "";
      const requestPayload =
        typeof request === "object" && request !== null
          ? (request as { payload?: Record<string, unknown> }).payload
          : undefined;
      const streamData = requestPayload?.data as
        | Record<string, unknown>
        | undefined;
      const isRawStreamPublication =
        (functionId === "stream::set" && streamData?.type === "raw") ||
        (functionId === "stream::send" &&
          requestPayload?.type === "raw_observation");
      if (
        isRawStreamPublication
      ) {
        await new Promise<void>((resolve) => {
          releaseStreams.push(resolve);
        });
        return { success: true };
      }
      return trigger(request as never, data);
    }) as never;
    registerObserveFunction(sdk as never, kv as never);

    let settled = false;
    const observation = sdk
      .trigger("mem::observe", payload("capture-slow-live-stream"))
      .then((result) => {
        settled = true;
        return result as { observationId: string };
      });

    try {
      await vi.waitFor(() => expect(releaseStreams).toHaveLength(2));
      await Promise.resolve();
      expect(settled).toBe(true);
      const result = await observation;
      expect(
        await kv.get(
          KV.rawObservations("ses_durable_capture"),
          result.observationId,
        ),
      ).toBeTruthy();
      expect(
        await kv.get<ObservationProjection>(
          KV.observationProjections,
          result.observationId,
        ),
      ).toBeTruthy();
    } finally {
      for (const release of releaseStreams) release();
    }
  });

  it("registers exactly two durable projection queue lanes", async () => {
    const { registerObservationProjectionFunction } = await import(
      "../src/functions/observation-projection.js"
    );
    const sdk = mockSdk({ looseTrigger: true });
    registerObservationProjectionFunction(sdk as never, mockKV() as never);

    expect(sdk.registerTrigger).toHaveBeenCalledTimes(2);
    expect(sdk.registerTrigger.mock.calls.map(([trigger]) => trigger)).toEqual([
      {
        type: "durable:subscriber",
        function_id: "mem::queue-observation-projection",
        config: {
          topic: "agentmemory.observation.projection.0",
          queue_config: {
            type: "fifo",
            maxRetries: 10,
            backoffDelayMs: 1000,
          },
        },
      },
      {
        type: "durable:subscriber",
        function_id: "mem::queue-observation-projection",
        config: {
          topic: "agentmemory.observation.projection.1",
          queue_config: {
            type: "fifo",
            maxRetries: 10,
            backoffDelayMs: 1000,
          },
        },
      },
    ]);
  });

  it("acknowledges an eight-observation burst before draining projections one at a time", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "true";
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    await registerObservationPipeline(sdk, kv);
    registerObserveFunction(sdk as never, kv as never);
    let inFlight = 0;
    let maxInFlight = 0;
    const started: string[] = [];
    const releases: Array<() => void> = [];
    sdk.registerFunction("mem::compress", async (data: unknown) => {
      const request = data as { observationId: string };
      started.push(request.observationId);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => {
        releases.push(() => {
          inFlight -= 1;
          resolve();
        });
      });
      return { success: true };
    });
    sdk.registerFunction("mem::project-graph-sources", async () => ({
      success: true,
    }));

    const acknowledgements = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        sdk.trigger(
          "mem::observe",
          payload(`capture-burst-${index + 1}`),
        ),
      ),
    );

    try {
      await vi.waitFor(() => expect(started.length).toBeGreaterThan(0));
      expect(acknowledgements).toHaveLength(8);
      expect(
        await kv.list(KV.rawObservations("ses_durable_capture")),
      ).toHaveLength(8);
      expect(started).toHaveLength(1);
      expect(maxInFlight).toBe(1);

      for (let completed = 1; completed <= 8; completed += 1) {
        await vi.waitFor(() => expect(releases).toHaveLength(1));
        releases.shift()!();
        await vi.waitFor(async () =>
          expect(
            (
              await kv.list<ObservationProjection>(
                KV.observationProjections,
              )
            ).filter((projection) => projection.status === "succeeded"),
          ).toHaveLength(completed),
        );
      }
    } finally {
      for (const release of releases.splice(0)) release();
    }

    expect(started).toHaveLength(8);
    expect(maxInFlight).toBe(1);
    expect(
      await kv.list(KV.projectionPending("compression")),
    ).toHaveLength(0);
    expect(
      await kv.list(KV.projectionFailed("compression")),
    ).toHaveLength(0);
  });

  it("composes observation projection cores without crossing iii internal function IDs", async () => {
    const { registerObservationProjectionFunction } = await import(
      "../src/functions/observation-projection.js"
    );
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const sessionId = "ses_projection_depth";
    const observationId = "obs_projection_depth";
    await kv.set(KV.sessions, sessionId, {
      id: sessionId,
      project: "agentmemory",
      cwd: "/work/agentmemory",
      startedAt: "2026-08-31T00:00:00.000Z",
      status: "active",
      observationCount: 1,
    } satisfies Session);
    await kv.set(KV.rawObservations(sessionId), observationId, {
      id: observationId,
      captureId: "capture-projection-depth",
      sessionId,
      timestamp: "2026-08-31T00:00:01.000Z",
      hookType: "conversation",
      raw: { prompt: "connect this observation" },
    } satisfies RawObservation);
    await kv.set(KV.observationProjections, observationId, {
      observationId,
      captureId: "capture-projection-depth",
      sessionId,
      status: "pending",
      attempts: 0,
      updatedAt: "2026-08-31T00:00:01.000Z",
    } satisfies ObservationProjection);

    let graphExtractions = 0;
    const triggeredIds: string[] = [];
    const trigger = sdk.trigger.bind(sdk);
    sdk.trigger = vi.fn(async (request: unknown, data?: unknown) => {
      const functionId =
        typeof request === "string"
          ? request
          : (request as { function_id?: string })?.function_id;
      if (functionId) triggeredIds.push(functionId);
      return trigger(request as never, data);
    }) as never;
    const compressCore = vi.fn(async () => {
      throw new Error("LLM compression must stay disabled in this fixture");
    });
    const projectGraphSourcesCore = vi.fn(async () => {
      graphExtractions += 1;
      return { success: true, sourcesProjected: 1 };
    });
    const recovery = registerObservationProjectionFunction(
      sdk as never,
      kv as never,
      compressCore,
      projectGraphSourcesCore,
      new ProjectionCoordinator(),
    );
    recovery.startRecovery();

    await vi.waitFor(async () =>
      expect(
        await kv.get<ObservationProjection>(
          KV.observationProjections,
          observationId,
        ),
      ).toMatchObject({ status: "succeeded" }),
    );

    expect(graphExtractions).toBe(1);
    expect(compressCore).not.toHaveBeenCalled();
    expect(triggeredIds).not.toContain("mem::compress");
    expect(triggeredIds).not.toContain("mem::project-graph-sources");
    expect(triggeredIds).not.toContain("mem::graph-extract");
  });

  it("caps startup recovery to one historical projection so liveness keeps a worker slot", async () => {
    const { registerObservationProjectionFunction } = await import(
      "../src/functions/observation-projection.js"
    );
    const { registerGraphSourceProjectionFunction } = await import(
      "../src/functions/graph-source-projection.js"
    );
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const sessionId = "ses_bounded_startup_recovery";
    const observationIds = ["obs_startup_a", "obs_startup_b", "obs_startup_c"];
    await kv.set(KV.sessions, sessionId, {
      id: sessionId,
      project: "agentmemory",
      cwd: "/work/agentmemory",
      startedAt: "2026-08-31T00:00:00.000Z",
      status: "active",
      observationCount: observationIds.length,
    } satisfies Session);
    for (const [index, observationId] of observationIds.entries()) {
      await kv.set(KV.rawObservations(sessionId), observationId, {
        id: observationId,
        captureId: `capture-startup-${index}`,
        sessionId,
        timestamp: `2026-08-31T00:00:0${index + 1}.000Z`,
        hookType: "conversation",
        raw: { prompt: `bounded startup recovery ${index}` },
      } satisfies RawObservation);
      await kv.set(KV.observationProjections, observationId, {
        observationId,
        captureId: `capture-startup-${index}`,
        sessionId,
        status: "pending",
        attempts: 0,
        updatedAt: `2026-08-31T00:00:0${index + 1}.000Z`,
      } satisfies ObservationProjection);
    }
    sdk.registerFunction("mem::graph-extract", async () => ({
      success: true,
      nodesAdded: 1,
      edgesAdded: 0,
    }));
    registerGraphSourceProjectionFunction(sdk as never, kv as never);
    const recovery = registerObservationProjectionFunction(
      sdk as never,
      kv as never,
    );
    recovery.startRecovery();

    await vi.waitFor(async () =>
      expect(
        await kv.get<ObservationProjection>(
          KV.observationProjections,
          observationIds[0],
        ),
      ).toMatchObject({ status: "succeeded" }),
    );

    const statuses = await Promise.all(
      observationIds.map(async (observationId) =>
        (await kv.get<ObservationProjection>(
          KV.observationProjections,
          observationId,
        ))?.status,
      ),
    );
    expect(statuses).toEqual(["succeeded", "pending", "pending"]);
  });

  it("keeps a provider-capacity projection pending without spending an attempt", async () => {
    const { registerObservationProjectionFunction } = await import(
      "../src/functions/observation-projection.js"
    );
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "true";
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const sessionId = "ses_provider_capacity";
    const observationId = "obs_provider_capacity";
    await kv.set(KV.rawObservations(sessionId), observationId, {
      id: observationId,
      sessionId,
      timestamp: "2026-08-31T00:00:00.000Z",
      hookType: "conversation",
      raw: { prompt: "retain me" },
    } satisfies RawObservation);
    await kv.set(KV.observationProjections, observationId, {
      observationId,
      captureId: "capture-provider-capacity",
      sessionId,
      status: "pending",
      attempts: 0,
      updatedAt: "2026-08-31T00:00:00.000Z",
    } satisfies ObservationProjection);
    sdk.registerFunction("mem::compress", async () => ({
      success: false,
      error: "provider_capacity_timeout",
      retryable: true,
    }));
    registerObservationProjectionFunction(sdk as never, kv as never);

    const result = await sdk.trigger("mem::project-observation", {
      observationId,
      sessionId,
    });

    expect(result).toEqual({
      success: false,
      deferred: true,
      error: "provider_capacity_timeout",
    });
    expect(
      await kv.get<ObservationProjection>(
        KV.observationProjections,
        observationId,
      ),
    ).toMatchObject({ status: "pending", attempts: 0 });
    expect(await kv.list(KV.projectionPending("compression"))).toHaveLength(1);
    expect(await kv.list(KV.projectionFailed("compression"))).toHaveLength(0);
  });

  it("leaves a failed projection with the marker recovery owner when raw capture is replayed", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const { DedupMap } = await import("../src/functions/dedup.js");
    const sdk = mockSdk({ looseTrigger: true });
    const kv = failingDerivedKV();
    await registerObservationPipeline(sdk, kv as never);
    registerObserveFunction(sdk as never, kv as never, new DedupMap());

    const input = payload("capture-retry-1");
    const first = (await sdk.trigger("mem::observe", input)) as {
      observationId: string;
      captureId: string;
    };

    await vi.waitFor(async () =>
      expect(
        (
          await kv.get<ObservationProjection>(
            KV.observationProjections,
            first.observationId,
          )
        )?.status,
      ).toBe("failed"),
    );

    expect(first.observationId).toBeTruthy();
    expect(first.captureId).toBe("capture-retry-1");
    expect(await kv.list(KV.rawObservations(input.sessionId))).toHaveLength(1);
    expect(await kv.list(KV.observations(input.sessionId))).toHaveLength(0);
    expect(
      (
        await kv.get<ObservationProjection>(
          KV.observationProjections,
          first.observationId,
        )
      )?.status,
    ).toBe("failed");
    expect(
      await kv.list(KV.projectionFailed("compression")),
    ).toHaveLength(1);

    const second = (await sdk.trigger("mem::observe", input)) as {
      observationId: string;
      deduplicated?: boolean;
      requeued?: boolean;
    };
    expect(second.observationId).toBe(first.observationId);
    expect(second.deduplicated).toBe(true);
    expect(second.requeued).toBeUndefined();
    expect(
      (
        await kv.get<ObservationProjection>(
          KV.observationProjections,
          first.observationId,
        )
      )?.status,
    ).toBe("failed");
    expect(
      await kv.list(KV.projectionFailed("compression")),
    ).toHaveLength(1);

    await sdk.trigger("mem::queue-observation-projection", {
      observationId: first.observationId,
      sessionId: input.sessionId,
    });
    await vi.waitFor(async () =>
      expect(await kv.list(KV.observations(input.sessionId))).toHaveLength(1),
    );
    expect(await kv.list(KV.rawObservations(input.sessionId))).toHaveLength(1);
    expect(await kv.list(KV.observations(input.sessionId))).toHaveLength(1);
    expect(
      (
        await kv.get<Session>(KV.sessions, input.sessionId)
      )?.observationCount,
    ).toBe(1);
    expect(
      (
        await kv.get<ObservationProjection>(
          KV.observationProjections,
          first.observationId,
        )
      )?.attempts,
    ).toBe(2);
    expect(
      await kv.list(KV.projectionPending("compression")),
    ).toHaveLength(0);
    expect(
      await kv.list(KV.projectionFailed("compression")),
    ).toHaveLength(0);

    const third = (await sdk.trigger("mem::observe", input)) as {
      deduplicated?: boolean;
    };
    expect(third.deduplicated).toBe(true);
  });

  it("rebuilds a missing projection marker once and reports that recovery work was queued", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    await registerObservationPipeline(sdk, kv);
    registerObserveFunction(sdk as never, kv as never);
    const input = payload("capture-missing-projection");

    const first = (await sdk.trigger("mem::observe", input)) as {
      observationId: string;
    };
    await vi.waitFor(async () =>
      expect(
        (
          await kv.get<ObservationProjection>(
            KV.observationProjections,
            first.observationId,
          )
        )?.status,
      ).toBe("succeeded"),
    );
    await kv.delete(KV.observationProjections, first.observationId);

    const replay = (await sdk.trigger("mem::observe", input)) as {
      deduplicated?: boolean;
      projectionQueued?: boolean;
    };
    expect(replay).toMatchObject({
      deduplicated: true,
      projectionQueued: true,
    });
    expect(await kv.list(KV.rawObservations(input.sessionId))).toHaveLength(1);
  });

  it("requeues terminal projection after a late observation succeeds", async () => {
    const { registerObservationProjectionFunction } = await import(
      "../src/functions/observation-projection.js"
    );
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const graphRequests: Array<Record<string, unknown>> = [];
    const trigger = sdk.trigger.bind(sdk);
    sdk.trigger = vi.fn(async (request: unknown, data?: unknown) => {
      if (
        typeof request === "object" &&
        request !== null &&
        (request as { function_id?: string }).function_id ===
          "mem::project-graph-sources"
      ) {
        graphRequests.push(request as Record<string, unknown>);
      }
      return trigger(request as never, data);
    }) as never;
    const sessionId = "ses_late_projection";
    const observationId = "obs_late_projection";
    await kv.set(KV.sessions, sessionId, {
      id: sessionId,
      project: "agentmemory",
      cwd: "/work/agentmemory",
      startedAt: "2026-08-30T00:00:00.000Z",
      endedAt: "2026-08-30T00:01:00.000Z",
      status: "completed",
      observationCount: 1,
    } satisfies Session);
    await kv.set(KV.rawObservations(sessionId), observationId, {
      id: observationId,
      captureId: "capture-late-projection",
      sessionId,
      timestamp: "2026-08-30T00:00:30.000Z",
      hookType: "post_tool_use",
      toolName: "conversation",
      toolInput: "remember this",
      toolOutput: "remembered",
      raw: { prompt: "remember this", response: "remembered" },
    } satisfies RawObservation);
    await kv.set(KV.observationProjections, observationId, {
      observationId,
      captureId: "capture-late-projection",
      sessionId,
      status: "failed",
      attempts: 1,
      updatedAt: "2026-08-30T00:00:40.000Z",
      lastError: "temporary_failure",
    } satisfies ObservationProjection);
    await kv.set(KV.sessionProjections, sessionId, {
      sessionId,
      status: "succeeded",
      attempts: 1,
      observationCount: 0,
      updatedAt: "2026-08-30T00:00:45.000Z",
      sourceFingerprint: "summary_before_late_observation",
    });
    sdk.registerFunction("stream::set", async () => ({ success: true }));
    sdk.registerFunction("mem::project-graph-sources", async () => ({
      success: true,
    }));
    const queueTerminal = vi.fn(async () => ({
      success: true,
      projectionQueued: true,
    }));
    sdk.registerFunction("mem::queue-session-projection", queueTerminal);
    registerObservationProjectionFunction(sdk as never, kv as never);

    const result = await sdk.trigger("mem::project-observation", {
      observationId,
      sessionId,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(result).toMatchObject({ success: true });
    expect(graphRequests).toHaveLength(1);
    expect(graphRequests[0]).not.toHaveProperty("action");
    expect(graphRequests[0]).toMatchObject({
      payload: { mode: "structural" },
    });
    expect(queueTerminal).toHaveBeenCalledWith({
      sessionId,
    });
  });

  it("keeps identical events separate when their captureIds differ", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const { DedupMap } = await import("../src/functions/dedup.js");
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never, new DedupMap());

    const first = (await sdk.trigger(
      "mem::observe",
      payload("capture-distinct-1"),
    )) as { observationId: string };
    const second = (await sdk.trigger(
      "mem::observe",
      payload("capture-distinct-2"),
    )) as { observationId: string };

    expect(second.observationId).not.toBe(first.observationId);
    expect(
      await kv.list(KV.rawObservations("ses_durable_capture")),
    ).toHaveLength(2);
    expect(
      (
        await kv.get<Session>(KV.sessions, "ses_durable_capture")
      )?.observationCount,
    ).toBe(2);
  });

  it("rejects a new raw capture when the session counter reached an explicit positive cap", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const input = payload("capture-explicit-cap");
    await kv.set(KV.sessions, input.sessionId, {
      id: input.sessionId,
      project: input.project!,
      projectName: input.projectName,
      cwd: input.cwd!,
      startedAt: "2026-08-28T00:00:00.000Z",
      status: "active",
      observationCount: 500,
    } satisfies Session);
    registerObserveFunction(sdk as never, kv as never, undefined, 500);

    const result = await sdk.trigger("mem::observe", input);

    expect(result).toEqual({
      success: false,
      error: "Session observation limit reached (500)",
    });
    expect(await kv.list(KV.rawObservations(input.sessionId))).toHaveLength(0);
    expect(
      (await kv.get<Session>(KV.sessions, input.sessionId))?.observationCount,
    ).toBe(500);
  });

  it("stores the 501st raw capture without enumerating an active session history when the cap is disabled", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const input = payload("capture-unlimited-501");
    await kv.set(KV.sessions, input.sessionId, {
      id: input.sessionId,
      project: input.project!,
      projectName: input.projectName,
      cwd: input.cwd!,
      startedAt: "2026-08-28T00:00:00.000Z",
      status: "active",
      observationCount: 500,
    } satisfies Session);
    const list = kv.list.bind(kv);
    kv.list = async <T>(scope: string): Promise<T[]> => {
      if (
        scope === KV.rawObservations(input.sessionId) ||
        scope === KV.observations(input.sessionId)
      ) {
        throw new Error("session history enumeration is not bounded");
      }
      return list<T>(scope);
    };
    await registerObservationPipeline(sdk, kv);
    registerObserveFunction(sdk as never, kv as never, undefined, 0);

    const result = (await sdk.trigger("mem::observe", input)) as {
      observationId: string;
    };

    expect(result.observationId).toBeTruthy();
    expect(
      await kv.get<RawObservation>(
        KV.rawObservations(input.sessionId),
        result.observationId,
      ),
    ).toBeTruthy();
    expect(
      (await kv.get<Session>(KV.sessions, input.sessionId))?.observationCount,
    ).toBe(501);
  });

  it("reopens a completed session before projecting a genuinely new raw capture", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const input = payload("capture-completed-continuation");
    let summaryCalls = 0;
    sdk.registerFunction("mem::summarize", async () => {
      summaryCalls += 1;
      return { success: true };
    });
    await kv.set(KV.sessions, input.sessionId, {
      id: input.sessionId,
      project: input.project!,
      projectName: input.projectName,
      cwd: input.cwd!,
      startedAt: "2026-08-28T00:00:00.000Z",
      endedAt: "2026-08-28T00:10:00.000Z",
      status: "completed",
      observationCount: 500,
    } satisfies Session);
    await registerObservationPipeline(sdk, kv);
    registerObserveFunction(sdk as never, kv as never, undefined, 0);

    const result = (await sdk.trigger("mem::observe", input)) as {
      observationId: string;
    };
    await vi.waitFor(async () =>
      expect(
        (
          await kv.get<ObservationProjection>(
            KV.observationProjections,
            result.observationId,
          )
        )?.status,
      ).toBe("succeeded"),
    );

    expect(await kv.get<Session>(KV.sessions, input.sessionId)).toMatchObject({
      status: "active",
      observationCount: 501,
    });
    expect(await kv.get<Session>(KV.sessions, input.sessionId)).not.toHaveProperty(
      "endedAt",
    );
    expect(summaryCalls).toBe(0);
  });

  it("does not reopen a completed session for an already persisted capture", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const input = payload("capture-completed-duplicate");
    await registerObservationPipeline(sdk, kv);
    registerObserveFunction(sdk as never, kv as never, undefined, 0);
    const first = (await sdk.trigger("mem::observe", input)) as {
      observationId: string;
    };
    await vi.waitFor(async () =>
      expect(
        (
          await kv.get<ObservationProjection>(
            KV.observationProjections,
            first.observationId,
          )
        )?.status,
      ).toBe("succeeded"),
    );
    const endedAt = "2026-08-28T00:10:00.000Z";
    const current = await kv.get<Session>(KV.sessions, input.sessionId);
    await kv.set(KV.sessions, input.sessionId, {
      ...current!,
      endedAt,
      status: "completed",
    } satisfies Session);

    const replay = (await sdk.trigger("mem::observe", input)) as {
      deduplicated?: boolean;
    };

    expect(replay.deduplicated).toBe(true);
    expect(await kv.get<Session>(KV.sessions, input.sessionId)).toMatchObject({
      status: "completed",
      endedAt,
      observationCount: 1,
    });
  });
});

describe("api::observe capture boundary", () => {
  it("forwards a string captureId and rejects non-string values", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const forwarded: unknown[] = [];
    registerApiTriggers(sdk as never, kv as never);
    sdk.registerFunction("mem::observe", async (data: unknown) => {
      forwarded.push(data);
      return { observationId: "obs_api" };
    });

    const requestBody = {
      hookType: "subagent_stop",
      sessionId: "ses_api_capture",
      project: "/home/user/agentmemory",
      cwd: "/home/user/agentmemory",
      timestamp: "2026-08-28T00:00:00.000Z",
      data: { last_message: "done" },
    };
    const accepted = (await sdk.trigger("api::observe", {
      body: {
        ...requestBody,
        captureId: "client-capture-1",
        agentId: "reviewer",
        sourceClient: "codex",
        projectName: "agentmemory",
      },
    })) as { status_code: number };

    expect(accepted.status_code).toBe(201);
    expect(forwarded[0]).toMatchObject({
      captureId: "client-capture-1",
      agentId: "reviewer",
      sourceClient: "codex",
      projectName: "agentmemory",
    });

    const rejected = (await sdk.trigger("api::observe", {
      body: { ...requestBody, captureId: 42 },
    })) as { status_code: number; body: unknown };
    expect(rejected.status_code).toBe(400);
    expect(forwarded).toHaveLength(1);

    const rejectedSource = (await sdk.trigger("api::observe", {
      body: { ...requestBody, sourceClient: "   " },
    })) as { status_code: number; body: unknown };
    expect(rejectedSource.status_code).toBe(400);
    expect(forwarded).toHaveLength(1);
  });

  it("returns conflict when durable raw capture was not accepted", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);
    sdk.registerFunction("mem::observe", async () => ({
      success: false,
      error: "Session observation limit reached (500)",
    }));

    const result = (await sdk.trigger("api::observe", {
      body: {
        hookType: "subagent_stop",
        sessionId: "ses_api_cap",
        project: "/home/user/agentmemory",
        cwd: "/home/user/agentmemory",
        timestamp: "2026-08-28T00:00:00.000Z",
        data: { last_message: "must remain queued" },
      },
    })) as { status_code: number; body: unknown };

    expect(result).toEqual({
      status_code: 409,
      body: {
        success: false,
        error: "Session observation limit reached (500)",
      },
    });
  });
});
