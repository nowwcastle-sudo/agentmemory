import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CompressedObservation,
  ObservationProjection,
  Session,
  SessionSummary,
} from "../src/types.js";
import { registerSessionProjectionFunction } from "../src/functions/session-projection.js";
import { KV } from "../src/state/schema.js";
import { summarySourceFingerprint } from "../src/state/source-fingerprint.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import {
  getConsolidationCooldownMs,
  isConsolidationEnabled,
} from "../src/config.js";
import { isReflectEnabled } from "../src/functions/slots.js";
import { ProjectionCoordinator } from "../src/functions/projection-coordinator.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  isConsolidationEnabled: vi.fn(() => false),
  getConsolidationCooldownMs: vi.fn(() => 300000),
}));

vi.mock("../src/functions/slots.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/slots.js")>()),
  isReflectEnabled: vi.fn(() => false),
}));

function makeSession(id = "ses_terminal"): Session {
  return {
    id,
    project: "agentmemory",
    cwd: "/repo/agentmemory",
    startedAt: "2026-08-31T00:00:00.000Z",
    endedAt: "2026-08-31T00:05:00.000Z",
    status: "completed",
    observationCount: 1,
  };
}

function makeObservation(sessionId = "ses_terminal"): CompressedObservation {
  return {
    id: "obs_terminal",
    sessionId,
    timestamp: "2026-08-31T00:04:00.000Z",
    type: "decision",
    title: "Choose durable session projection",
    facts: ["Project a summary after true session end"],
    narrative: "The session selected a bounded durable projection.",
    concepts: ["durability"],
    files: ["src/functions/session-projection.ts"],
    importance: 9,
  };
}

async function seedSession(
  kv: ReturnType<typeof mockKV>,
  session = makeSession(),
  observation = makeObservation(session.id),
): Promise<void> {
  await kv.set(KV.sessions, session.id, session);
  await kv.set(KV.observations(session.id), observation.id, observation);
}

