import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Session } from "../src/types.js";
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

describe("session checkpoint and true-terminal separation", () => {
  it("queues only this session's unfinished projections without settling provider work", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const queueObservation = vi.fn(async () => ({ success: true, queued: true }));
    sdk.registerFunction("mem::queue-observation-projection", queueObservation);
    await kv.set(KV.rawObservations("ses_target"), "obs_target", {
      id: "obs_target",
      sessionId: "ses_target",
    });
    await kv.set(KV.rawObservations("ses_other"), "obs_other", {
      id: "obs_other",
      sessionId: "ses_other",
    });
    await kv.set(KV.observationProjections, "obs_target", {
      observationId: "obs_target",
      captureId: "cap_target",
      sessionId: "ses_target",
      status: "pending",
      attempts: 0,
      updatedAt: "2026-08-31T00:00:00.000Z",
    });
    await kv.set(KV.observationProjections, "obs_other", {
      observationId: "obs_other",
      captureId: "cap_other",
      sessionId: "ses_other",
      status: "pending",
      attempts: 0,
      updatedAt: "2026-08-31T00:00:00.000Z",
    });
    registerEventTriggers(sdk as never, kv as never);

    const result = await sdk.trigger("event::session::stopped", {
      sessionId: "ses_target",
    });

    expect(result).toEqual({ success: true, checkpointed: true });
    expect(queueObservation).toHaveBeenCalledTimes(1);
    expect(queueObservation).toHaveBeenCalledWith({
      observationId: "obs_target",
      sessionId: "ses_target",
    });
    expect(await kv.get(KV.sessionProjections, "ses_target")).toBeNull();
  });

  it("repeated checkpoints never invoke enrichment or corpus work", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const forbidden = vi.fn(async () => ({ success: true }));
    for (const functionId of [
      "mem::summarize",
      "mem::queue-session-projection",
      "mem::project-graph-sources",
      "mem::slot-reflect",
      "mem::consolidate-pipeline",
      "mem::auto-crystallize",
    ]) {
      sdk.registerFunction(functionId, forbidden);
    }
    registerEventTriggers(sdk as never, kv as never);

    await sdk.trigger("event::session::stopped", { sessionId: "ses_1" });
    await sdk.trigger("event::session::stopped", { sessionId: "ses_1" });

    expect(forbidden).not.toHaveBeenCalled();
  });

  it("queues terminal work once after a real active-to-completed transition", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const queued = vi.fn(async () => ({
      success: true,
      projectionQueued: true,
    }));
    sdk.registerFunction("mem::queue-session-projection", queued);
    registerEventTriggers(sdk as never, kv as never);
    const session: Session = {
      id: "ses_terminal",
      project: "agentmemory",
      cwd: "/repo/agentmemory",
      startedAt: "2026-08-31T00:00:00.000Z",
      status: "active",
      observationCount: 1,
    };
    await kv.set(KV.sessions, session.id, session);

    const first = await sdk.trigger("event::session::ended", {
      sessionId: session.id,
    });
    const repeated = await sdk.trigger("event::session::ended", {
      sessionId: session.id,
    });

    expect(first).toMatchObject({ success: true, transitioned: true });
    expect(repeated).toMatchObject({
      success: true,
      transitioned: false,
      reason: "already_completed",
    });
    expect(queued).toHaveBeenCalledTimes(1);
    expect(queued).toHaveBeenCalledWith({ sessionId: session.id });
  });
});

describe("session-end hook keeps one true-terminal path", () => {
  const src = readFileSync("src/hooks/session-end.ts", "utf-8");

  it("does not POST direct crystal or consolidation endpoints", () => {
    expect(src).not.toContain("/agentmemory/crystals/auto");
    expect(src).not.toContain("/agentmemory/consolidate-pipeline");
  });

  it("POSTs /agentmemory/session/end and keeps bridge synchronization", () => {
    expect(src).toContain("/agentmemory/session/end");
    expect(src).toContain("/agentmemory/claude-bridge/sync");
  });

  it("keeps the null guard and main failure containment", () => {
    expect(src).toContain('if (!data || typeof data !== "object"');
    expect(src).toContain("main().catch(() => process.exit(0));");
  });
});
