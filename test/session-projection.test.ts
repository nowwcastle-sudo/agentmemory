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
  isAutoSummarizeEnabled,
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
  isAutoSummarizeEnabled: vi.fn(() => true),
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

function makeSummary(
  session: Session,
  observation: CompressedObservation,
  sourceFingerprint = summarySourceFingerprint([observation]),
): SessionSummary {
  return {
    sessionId: session.id,
    project: session.project,
    createdAt: "2026-08-31T00:06:00.000Z",
    title: "Durable projection",
    narrative: "A bounded summary was created.",
    keyDecisions: ["Use a terminal queue"],
    filesModified: observation.files,
    concepts: observation.concepts,
    observationCount: 1,
    sourceFingerprint,
    coveredObservationIds: [observation.id],
  };
}

describe("durable terminal session projection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(isConsolidationEnabled).mockReturnValue(false);
    vi.mocked(isAutoSummarizeEnabled).mockReturnValue(true);
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
      terminalOutcome: "summary_written",
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

  // Stage 2: judgment relations from the summary's decisions, after the
  // semantic graph. Best-effort: a failed extraction must not fail or retry
  // the projection, whose summary and graph are already written.
  describe("summary judgments", () => {
    async function project(judgments: ReturnType<typeof vi.fn>) {
      const sdk = mockSdk({ looseTrigger: true });
      const kv = mockKV();
      const session = makeSession();
      const observation = makeObservation();
      await seedSession(kv, session, observation);
      const order: string[] = [];
      const summarize = vi.fn(async () => {
        order.push("summary");
        const summary = makeSummary(session, observation);
        await kv.set(KV.summaries, session.id, summary);
        return { success: true, summary };
      });
      const graph = vi.fn(async () => {
        order.push("graph");
        return { success: true };
      });
      judgments.mockImplementation(async () => {
        order.push("judgments");
        return { success: true, edgesAdded: 2 };
      });
      registerSessionProjectionFunction(sdk as never, kv as never, summarize, graph, new ProjectionCoordinator(), judgments as never);
      await sdk.trigger("mem::queue-session-projection", { sessionId: session.id });
      const result = await sdk.trigger("mem::project-session", { sessionId: session.id });
      return { result, order, kv, session };
    }

    it("runs after the semantic graph, once, for the projected session", async () => {
      const judgments = vi.fn();
      const { result, order, session } = await project(judgments);
      expect(result).toMatchObject({ success: true });
      expect(order).toEqual(["summary", "graph", "judgments"]);
      expect(judgments).toHaveBeenCalledWith({ sessionId: session.id });
    });

    it("does not fail the projection when extraction fails", async () => {
      const judgments = vi.fn();
      const failing = vi.fn(async () => { throw new Error("provider down"); });
      judgments.mockImplementation(failing);
      const sdk = mockSdk({ looseTrigger: true });
      const kv = mockKV();
      const session = makeSession();
      const observation = makeObservation();
      await seedSession(kv, session, observation);
      const summarize = vi.fn(async () => {
        const summary = makeSummary(session, observation);
        await kv.set(KV.summaries, session.id, summary);
        return { success: true, summary };
      });
      registerSessionProjectionFunction(sdk as never, kv as never, summarize, vi.fn(async () => ({ success: true })), new ProjectionCoordinator(), failing as never);
      await sdk.trigger("mem::queue-session-projection", { sessionId: session.id });
      const result = await sdk.trigger("mem::project-session", { sessionId: session.id });
      expect(result).toMatchObject({ success: true });
      expect(await kv.get(KV.sessionProjections, session.id)).toMatchObject({ status: "succeeded", terminalOutcome: "summary_written" });
    });
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

  it("succeeds without automatic enrichment when automatic summaries are disabled", async () => {
    vi.mocked(isAutoSummarizeEnabled).mockReturnValue(false);
    vi.mocked(isConsolidationEnabled).mockReturnValue(true);
    vi.mocked(isReflectEnabled).mockReturnValue(true);
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const session = makeSession("ses_auto_summary_off");
    const observation = makeObservation(session.id);
    const summarize = vi.fn(async () => ({ success: true }));
    const graph = vi.fn(async () => ({ success: true }));
    await seedSession(kv, session, observation);
    registerSessionProjectionFunction(
      sdk as never,
      kv as never,
      summarize,
      graph,
      new ProjectionCoordinator(),
    );
    const trigger = vi.spyOn(sdk, "trigger");

    await sdk.trigger("mem::queue-session-projection", {
      sessionId: session.id,
    });
    await kv.set(KV.projectionFailed("summary"), session.id, {
      id: session.id,
      stage: "summary",
      since: "2026-08-31T00:05:00.000Z",
      updatedAt: "2026-08-31T00:05:00.000Z",
      lastError: "stale_failure",
    });
    const result = await sdk.trigger("mem::project-session", {
      sessionId: session.id,
    });

    expect(result).toMatchObject({
      success: true,
      skipped: true,
      reason: "automatic_enrichment_disabled",
    });
    expect(await kv.get(KV.sessionProjections, session.id)).toMatchObject({
      status: "succeeded",
      terminalOutcome: "skipped_automatic_enrichment",
      terminalReason: "automatic_enrichment_disabled",
      observationCount: 1,
      sourceFingerprint: summarySourceFingerprint([observation]),
    });
    expect(summarize).not.toHaveBeenCalled();
    expect(graph).not.toHaveBeenCalled();
    expect(await kv.list(KV.projectionPending("summary"))).toHaveLength(0);
    expect(await kv.list(KV.projectionFailed("summary"))).toHaveLength(0);
    expect(await kv.get("mem:maintenance:projections", "global")).toBeNull();
    expect(
      trigger.mock.calls.some(
        ([request]) =>
          typeof request !== "string" &&
          request.function_id === "mem::slot-reflect",
      ),
    ).toBe(false);
    await expect(
      sdk.trigger("mem::project-session", { sessionId: session.id }),
    ).resolves.toMatchObject({
      success: true,
      skipped: true,
      reason: "automatic_enrichment_disabled",
      deduplicated: true,
    });
    expect(await kv.get(KV.sessionProjections, session.id)).toMatchObject({
      attempts: 1,
      terminalOutcome: "skipped_automatic_enrichment",
      terminalReason: "automatic_enrichment_disabled",
    });
    await kv.set(KV.summaries, session.id, makeSummary(session, observation));
    await expect(
      sdk.trigger("mem::project-session", { sessionId: session.id }),
    ).resolves.toMatchObject({ success: true });
    expect(summarize).not.toHaveBeenCalled();
    expect(graph).toHaveBeenCalledTimes(1);
    expect(await kv.get(KV.sessionProjections, session.id)).toMatchObject({
      status: "succeeded",
      terminalOutcome: "summary_written",
    });
    expect(await kv.get(KV.sessionProjections, session.id)).not.toHaveProperty(
      "terminalReason",
    );
  });

  it("records exact no-provider as a successful skipped terminal outcome", async () => {
    vi.mocked(isConsolidationEnabled).mockReturnValue(true);
    vi.mocked(isReflectEnabled).mockReturnValue(true);
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const session = makeSession("ses_no_provider");
    const observation = makeObservation(session.id);
    const summarize = vi.fn(async () => ({
      success: false as const,
      error: "no_provider",
    }));
    const graph = vi.fn(async () => ({ success: true }));
    await seedSession(kv, session, observation);
    registerSessionProjectionFunction(
      sdk as never,
      kv as never,
      summarize,
      graph,
      new ProjectionCoordinator(),
    );

    await sdk.trigger("mem::queue-session-projection", {
      sessionId: session.id,
    });
    const result = await sdk.trigger("mem::project-session", {
      sessionId: session.id,
    });

    expect(result).toMatchObject({
      success: true,
      skipped: true,
      reason: "no_provider",
    });
    expect(await kv.get(KV.sessionProjections, session.id)).toMatchObject({
      status: "succeeded",
      terminalOutcome: "skipped_no_provider",
      terminalReason: "no_provider",
      observationCount: 1,
      sourceFingerprint: summarySourceFingerprint([observation]),
    });
    expect(graph).not.toHaveBeenCalled();
    expect(await kv.list(KV.projectionPending("summary"))).toHaveLength(0);
    expect(await kv.list(KV.projectionFailed("summary"))).toHaveLength(0);
    expect(await kv.get("mem:maintenance:projections", "global")).toBeNull();
    await expect(
      sdk.trigger("mem::project-session", { sessionId: session.id }),
    ).resolves.toMatchObject({
      success: true,
      skipped: true,
      reason: "no_provider",
      deduplicated: true,
    });
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(await kv.get(KV.sessionProjections, session.id)).toMatchObject({
      attempts: 1,
      terminalOutcome: "skipped_no_provider",
      terminalReason: "no_provider",
    });
  });

  it("promotes a matching stored summary only after provider-free graph success", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const session = makeSession("ses_existing_summary");
    const observation = makeObservation(session.id);
    const summary = makeSummary(session, observation);
    const summarize = vi.fn(async () => ({ success: true }));
    const graph = vi.fn(async () => ({ success: true }));
    await seedSession(kv, session, observation);
    await kv.set(KV.summaries, session.id, summary);
    registerSessionProjectionFunction(
      sdk as never,
      kv as never,
      summarize,
      graph,
      new ProjectionCoordinator(),
    );

    await sdk.trigger("mem::queue-session-projection", {
      sessionId: session.id,
    });
    const result = await sdk.trigger("mem::project-session", {
      sessionId: session.id,
    });

    expect(result).toMatchObject({ success: true });
    expect(await kv.get(KV.sessionProjections, session.id)).toMatchObject({
      status: "succeeded",
      terminalOutcome: "summary_written",
      observationCount: 1,
      sourceFingerprint: summary.sourceFingerprint,
    });
    expect(summarize).not.toHaveBeenCalled();
    expect(graph).toHaveBeenCalledTimes(1);
    expect(await kv.get(KV.sessionProjections, session.id)).not.toHaveProperty(
      "terminalReason",
    );
  });

  it("does not deduplicate a written-summary projection when its stored summary fingerprint differs", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const session = makeSession("ses_mismatched_dedup");
    const observation = makeObservation(session.id);
    const currentFingerprint = summarySourceFingerprint([observation]);
    const summarize = vi.fn(async () => ({
      success: false as const,
      error: "provider_unavailable",
    }));
    const graph = vi.fn(async () => ({ success: true }));
    await seedSession(kv, session, observation);
    await kv.set(KV.summaries, session.id, makeSummary(session, observation, "stale"));
    await kv.set(KV.sessionProjections, session.id, {
      sessionId: session.id,
      status: "succeeded",
      attempts: 1,
      observationCount: 1,
      sourceFingerprint: currentFingerprint,
      terminalOutcome: "summary_written",
      updatedAt: "2026-08-31T00:06:00.000Z",
    });
    registerSessionProjectionFunction(
      sdk as never,
      kv as never,
      summarize,
      graph,
      new ProjectionCoordinator(),
    );

    const result = await sdk.trigger("mem::project-session", {
      sessionId: session.id,
    });

    expect(result).toMatchObject({ success: false });
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(await kv.get(KV.sessionProjections, session.id)).toMatchObject({
      status: "failed",
      attempts: 2,
    });
    expect(await kv.get(KV.sessionProjections, session.id)).not.toHaveProperty(
      "terminalOutcome",
    );
  });

  it("fails closed when provider success stores a summary for a different source fingerprint", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const session = makeSession("ses_stale_provider_summary");
    const observation = makeObservation(session.id);
    const graph = vi.fn(async () => ({ success: true }));
    await seedSession(kv, session, observation);
    const summarize = vi.fn(async () => {
      await kv.set(
        KV.summaries,
        session.id,
        makeSummary(session, observation, "stale-provider-fingerprint"),
      );
      return { success: true };
    });
    registerSessionProjectionFunction(
      sdk as never,
      kv as never,
      summarize,
      graph,
      new ProjectionCoordinator(),
    );

    await sdk.trigger("mem::queue-session-projection", {
      sessionId: session.id,
    });
    const result = await sdk.trigger("mem::project-session", {
      sessionId: session.id,
    });

    expect(result).toMatchObject({ success: false });
    expect(graph).not.toHaveBeenCalled();
    expect(await kv.get(KV.sessionProjections, session.id)).toMatchObject({
      status: "failed",
      attempts: 1,
    });
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
    expect(
      await kv.get(KV.sessionProjections, session.id),
    ).not.toHaveProperty("terminalOutcome");
  });

  it("retries graph-only after semantic graph failure leaves a matching summary", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const session = makeSession("ses_graph_failed");
    const observation = makeObservation(session.id);
    await seedSession(kv, session, observation);
    const summarize = vi.fn(async () => {
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
    const graph = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        error: "semantic_graph_unavailable",
      })
      .mockResolvedValue({ success: true });
    sdk.registerFunction("mem::summarize", summarize);
    sdk.registerFunction("mem::project-graph-sources", graph);
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
    const retry = await sdk.trigger("mem::project-session", {
      sessionId: session.id,
    });
    expect(retry).toMatchObject({ success: true });
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(graph).toHaveBeenCalledTimes(2);
    expect(await kv.get(KV.sessionProjections, session.id)).toMatchObject({
      status: "succeeded",
      attempts: 2,
      terminalOutcome: "summary_written",
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
