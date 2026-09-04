import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Session } from "../src/types.js";
import { KV } from "../src/state/schema.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("session lifecycle idempotency", () => {
  it("persists session/start without reading context when includeContext is false", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const context = vi.fn(async () => ({ context: "must not be read" }));
    registerApiTriggers(sdk as never, kv as never);
    sdk.registerFunction("mem::context", context);

    const result = (await sdk.trigger("api::session::start", {
      body: {
        sessionId: "ses_without_context",
        project: "agentmemory",
        cwd: "/work/agentmemory",
        includeContext: false,
      },
    })) as {
      status_code: number;
      body: { session: Session; context: string };
    };

    expect(result).toMatchObject({
      status_code: 200,
      body: {
        session: { id: "ses_without_context", status: "active" },
        context: "",
      },
    });
    expect(context).not.toHaveBeenCalled();
    expect(await kv.get<Session>(KV.sessions, "ses_without_context")).toMatchObject({
      id: "ses_without_context",
      status: "active",
    });
  });

  it("rejects a non-boolean includeContext value", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const context = vi.fn(async () => ({ context: "" }));
    registerApiTriggers(sdk as never, kv as never);
    sdk.registerFunction("mem::context", context);

    const result = (await sdk.trigger("api::session::start", {
      body: {
        sessionId: "ses_invalid_include_context",
        project: "agentmemory",
        cwd: "/work/agentmemory",
        includeContext: "false",
      },
    })) as { status_code: number; body: Record<string, unknown> };

    expect(result).toEqual({
      status_code: 400,
      body: { error: "includeContext must be a boolean when provided" },
    });
    expect(context).not.toHaveBeenCalled();
    expect(await kv.get(KV.sessions, "ses_invalid_include_context")).toBeNull();
  });

  it("stores the display project name separately from the stable project ID", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);
    sdk.registerFunction("mem::context", async () => ({ context: "" }));

    const result = (await sdk.trigger("api::session::start", {
      body: {
        sessionId: "ses_project_identity",
        project: "git:0123456789abcdef0123456789abcdef",
        projectName: "agentmemory",
        cwd: "/work/agentmemory",
      },
    })) as { status_code: number; body: { session: Session } };

    expect(result.status_code).toBe(200);
    expect(result.body.session).toMatchObject({
      project: "git:0123456789abcdef0123456789abcdef",
      projectName: "agentmemory",
    });
    expect(await kv.get<Session>(KV.sessions, "ses_project_identity")).toMatchObject({
      project: "git:0123456789abcdef0123456789abcdef",
      projectName: "agentmemory",
    });
  });

  it("stores sourceClient once and keeps it immutable on replay", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);
    sdk.registerFunction("mem::context", async () => ({ context: "" }));

    await sdk.trigger("api::session::start", {
      body: {
        sessionId: "ses_source_client",
        project: "agentmemory",
        cwd: "/work/agentmemory",
        sourceClient: "claude-code",
        includeContext: false,
      },
    });
    await sdk.trigger("api::session::start", {
      body: {
        sessionId: "ses_source_client",
        project: "agentmemory",
        cwd: "/work/agentmemory",
        sourceClient: "codex",
        includeContext: false,
      },
    });

    expect(await kv.get<Session>(KV.sessions, "ses_source_client")).toMatchObject({
      sourceClient: "claude-code",
    });
  });

  it("does not reset an existing session when durable session/start is replayed", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);
    sdk.registerFunction("mem::context", async () => ({ context: "retained context" }));
    await kv.set(KV.sessions, "ses_start_replay", {
      id: "ses_start_replay",
      project: "agentmemory",
      cwd: "/work/agentmemory",
      startedAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:03:00.000Z",
      status: "active",
      observationCount: 7,
      firstPrompt: "existing prompt",
      agentId: "root-agent",
    } satisfies Session);

    const result = (await sdk.trigger("api::session::start", {
      body: {
        sessionId: "ses_start_replay",
        project: "agentmemory",
        cwd: "/work/agentmemory",
        title: "replayed title",
        agentId: "different-agent",
      },
    })) as { status_code: number; body: { session: Session } };

    expect(result.status_code).toBe(200);
    expect(result.body.session).toMatchObject({
      startedAt: "2026-08-28T00:00:00.000Z",
      status: "active",
      observationCount: 7,
      firstPrompt: "existing prompt",
      agentId: "root-agent",
    });
  });

  it("does not reopen a completed session when session/start is replayed late", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);
    sdk.registerFunction("mem::context", async () => ({ context: "" }));
    await kv.set(KV.sessions, "ses_start_after_end", {
      id: "ses_start_after_end",
      project: "agentmemory",
      cwd: "/work/agentmemory",
      startedAt: "2026-08-28T00:00:00.000Z",
      endedAt: "2026-08-28T00:10:00.000Z",
      status: "completed",
      observationCount: 4,
    } satisfies Session);

    await sdk.trigger("api::session::start", {
      body: {
        sessionId: "ses_start_after_end",
        project: "agentmemory",
        cwd: "/work/agentmemory",
      },
    });

    expect(await kv.get<Session>(KV.sessions, "ses_start_after_end")).toMatchObject({
      status: "completed",
      observationCount: 4,
      endedAt: "2026-08-28T00:10:00.000Z",
    });
  });

  it("uses Stop as a checkpoint without completing the active session", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const stopped = vi.fn(async () => ({ success: true }));
    registerApiTriggers(sdk as never, kv as never);
    sdk.registerFunction("event::session::stopped", stopped);
    await kv.set(KV.sessions, "ses_checkpoint", {
      id: "ses_checkpoint",
      project: "agentmemory",
      cwd: "/work/agentmemory",
      startedAt: "2026-08-28T00:00:00.000Z",
      status: "active",
      observationCount: 1,
    } satisfies Session);

    const result = (await sdk.trigger("api::session::checkpoint", {
      body: { sessionId: "ses_checkpoint" },
    })) as { status_code: number; body: Record<string, unknown> };

    expect(result).toMatchObject({
      status_code: 200,
      body: { success: true, checkpointed: true },
    });
    expect(stopped).toHaveBeenCalledTimes(1);
    const session = await kv.get<Session>(KV.sessions, "ses_checkpoint");
    expect(session).toMatchObject({ status: "active" });
    expect(session).not.toHaveProperty("endedAt");
  });

  it("does not create a session or fan out terminal work for an unknown id", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const ended = vi.fn(async () => ({ success: true }));
    registerApiTriggers(sdk as never, kv as never);
    sdk.registerFunction("event::session::ended", ended);

    const result = (await sdk.trigger("api::session::end", {
      body: { sessionId: "ses_missing" },
    })) as { status_code: number; body: Record<string, unknown> };

    expect(result.status_code).toBe(200);
    expect(result.body).toMatchObject({
      success: true,
      transitioned: false,
      reason: "session_not_found",
    });
    expect(await kv.get(KV.sessions, "ses_missing")).toBeNull();
    expect(ended).not.toHaveBeenCalled();
  });

  it("serializes concurrent end calls and publishes terminal work exactly once", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const ended = vi.fn(async () => ({ success: true }));
    registerApiTriggers(sdk as never, kv as never);
    sdk.registerFunction("event::session::ended", ended);
    const active: Session = {
      id: "ses_active",
      project: "agentmemory",
      cwd: "/work/agentmemory",
      startedAt: "2026-08-28T00:00:00.000Z",
      status: "active",
      observationCount: 1,
    };
    await kv.set(KV.sessions, active.id, active);

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        sdk.trigger("api::session::end", {
          body: { sessionId: active.id },
        }),
      ),
    );

    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledWith({
      sessionId: active.id,
      transitionConfirmed: true,
    });
    expect(
      results.filter(
        (result) =>
          (result as { body?: { transitioned?: boolean } }).body?.transitioned,
      ),
    ).toHaveLength(1);
    expect(await kv.get<Session>(KV.sessions, active.id)).toMatchObject({
      id: active.id,
      status: "completed",
    });
  });

  it("treats an already-completed session as a no-op", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const ended = vi.fn(async () => ({ success: true }));
    registerApiTriggers(sdk as never, kv as never);
    sdk.registerFunction("event::session::ended", ended);
    await kv.set(KV.sessions, "ses_done", {
      id: "ses_done",
      project: "agentmemory",
      cwd: "/work/agentmemory",
      startedAt: "2026-08-28T00:00:00.000Z",
      endedAt: "2026-08-28T00:10:00.000Z",
      status: "completed",
      observationCount: 1,
    } satisfies Session);

    const result = (await sdk.trigger("api::session::end", {
      body: { sessionId: "ses_done" },
    })) as { body: Record<string, unknown> };

    expect(result.body).toMatchObject({
      success: true,
      transitioned: false,
      reason: "already_completed",
    });
    expect(ended).not.toHaveBeenCalled();
  });

  it("filters malformed legacy rows before summary lookup", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);
    await kv.set(KV.sessions, "bad", { status: "completed" });
    await kv.set(KV.sessions, "good", {
      id: "good",
      project: "agentmemory",
      cwd: "/work/agentmemory",
      startedAt: "2026-08-28T00:00:00.000Z",
      status: "active",
      observationCount: 0,
    } satisfies Session);

    const result = (await sdk.trigger("api::sessions", {
      query_params: {},
    })) as { body: { sessions: Session[] } };

    expect(result.body.sessions.map((session) => session.id)).toEqual(["good"]);
  });

  it("routes the per-turn Stop hook to checkpoint, not SessionEnd", () => {
    for (const path of ["src/hooks/stop.ts", "plugin/scripts/stop.mjs"]) {
      const source = readFileSync(path, "utf-8");
      expect(source).toContain("/agentmemory/session/checkpoint");
      expect(source).not.toContain("/agentmemory/session/end");
    }
  });
});
