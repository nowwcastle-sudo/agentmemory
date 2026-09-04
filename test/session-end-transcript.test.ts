import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server: Server;
let port: number;
const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
let outboxDir: string;
let rejectedSessionId: string | null = null;

function runScript(script: string, payload: Record<string, unknown>): Promise<number> {
  return new Promise((resolve) => {
    const safeEnv = { ...process.env };
    delete safeEnv.AGENTMEMORY_SECRET;
    const child = spawn("node", [`plugin/scripts/${script}.mjs`], {
      env: {
        ...safeEnv,
        AGENTMEMORY_URL: `http://127.0.0.1:${port}`,
        AGENTMEMORY_OUTBOX_DIR: outboxDir,
        CLAUDE_MEMORY_BRIDGE: "false",
      },
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function runHook(payload: Record<string, unknown>): Promise<number> {
  return runScript("session-end", payload);
}

describe("session-end transcript prompt backfill", () => {
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "am-transcript-"));
    outboxDir = join(dir, "outbox");
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(body || "{}");
          posts.push({ path: req.url ?? "", body: parsed });
        } catch {
          posts.push({ path: req.url ?? "", body: {} });
        }
        const status = parsed.sessionId === rejectedSessionId ? 503 : 200;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });

  beforeEach(() => {
    posts.length = 0;
    rejectedSessionId = null;
    rmSync(outboxDir, { recursive: true, force: true });
    mkdirSync(outboxDir, { recursive: true });
  });

  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("posts each user_query from a Cursor transcript before session end", async () => {
    posts.length = 0;
    const transcript = join(dir, "t1.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({
          role: "user",
          message: {
            content: [
              {
                type: "text",
                text: "<timestamp>Sunday</timestamp>\n<user_query>\nfirst prompt here\n</user_query>",
              },
            ],
          },
        }),
        JSON.stringify({
          role: "assistant",
          message: { content: [{ type: "text", text: "answer" }] },
        }),
        JSON.stringify({
          role: "user",
          message: {
            content: [{ type: "text", text: "bare second prompt" }],
          },
        }),
        "",
      ].join("\n"),
    );

    const code = await runHook({
      session_id: "ses_t1",
      hook_event_name: "sessionEnd",
      workspace_roots: ["/tmp"],
      reason: "completed",
      transcript_path: transcript,
    });
    expect(code).toBe(0);

    const observes = posts.filter((p) => p.path.includes("/observe"));
    expect(observes.map((p) => (p.body.data as { prompt: string }).prompt)).toEqual([
      "first prompt here",
      "bare second prompt",
    ]);
    for (const p of observes) {
      expect(p.body.hookType).toBe("prompt_submit");
      expect(p.body.sessionId).toBe("ses_t1");
    }
    const endIndex = posts.findIndex((p) => p.path.includes("/session/end"));
    expect(endIndex).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < posts.length; i++) {
      if (posts[i].path.includes("/observe")) expect(i).toBeLessThan(endIndex);
    }
  });

  it("caps backfill at 50 prompts even within a single transcript record", async () => {
    posts.length = 0;
    const transcript = join(dir, "t-cap.jsonl");
    const blocks = Array.from({ length: 60 }, (_, i) => ({
      type: "text",
      text: `<user_query>\nprompt number ${i}\n</user_query>`,
    }));
    writeFileSync(
      transcript,
      JSON.stringify({ role: "user", message: { content: blocks } }) + "\n",
    );

    const code = await runHook({
      session_id: "ses_cap",
      hook_event_name: "sessionEnd",
      reason: "completed",
      transcript_path: transcript,
    });
    expect(code).toBe(0);
    expect(posts.filter((p) => p.path.includes("/observe"))).toHaveLength(50);
  });

  it("skips backfill cleanly when transcript_path is absent or unreadable", async () => {
    posts.length = 0;
    expect(
      await runHook({
        session_id: "ses_t2",
        hook_event_name: "sessionEnd",
        reason: "completed",
      }),
    ).toBe(0);
    expect(
      await runHook({
        session_id: "ses_t3",
        hook_event_name: "sessionEnd",
        reason: "completed",
        transcript_path: join(dir, "missing.jsonl"),
      }),
    ).toBe(0);
    expect(posts.filter((p) => p.path.includes("/observe"))).toHaveLength(0);
    expect(
      posts.filter((p) => p.path.includes("/session/end")),
    ).toHaveLength(2);
  });

  it("replays the current session in order without waiting behind an older failure", async () => {
    posts.length = 0;
    rmSync(outboxDir, { recursive: true, force: true });
    mkdirSync(outboxDir, { recursive: true });
    writeFileSync(
      join(outboxDir, "older.json"),
      JSON.stringify({
        schemaVersion: 2,
        path: "/agentmemory/observe",
        body: {
          captureId: "codex:older-failure",
          hookType: "prompt_submit",
          sessionId: "older-session",
        },
        createdAt: "2026-08-30T00:00:00.000Z",
        sequence: 1,
      }),
    );
    const transcript = join(dir, "current-session.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "current prompt" }] },
      }) + "\n",
    );

    rejectedSessionId = "older-session";
    try {
      expect(
        await runHook({
          session_id: "current-session",
          hook_event_name: "SessionEnd",
          transcript_path: transcript,
        }),
      ).toBe(0);

      const current = posts.filter(
        (post) => post.body.sessionId === "current-session",
      );
      expect(current.map((post) => post.path)).toEqual([
        "/agentmemory/observe",
        "/agentmemory/session/end",
      ]);
      const pending = readdirSync(outboxDir);
      expect(pending).toHaveLength(1);
      expect(
        JSON.parse(readFileSync(join(outboxDir, pending[0]), "utf8")),
      ).toMatchObject({ body: { sessionId: "older-session" } });
    } finally {
      rejectedSessionId = null;
      rmSync(outboxDir, { recursive: true, force: true });
      mkdirSync(outboxDir, { recursive: true });
    }
  });

  it("marks a preserved SessionEnd batch for persistent terminal replay", async () => {
    posts.length = 0;
    rmSync(outboxDir, { recursive: true, force: true });
    mkdirSync(outboxDir, { recursive: true });
    const transcript = join(dir, "terminal-priority.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "persist this terminal batch" }] },
      }) + "\n",
    );

    rejectedSessionId = "terminal-priority-session";
    try {
      expect(
        await runHook({
          session_id: "terminal-priority-session",
          hook_event_name: "SessionEnd",
          transcript_path: transcript,
        }),
      ).toBe(0);

      const pending = readdirSync(outboxDir).map((name) =>
        JSON.parse(readFileSync(join(outboxDir, name), "utf8")),
      );
      expect(pending).toHaveLength(2);
      expect(
        pending.find((envelope) => envelope.path === "/agentmemory/session/end"),
      ).toMatchObject({
        schemaVersion: 2,
        priority: "terminal",
        body: { sessionId: "terminal-priority-session" },
      });
    } finally {
      rejectedSessionId = null;
      rmSync(outboxDir, { recursive: true, force: true });
      mkdirSync(outboxDir, { recursive: true });
    }
  });

  it("uses the same capture IDs for live Codex hooks and rollout reconciliation", async () => {
    posts.length = 0;
    const transcript = join(dir, "codex-live-and-archive.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-stable-1" } }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "trace the graph" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call-stable-1",
            name: "read_file",
            arguments: JSON.stringify({ path: "src/graph.ts" }),
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-stable-1",
            output: { success: true, content: "graph source" },
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "the edge is missing" }],
          },
        }),
        "",
      ].join("\n"),
    );

    const common = {
      session_id: "codex-stable-session",
      turn_id: "turn-stable-1",
      cwd: "/repo/shared",
    };
    expect(await runScript("prompt-submit", { ...common, prompt: "trace the graph" })).toBe(0);
    expect(await runScript("post-tool-use", {
      ...common,
      tool_use_id: "call-stable-1",
      tool_name: "read_file",
      tool_input: { path: "src/graph.ts" },
      tool_response: { success: true, content: "graph source" },
    })).toBe(0);
    expect(await runScript("stop", {
      ...common,
      last_assistant_message: "the edge is missing",
    })).toBe(0);
    expect(await runHook({
      ...common,
      hook_event_name: "SessionEnd",
      transcript_path: transcript,
    })).toBe(0);

    const deliveredCaptureIds = posts
      .filter((post) => post.path.includes("/observe"))
      .map((post) => String(post.body.captureId));
    const pendingCaptureIds = readdirSync(outboxDir)
      .map((name) => JSON.parse(readFileSync(join(outboxDir, name), "utf8")))
      .filter((envelope) => envelope.path === "/agentmemory/observe")
      .map((envelope) => String(envelope.body.captureId));
    const captureIds = [...deliveredCaptureIds, ...pendingCaptureIds];
    expect(captureIds).toHaveLength(6);
    const counts = new Map<string, number>();
    for (const id of captureIds) counts.set(id, (counts.get(id) || 0) + 1);
    expect(counts.size).toBe(3);
    expect([...counts.values()]).toEqual([2, 2, 2]);
  }, 20_000);

  it("durably captures remaining hook events without an unknown-session fallback", async () => {
    posts.length = 0;
    for (const script of ["notification", "post-tool-failure", "task-completed", "pre-compact"]) {
      expect(await runScript(script, {})).toBe(0);
    }
    expect(posts).toEqual([]);

    const common = {
      session_id: "hook-contract-session",
      cwd: "/repo/shared",
      agent_id: "reviewer",
      turn_id: "turn-hook-contract",
    };
    expect(await runScript("notification", {
      ...common,
      notification_type: "permission_prompt",
      title: "Permission needed",
      message: "read source",
    })).toBe(0);
    expect(await runScript("post-tool-failure", {
      ...common,
      tool_use_id: "failed-call-1",
      tool_name: "read_file",
      tool_input: { path: "src/graph.ts" },
      error: { code: "ENOENT", retryable: false },
    })).toBe(0);
    expect(await runScript("task-completed", {
      ...common,
      task_id: "task-1",
      task_subject: "Inspect graph path",
      task_description: "Verified the missing edge",
      teammate_name: "reviewer",
      team_name: "graph-team",
    })).toBe(0);
    expect(await runScript("pre-compact", {
      ...common,
      trigger: "auto",
    })).toBe(0);

    const observes = posts.filter((post) => post.path.includes("/observe"));
    expect(observes).toHaveLength(4);
    expect(observes.every((post) => String(post.body.captureId).startsWith("codex:"))).toBe(true);
    expect(observes.every((post) => post.body.sessionId === "hook-contract-session")).toBe(true);
    expect(observes.every((post) => post.body.agentId === "reviewer")).toBe(true);
    const failure = observes.find((post) => post.body.hookType === "post_tool_failure");
    expect(failure?.body.data).toMatchObject({
      tool_input: { path: "src/graph.ts" },
      error: { code: "ENOENT", retryable: false },
    });
  }, 20_000);
});
