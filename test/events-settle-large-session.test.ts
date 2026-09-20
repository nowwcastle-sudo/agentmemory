import { describe, expect, it, vi } from "vitest";
import { registerEventTriggers } from "../src/triggers/events.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  getAgentId: vi.fn(() => undefined),
}));

// Settling a stopped session listed `mem:raw-obs:<sessionId>` whole. On the
// live store 2026-09-20 that scope was the single largest whole-scope read:
// 21.6 MB in two calls for one 6,763-observation session, and `state::list`
// has no pagination, so it crosses the engine as one message (problem #1).
//
// What settle looks for -- projections that are not succeeded -- already sits
// in the active index, a few rows. The raw sweep enumerated observation ids
// and then dropped every one whose projection row was missing or succeeded,
// so it never reached anything the index does not hold: the same queue calls
// come out of a few kilobytes. The tests below pin both halves of that --
// what is queued, and that an observation with no projection row stays
// unqueued, which is what the old code did too.

const projection = (observationId: string, sessionId: string, status = "pending") => ({
  observationId,
  captureId: `cap_${observationId}`,
  sessionId,
  status,
  attempts: 0,
  updatedAt: "2026-09-20T00:00:00.000Z",
});

async function seedSession(
  kv: ReturnType<typeof mockKV>,
  sessionId: string,
  rawCount: number,
  observationCount: number,
) {
  await kv.set(KV.sessions, sessionId, {
    id: sessionId,
    project: "agentmemory",
    cwd: "/repo/agentmemory",
    startedAt: "2026-09-20T00:00:00.000Z",
    status: "active",
    observationCount,
  });
  for (let i = 0; i < rawCount; i++) {
    await kv.set(KV.rawObservations(sessionId), `obs_${i}`, { id: `obs_${i}`, sessionId });
  }
}

describe("settling a stopped session", () => {
  it("queues unfinished work from the active index without listing the raw scope", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const queueObservation = vi.fn(async () => ({ success: true, queued: true }));
    sdk.registerFunction("mem::queue-observation-projection", queueObservation);
    await seedSession(kv, "ses_big", 3, 9000);
    await kv.set(KV.observationProjections, "obs_1", projection("obs_1", "ses_big"));
    await kv.set(KV.observationProjectionsActive, "obs_1", projection("obs_1", "ses_big"));
    await kv.set(KV.observationProjectionsActive, "__built", {
      builtAt: "2026-09-20T00:00:00.000Z",
      rows: 1,
    });
    const listed: string[] = [];
    const list = kv.list.bind(kv);
    kv.list = (async (scope: string) => {
      listed.push(scope);
      return list(scope);
    }) as typeof kv.list;
    registerEventTriggers(sdk as never, kv as never);

    await sdk.trigger("event::session::stopped", { sessionId: "ses_big" });

    expect(queueObservation).toHaveBeenCalledWith({
      observationId: "obs_1",
      sessionId: "ses_big",
    });
    expect(listed).not.toContain(KV.rawObservations("ses_big"));
  });

  it("leaves an observation with no projection row unqueued, as before", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const queueObservation = vi.fn(async () => ({ success: true, queued: true }));
    sdk.registerFunction("mem::queue-observation-projection", queueObservation);
    await seedSession(kv, "ses_small", 2, 2);
    await kv.set(KV.observationProjectionsActive, "__built", {
      builtAt: "2026-09-20T00:00:00.000Z",
      rows: 0,
    });
    registerEventTriggers(sdk as never, kv as never);

    await sdk.trigger("event::session::stopped", { sessionId: "ses_small" });

    expect(queueObservation).not.toHaveBeenCalled();
  });

  it("queues a failed projection of this session", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const queueObservation = vi.fn(async () => ({ success: true, queued: true }));
    sdk.registerFunction("mem::queue-observation-projection", queueObservation);
    await seedSession(kv, "ses_small", 1, 1);
    await kv.set(KV.observationProjections, "obs_0", projection("obs_0", "ses_small", "failed"));
    await kv.set(KV.observationProjectionsActive, "obs_0", projection("obs_0", "ses_small", "failed"));
    await kv.set(KV.observationProjectionsActive, "__built", {
      builtAt: "2026-09-20T00:00:00.000Z",
      rows: 1,
    });
    registerEventTriggers(sdk as never, kv as never);

    await sdk.trigger("event::session::stopped", { sessionId: "ses_small" });

    expect(queueObservation).toHaveBeenCalledWith({
      observationId: "obs_0",
      sessionId: "ses_small",
    });
  });

  it("does not queue the same observation twice when the index and the raw sweep agree", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const queueObservation = vi.fn(async () => ({ success: true, queued: true }));
    sdk.registerFunction("mem::queue-observation-projection", queueObservation);
    await seedSession(kv, "ses_small", 1, 1);
    await kv.set(KV.observationProjections, "obs_0", projection("obs_0", "ses_small"));
    await kv.set(KV.observationProjectionsActive, "obs_0", projection("obs_0", "ses_small"));
    await kv.set(KV.observationProjectionsActive, "__built", {
      builtAt: "2026-09-20T00:00:00.000Z",
      rows: 1,
    });
    registerEventTriggers(sdk as never, kv as never);

    await sdk.trigger("event::session::stopped", { sessionId: "ses_small" });

    expect(queueObservation).toHaveBeenCalledTimes(1);
  });

  it("leaves another session's unfinished projection alone", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const queueObservation = vi.fn(async () => ({ success: true, queued: true }));
    sdk.registerFunction("mem::queue-observation-projection", queueObservation);
    await seedSession(kv, "ses_big", 1, 9000);
    await kv.set(KV.observationProjections, "obs_other", projection("obs_other", "ses_other"));
    await kv.set(KV.observationProjectionsActive, "obs_other", projection("obs_other", "ses_other"));
    await kv.set(KV.observationProjectionsActive, "__built", {
      builtAt: "2026-09-20T00:00:00.000Z",
      rows: 1,
    });
    registerEventTriggers(sdk as never, kv as never);

    await sdk.trigger("event::session::stopped", { sessionId: "ses_big" });

    expect(queueObservation).not.toHaveBeenCalled();
  });
});