describe("durable terminal session projection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(isConsolidationEnabled).mockReturnValue(false);
    vi.mocked(getConsolidationCooldownMs).mockReturnValue(300000);
    vi.mocked(isReflectEnabled).mockReturnValue(false);
  });
  afterEach(() => vi.useRealTimers());

  it("persists pending before durable dispatch and performs summary then semantic graph once", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const session = makeSession();
    const observation = makeObservation();
    const order: string[] = [];
    await seedSession(kv, session, observation);

    const summarize = vi.fn(async () => {
      order.push("summary");
      const summary: SessionSummary = {
        sessionId: session.id,
        project: session.project,
        createdAt: "2026-08-31T00:06:00.000Z",
        title: "Durable projection",
        narrative: "A bounded summary was created.",
        keyDecisions: ["Use a terminal queue"],
        filesModified: observation.files,
        concepts: observation.concepts,
        observationCount: 1,
        sourceFingerprint: summarySourceFingerprint([observation]),
        coveredObservationIds: [observation.id],
      };
      await kv.set(KV.summaries, session.id, summary);
      return { success: true, summary };
    });
    const graph = vi.fn(async () => {
      order.push("graph");
      return { success: true };
    });
    registerSessionProjectionFunction(
      sdk as never,
      kv as never,
      summarize,
      graph,
      new ProjectionCoordinator(),
    );
    const trigger = vi.spyOn(sdk, "trigger");

    const queued = await sdk.trigger("mem::queue-session-projection", {
      sessionId: session.id,
    });

    expect(queued).toMatchObject({ success: true, projectionQueued: true });
    expect(trigger).toHaveBeenCalledWith(
      expect.objectContaining({
        function_id: "iii::durable::publish",
        payload: {
          topic: "agentmemory.session.projection",
          data: { sessionId: session.id },
        },
        action: expect.anything(),
      }),
    );
    expect(await kv.get(KV.sessionProjections, session.id)).toMatchObject({
      sessionId: session.id,
      status: "pending",
      attempts: 0,
      observationCount: 1,
    });
    expect(summarize).not.toHaveBeenCalled();

    const result = await sdk.trigger("mem::project-session", {
      sessionId: session.id,
    });

    expect(result).toMatchObject({ success: true });
    expect(order).toEqual(["summary", "graph"]);
    expect(graph).toHaveBeenCalledWith({
      mode: "semantic",
      sources: [
        {
          sourceKind: "summary",
          sourceId: session.id,
          sessionId: session.id,
        },
      ],
    });
    expect(await kv.get(KV.sessionProjections, session.id)).toMatchObject({
      status: "succeeded",
      attempts: 1,
      sourceFingerprint: summarySourceFingerprint([observation]),
    });

    const repeated = await sdk.trigger("mem::queue-session-projection", {
      sessionId: session.id,
    });
    expect(repeated).toMatchObject({ success: true, deduplicated: true });
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(graph).toHaveBeenCalledTimes(1);
    const triggeredIds = trigger.mock.calls.map(([request]) =>
      typeof request === "string" ? request : request.function_id,
    );
    expect(triggeredIds).not.toContain("mem::summarize");
    expect(triggeredIds).not.toContain("mem::project-graph-sources");
  });

  it("defers session projection until every observation projection succeeds", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const session = makeSession("ses_waits_for_observations");
    const observation = makeObservation(session.id);
    await seedSession(kv, session, observation);
    await kv.set(KV.observationProjections, observation.id, {
      observationId: observation.id,
      captureId: "capture-pending-observation",
      sessionId: session.id,
      status: "pending",
      attempts: 0,
      updatedAt: "2026-08-31T00:04:00.000Z",
    } satisfies ObservationProjection);
    const summarizeCore = vi.fn(async () => ({ success: true }));
    const graphCore = vi.fn(async () => ({ success: true }));
    registerSessionProjectionFunction(
      sdk as never,
      kv as never,
      summarizeCore,
      graphCore,
      new ProjectionCoordinator(),
    );

    await expect(
      sdk.trigger("mem::queue-session-projection", {
        sessionId: session.id,
      }),
    ).resolves.toEqual({
      success: true,
      deferred: true,
      reason: "observation_projections_pending",
    });
    expect(summarizeCore).not.toHaveBeenCalled();
    expect(graphCore).not.toHaveBeenCalled();
  });

  it("keeps the session and previous summary when summary projection fails", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const session = makeSession("ses_failed");
    const observation = makeObservation(session.id);
    const previous: SessionSummary = {
      sessionId: session.id,
      project: session.project,
      createdAt: "2026-08-30T00:00:00.000Z",
      title: "Previous summary",
      narrative: "This successful summary must survive.",
      keyDecisions: [],
      filesModified: [],
      concepts: [],
      observationCount: 0,
      sourceFingerprint: "previous-fingerprint",
      coveredObservationIds: [],
    };
    await seedSession(kv, session, observation);
    await kv.set(KV.summaries, session.id, previous);
    const graph = vi.fn(async () => ({ success: true }));
    sdk.registerFunction("mem::summarize", async () => ({
      success: false,
      error: "provider_unavailable",
    }));
    sdk.registerFunction("mem::project-graph-sources", graph);
    registerSessionProjectionFunction(sdk as never, kv as never);

    await sdk.trigger("mem::queue-session-projection", {
      sessionId: session.id,
      evictAfterSuccess: true,
    });
    const result = await sdk.trigger("mem::project-session", {
      sessionId: session.id,
    });

    expect(result).toMatchObject({ success: false });
    expect(graph).not.toHaveBeenCalled();
    expect(await kv.get(KV.sessions, session.id)).toEqual(session);
    expect(await kv.get(KV.summaries, session.id)).toEqual(previous);
    expect(await kv.get(KV.sessionProjections, session.id)).toMatchObject({
      status: "failed",
      attempts: 1,
      evictAfterSuccess: true,
    });
  });

  it("does not mark semantic graph failure as terminal success", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const session = makeSession("ses_graph_failed");
    const observation = makeObservation(session.id);
    await seedSession(kv, session, observation);
    sdk.registerFunction("mem::summarize", async () => {
      const summary: SessionSummary = {
        sessionId: session.id,
        project: session.project,
        createdAt: "2026-08-31T00:06:00.000Z",
        title: "Summary",
        narrative: "Summary exists, but semantic graph failed.",
        keyDecisions: [],
        filesModified: observation.files,
        concepts: observation.concepts,
        observationCount: 1,
        sourceFingerprint: summarySourceFingerprint([observation]),
        coveredObservationIds: [observation.id],
      };
      await kv.set(KV.summaries, session.id, summary);
      return { success: true, summary };
    });
    sdk.registerFunction("mem::project-graph-sources", async () => ({
      success: false,
      error: "semantic_graph_unavailable",
    }));
    registerSessionProjectionFunction(sdk as never, kv as never);

    await sdk.trigger("mem::queue-session-projection", {
      sessionId: session.id,
    });
    const result = await sdk.trigger("mem::project-session", {
      sessionId: session.id,
    });

    expect(result).toMatchObject({ success: false });
    expect(await kv.get(KV.sessionProjections, session.id)).toMatchObject({
      status: "failed",
      attempts: 1,
    });
  });

  it("queues one durable maintenance intent instead of fanning out provider work", async () => {
    vi.mocked(isConsolidationEnabled).mockReturnValue(true);
    vi.mocked(getConsolidationCooldownMs).mockReturnValue(0);
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const session = makeSession("ses_maintenance");
    const observation = makeObservation(session.id);
    const consolidation = vi.fn(async () => ({ success: true }));
    const crystallize = vi.fn(async () => ({ success: true }));
    await seedSession(kv, session, observation);
    sdk.registerFunction("mem::summarize", async () => {
      const summary: SessionSummary = {
        sessionId: session.id,
        project: session.project,
        createdAt: "2026-08-31T00:06:00.000Z",
        title: "Maintenance source",
        narrative: "Core projection finished before maintenance was queued.",
        keyDecisions: [],
        filesModified: observation.files,
        concepts: observation.concepts,
        observationCount: 1,
        sourceFingerprint: summarySourceFingerprint([observation]),
        coveredObservationIds: [observation.id],
      };
      await kv.set(KV.summaries, session.id, summary);
      return { success: true, summary };
    });
    sdk.registerFunction("mem::project-graph-sources", async () => ({
      success: true,
    }));
    sdk.registerFunction("mem::consolidate-pipeline", consolidation);
    sdk.registerFunction("mem::auto-crystallize", crystallize);
    registerSessionProjectionFunction(sdk as never, kv as never);

    await sdk.trigger("mem::queue-session-projection", {
      sessionId: session.id,
    });
    const result = await sdk.trigger("mem::project-session", {
      sessionId: session.id,
    });

    expect(result).toMatchObject({ success: true });
    expect(consolidation).not.toHaveBeenCalled();
    expect(crystallize).not.toHaveBeenCalled();
    expect(
      await kv.get("mem:maintenance:projections", "global"),
    ).toMatchObject({
      id: "global",
      status: "pending",
      requestedGeneration: 1,
      processedGeneration: 0,
      stage: "semantic",
      attempts: 0,
    });
  });

  it("keeps provider capacity deferral pending for a later retry", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const session = makeSession("ses_deferred");
    await seedSession(kv, session, makeObservation(session.id));
    sdk.registerFunction("mem::summarize", async () => ({
      success: false,
      error: "provider_capacity_timeout",
    }));
    sdk.registerFunction("mem::project-graph-sources", async () => ({
      success: true,
    }));
    registerSessionProjectionFunction(sdk as never, kv as never);

    await sdk.trigger("mem::queue-session-projection", {
      sessionId: session.id,
    });
    const result = await sdk.trigger("mem::project-session", {
      sessionId: session.id,
    });

    expect(result).toMatchObject({
      success: false,
      deferred: true,
      error: "provider_capacity_timeout",
    });
    expect(await kv.get(KV.sessionProjections, session.id)).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "provider_capacity_timeout",
    });
    expect(await kv.list(KV.projectionFailed("summary"))).toHaveLength(0);
    expect(await kv.list(KV.projectionPending("summary"))).toHaveLength(1);
  });
});
