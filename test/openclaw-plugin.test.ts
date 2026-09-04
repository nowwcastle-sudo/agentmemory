import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Capability = {
  promptBuilder?: (params: {
    availableTools: Set<string>;
  }) => string[] | undefined;
};

type RegisterFn = (capability: Capability) => void;

interface FakeApi {
  registerMemoryCapability: RegisterFn;
  on: ReturnType<typeof vi.fn>;
  pluginConfig: Record<string, unknown>;
  logger: { warn: ReturnType<typeof vi.fn> };
}

function makeApi(overrides: Partial<FakeApi> = {}): FakeApi {
  return {
    registerMemoryCapability: vi.fn(),
    on: vi.fn(),
    pluginConfig: { base_url: "http://localhost:3111" },
    logger: { warn: vi.fn() },
    ...overrides,
  };
}

describe("openclaw plugin — memory capability registration (closes #286 follow-up)", () => {
  it("calls api.registerMemoryCapability with a promptBuilder when the host supports it", async () => {
    const mod = await import("../integrations/openclaw/plugin.mjs");
    const plugin = (mod as unknown as { default: { register(api: FakeApi): void } }).default;
    const api = makeApi();
    plugin.register(api);
    expect(api.registerMemoryCapability).toHaveBeenCalledTimes(1);
    const capability = (api.registerMemoryCapability as ReturnType<typeof vi.fn>).mock.calls[0][0] as Capability;
    expect(typeof capability.promptBuilder).toBe("function");
    const lines = capability.promptBuilder?.({ availableTools: new Set() });
    expect(Array.isArray(lines)).toBe(true);
    expect((lines as string[]).join(" ")).toMatch(/agentmemory/i);
  });

  it("still registers hooks and tolerates older OpenClaw builds without registerMemoryCapability", async () => {
    const mod = await import("../integrations/openclaw/plugin.mjs");
    const plugin = (mod as unknown as { default: { register(api: FakeApi): void } }).default;
    const api = makeApi({ registerMemoryCapability: undefined as unknown as RegisterFn });
    expect(() => plugin.register(api)).not.toThrow();
    expect(api.on).toHaveBeenCalled();
    const events = (api.on as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(events).toContain("before_prompt_build");
    expect(events).toContain("agent_end");
    expect(events).toContain("session_end");
    expect(events).not.toContain("before_agent_start");
  });

  it("promptBuilder returns lines that mention the configured base_url", async () => {
    const mod = await import("../integrations/openclaw/plugin.mjs");
    const plugin = (mod as unknown as { default: { register(api: FakeApi): void } }).default;
    const api = makeApi({ pluginConfig: { base_url: "http://memory.internal:9999" } });
    plugin.register(api);
    const capability = (api.registerMemoryCapability as ReturnType<typeof vi.fn>).mock.calls[0][0] as Capability;
    const lines = capability.promptBuilder?.({ availableTools: new Set() }) ?? [];
    expect(lines.join("\n")).toMatch(/memory\.internal:9999/);
  });

  it("passes OpenClaw context identity and toolCall message content to capture", async () => {
    const outboxDir = await mkdtemp(join(tmpdir(), "agentmemory-openclaw-"));
    const previousOutbox = process.env.AGENTMEMORY_OUTBOX_DIR;
    const previousSecret = process.env.AGENTMEMORY_SECRET;
    process.env.AGENTMEMORY_OUTBOX_DIR = outboxDir;
    delete process.env.AGENTMEMORY_SECRET;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      if (String(_url).endsWith("/smart-search")) {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, captureId: body.captureId }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const mod = await import("../integrations/openclaw/plugin.mjs");
      const plugin = (mod as unknown as { default: { register(api: FakeApi): void } }).default;
      const api = makeApi();
      plugin.register(api);
      const handlers = new Map(
        (api.on as ReturnType<typeof vi.fn>).mock.calls.map((call) => [call[0], call[1]]),
      );
      const context = {
        sessionId: "oc-session-1",
        sessionKey: "fallback-key",
        workspaceDir: "D:\\work\\shared-project",
        agentId: "reviewer-agent",
      };

      await handlers.get("before_prompt_build")?.({ prompt: "find the graph bug" }, context);
      const event = {
        success: true,
        messages: [
          { role: "user", content: [{ type: "text", text: "inspect the graph" }] },
          {
            role: "assistant",
            content: [{ type: "toolCall", arguments: { message: "Found a missing graph edge" } }],
          },
        ],
      };
      await handlers.get("agent_end")?.(event, context);
      await handlers.get("agent_end")?.(event, context);

      const calls = fetchMock.mock.calls.map(([url, init]) => ({
        url: String(url),
        body: JSON.parse(String((init as RequestInit | undefined)?.body || "{}")),
      }));
      const search = calls.find((call) => call.url.endsWith("/smart-search"));
      expect(search?.body).toMatchObject({
        query: "find the graph bug",
        project: expect.stringMatching(/^path:[0-9a-f]{32}$/),
        agentId: "reviewer-agent",
      });
      const observes = calls.filter((call) => call.url.endsWith("/observe"));
      expect(observes).toHaveLength(3);
      expect(observes[0].body).toMatchObject({
        hookType: "prompt_submit",
        sessionId: "oc-session-1",
        project: expect.stringMatching(/^path:[0-9a-f]{32}$/),
        projectName: "shared-project",
        cwd: "D:\\work\\shared-project",
        agentId: "reviewer-agent",
        data: { prompt: "find the graph bug" },
      });
      expect(observes[1].body).toMatchObject({
        hookType: "post_tool_use",
        sessionId: "oc-session-1",
        project: expect.stringMatching(/^path:[0-9a-f]{32}$/),
        projectName: "shared-project",
        cwd: "D:\\work\\shared-project",
        agentId: "reviewer-agent",
        data: {
          tool_name: "conversation",
          tool_input: "inspect the graph",
          tool_output: "Found a missing graph edge",
        },
      });
      expect(observes[0].body.captureId).toMatch(/^openclaw:/);
      expect(observes[1].body.captureId).toMatch(/^openclaw:/);
      expect(observes[2].body.captureId).toBe(observes[1].body.captureId);
      expect(calls.some((call) => call.url.endsWith("/session/start"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      if (previousOutbox === undefined) delete process.env.AGENTMEMORY_OUTBOX_DIR;
      else process.env.AGENTMEMORY_OUTBOX_DIR = previousOutbox;
      if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
      else process.env.AGENTMEMORY_SECRET = previousSecret;
      await rm(outboxDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("merges linked worktrees and separates foreign same-basename paths", async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");
    const root = mkdtempSync(join(tmpdir(), "agentmemory-openclaw-identity-"));
    const repo = join(root, "canonical");
    const worktree = join(root, "linked");
    const foreignA = join(root, "foreign-a", "same-name");
    const foreignB = join(root, "foreign-b", "same-name");
    mkdirSync(repo, { recursive: true });
    mkdirSync(foreignA, { recursive: true });
    mkdirSync(foreignB, { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: repo, stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=AgentMemory Test",
        "-c",
        "user.email=agentmemory-test@example.invalid",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "fixture",
      ],
      { cwd: repo, stdio: "ignore" },
    );
    execFileSync("git", ["worktree", "add", "--quiet", "--detach", worktree], {
      cwd: repo,
      stdio: "ignore",
    });
    try {
      const mod = await import("../integrations/openclaw/plugin.mjs");
      const resolveIdentity = (mod as unknown as {
        resolveProjectIdentity: (cwd: string) => { project: string; projectName: string };
      }).resolveProjectIdentity;
      const canonical = resolveIdentity(repo);
      const linked = resolveIdentity(worktree);
      expect(linked.project).toBe(canonical.project);
      expect(linked.projectName).toBe("canonical");
      expect(resolveIdentity(foreignA).project).not.toBe(resolveIdentity(foreignB).project);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("spools non-2xx capture without the bearer secret and replays it after recovery", async () => {
    const outboxDir = await mkdtemp(join(tmpdir(), "agentmemory-openclaw-"));
    const mod = await import("../integrations/openclaw/plugin.mjs");
    const createDurableClient = (mod as unknown as {
      createDurableClient: (options: Record<string, unknown>) => {
        deliver(path: string, body: Record<string, unknown>): Promise<unknown>;
        replay(): Promise<number>;
      };
    }).createDurableClient;
    let healthy = false;
    const fetchMock = vi.fn(async () =>
      healthy
        ? new Response(JSON.stringify({ success: true }), { status: 200 })
        : new Response("rejected", { status: 503 }),
    );
    const client = createDurableClient({
      baseUrl: "http://localhost:3111",
      timeoutMs: 50,
      fallbackOnError: true,
      outboxDir,
      secret: "must-not-be-written",
      fetchImpl: fetchMock,
      warn: vi.fn(),
    });

    try {
      await client.deliver("/agentmemory/observe", {
        captureId: "openclaw:stable-1",
        sessionId: "session-1",
        data: { prompt: "durable payload" },
      });
      const pending = await readdir(outboxDir);
      expect(pending).toHaveLength(1);
      const stored = await readFile(join(outboxDir, pending[0]), "utf8");
      expect(stored).toContain("durable payload");
      expect(stored).not.toContain("must-not-be-written");

      healthy = true;
      expect(await client.replay()).toBe(1);
      expect(await readdir(outboxDir)).toEqual([]);
    } finally {
      await rm(outboxDir, { recursive: true, force: true });
    }
  });

  it("does not merge a capture into an unknown session when OpenClaw identity is missing", async () => {
    const outboxDir = await mkdtemp(join(tmpdir(), "agentmemory-openclaw-"));
    const previousOutbox = process.env.AGENTMEMORY_OUTBOX_DIR;
    const previousSecret = process.env.AGENTMEMORY_SECRET;
    process.env.AGENTMEMORY_OUTBOX_DIR = outboxDir;
    delete process.env.AGENTMEMORY_SECRET;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const mod = await import("../integrations/openclaw/plugin.mjs");
      const plugin = (mod as unknown as { default: { register(api: FakeApi): void } }).default;
      const api = makeApi();
      plugin.register(api);
      const agentEnd = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
        (call) => call[0] === "agent_end",
      )?.[1];
      await agentEnd?.({
        success: true,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "world" },
        ],
      }, {});
      expect(fetchMock).not.toHaveBeenCalled();
      expect(api.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/session/i));
    } finally {
      vi.unstubAllGlobals();
      if (previousOutbox === undefined) delete process.env.AGENTMEMORY_OUTBOX_DIR;
      else process.env.AGENTMEMORY_OUTBOX_DIR = previousOutbox;
      if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
      else process.env.AGENTMEMORY_SECRET = previousSecret;
      await rm(outboxDir, { recursive: true, force: true });
    }
  }, 15_000);
});
