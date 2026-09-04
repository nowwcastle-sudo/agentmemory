import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("OpenCode capture contract", () => {
  let outboxDir: string;
  let previousOutbox: string | undefined;
  let previousSecret: string | undefined;

  beforeEach(async () => {
    outboxDir = await mkdtemp(join(tmpdir(), "agentmemory-opencode-"));
    previousOutbox = process.env.AGENTMEMORY_OUTBOX_DIR;
    previousSecret = process.env.AGENTMEMORY_SECRET;
    process.env.AGENTMEMORY_OUTBOX_DIR = outboxDir;
    delete process.env.AGENTMEMORY_SECRET;
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (previousOutbox === undefined) delete process.env.AGENTMEMORY_OUTBOX_DIR;
    else process.env.AGENTMEMORY_OUTBOX_DIR = previousOutbox;
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
    await rm(outboxDir, { recursive: true, force: true });
  });

  it("preserves structured tool input/output and a stable capture ID", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/session/start")) {
        return new Response(JSON.stringify({ context: "cached project context" }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { AgentmemoryCapturePlugin } = await import("../plugin/opencode/agentmemory-capture.ts");
    const handlers = await (AgentmemoryCapturePlugin as any)({ worktree: "/repo/shared" });
    await handlers.event({
      event: { type: "session.created", properties: { info: { id: "oc-session-1" } } },
    });
    await handlers.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "message-reviewer-1",
            sessionID: "oc-session-1",
            role: "assistant",
            agent: "reviewer",
            tokens: {},
          },
        },
      },
    });
    await handlers.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "oc-session-1",
            messageID: "message-reviewer-1",
            callID: "call-structured-1",
            tool: "apply_patch",
            state: {
              status: "completed",
              input: { file_path: "src/graph.ts", patch: { hunks: 2 } },
              output: { applied: true, files: ["src/graph.ts"] },
            },
          },
        },
      },
    });

    const observeCall = fetchMock.mock.calls.find(([url, init]) => {
      if (!String(url).endsWith("/observe")) return false;
      const candidate = JSON.parse(String((init as RequestInit).body));
      return candidate.data?.tool_name === "apply_patch";
    });
    expect(observeCall).toBeDefined();
    const body = JSON.parse(String((observeCall?.[1] as RequestInit).body));
    expect(body.captureId).toMatch(/^opencode:/);
    expect(body.agentId).toBe("reviewer");
    expect(body.data.tool_input).toEqual({
      file_path: "src/graph.ts",
      patch: { hunks: 2 },
    });
    expect(body.data.tool_output).toEqual({ applied: true, files: ["src/graph.ts"] });
  }, 15_000);

  it("injects cached context into every system transform, including after an internal request", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/session/start")) {
        return new Response(JSON.stringify({ context: "cached project context" }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { AgentmemoryCapturePlugin } = await import("../plugin/opencode/agentmemory-capture.ts");
    const handlers = await (AgentmemoryCapturePlugin as any)({ worktree: "/repo/shared" });
    await handlers.event({
      event: { type: "session.created", properties: { info: { id: "oc-session-2" } } },
    });
    const first = { system: [] as string[] };
    const second = { system: [] as string[] };
    await handlers["experimental.chat.system.transform"](
      { sessionID: "oc-session-2", model: {} },
      first,
    );
    await handlers["experimental.chat.system.transform"](
      { sessionID: "oc-session-2", model: {} },
      second,
    );
    expect(first.system).toContain("cached project context");
    expect(second.system).toContain("cached project context");
  });

  it("keeps the complete structured session status", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/session/start")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { AgentmemoryCapturePlugin } = await import("../plugin/opencode/agentmemory-capture.ts");
    const handlers = await (AgentmemoryCapturePlugin as any)({ worktree: "/repo/shared" });
    await handlers.event({
      event: { type: "session.created", properties: { info: { id: "oc-session-3" } } },
    });
    await handlers.event({
      event: {
        type: "session.status",
        properties: {
          sessionID: "oc-session-3",
          status: {
            type: "retry",
            attempt: 3,
            message: "provider unavailable",
            next: 1787890000000,
            provider: { id: "local", model: "large" },
          },
        },
      },
    });
    const observeCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/observe"));
    const body = JSON.parse(String((observeCalls.at(-1)?.[1] as RequestInit).body));
    expect(body.data.status).toEqual({
      type: "retry",
      attempt: 3,
      message: "provider unavailable",
      next: 1787890000000,
      provider: { id: "local", model: "large" },
    });
  });

  it("spools HTTP rejection without secret and replays after recovery", async () => {
    const mod = await import("../plugin/opencode/agentmemory-capture.ts");
    const createDurableTransport = (mod as any).createDurableTransport;
    let healthy = false;
    const fetchMock = vi.fn(async () =>
      healthy
        ? new Response(JSON.stringify({ success: true }), { status: 201 })
        : new Response("rejected", { status: 503 }),
    );
    const transport = createDurableTransport({
      api: "http://localhost:3111",
      outboxDir,
      secret: "must-not-be-written",
      fetchImpl: fetchMock,
      debug: false,
    });
    await transport.deliver("/observe", {
      captureId: "opencode:stable-1",
      sessionId: "oc-session-4",
      data: { prompt: "durable payload" },
    });
    const pending = await readdir(outboxDir);
    expect(pending).toHaveLength(1);
    const stored = await readFile(join(outboxDir, pending[0]), "utf8");
    expect(stored).toContain("durable payload");
    expect(stored).not.toContain("must-not-be-written");

    healthy = true;
    expect(await transport.replay()).toBe(1);
    expect(await readdir(outboxDir)).toEqual([]);
  });
});
