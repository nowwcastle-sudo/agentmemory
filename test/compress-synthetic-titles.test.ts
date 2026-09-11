import { describe, it, expect } from "vitest";
import { buildSyntheticCompression, synthesizeTitle, isCompactionPrompt } from "../src/functions/compress-synthetic.js";
import type { RawObservation } from "../src/types.js";

// Live store 2026-09-11: 65 of 150 top-10 search rows carried a bare tool
// name for a title ("Bash", "Read", "prompt_submit"), because the synthetic
// compressor titled every observation with the tool name and nothing else.
// A title now says what the tool did, from its input; the harness's own
// compaction prompt, captured on prompt_submit, is named as such and ranked
// out of the way.

function raw(over: Partial<RawObservation>): RawObservation {
  return {
    id: "obs_1",
    sessionId: "ses_1",
    timestamp: "2026-09-11T00:00:00.000Z",
    hookType: "post_tool_use",
    raw: {},
    ...over,
  };
}

describe("synthesizeTitle", () => {
  it("names a shell command by its description, else by its first line", () => {
    expect(synthesizeTitle(raw({ toolName: "Bash", toolInput: { command: "npm test -- auth.spec.ts", description: "Run the auth tests" } })))
      .toBe("Bash: Run the auth tests");
    expect(synthesizeTitle(raw({ toolName: "Bash", toolInput: { command: "git status\ngit diff --stat" } })))
      .toBe("Bash: git status");
    expect(synthesizeTitle(raw({ toolName: "PowerShell", toolInput: { command: "Get-Process -Name vmmemWSL | Select-Object WorkingSet64" } })))
      .toBe("PowerShell: Get-Process -Name vmmemWSL | Select-Object WorkingSet64");
    // What the live store actually holds: plumbing before the command.
    expect(synthesizeTitle(raw({ toolName: "Bash", toolInput: { command: "export GATEGUARD_BASH_ROUTINE_DISABLED=1; cd /d/AGENTMEMORY_FOR_ME && npm test" } })))
      .toBe("Bash: npm test");
  });

  it("names file tools by the file's last two path segments", () => {
    expect(synthesizeTitle(raw({ toolName: "Read", toolInput: { file_path: "D:\\AGENTMEMORY_FOR_ME\\.worktrees\\x\\src\\functions\\context.ts" } })))
      .toBe("Read functions/context.ts");
    expect(synthesizeTitle(raw({ toolName: "Edit", toolInput: { file_path: "src/state/kv.ts", old_string: "a", new_string: "b" } })))
      .toBe("Edit state/kv.ts");
    expect(synthesizeTitle(raw({ toolName: "Write", toolInput: { file_path: "/tmp/notes.md", content: "..." } })))
      .toBe("Write tmp/notes.md");
  });

  it("names searches by pattern and place, fetches by target, agents by description", () => {
    expect(synthesizeTitle(raw({ toolName: "Grep", toolInput: { pattern: "isRetryDue", path: "src/health" } })))
      .toBe('Grep "isRetryDue" in src/health');
    expect(synthesizeTitle(raw({ toolName: "Glob", toolInput: { pattern: "**/*.test.ts" } })))
      .toBe("Glob **/*.test.ts");
    expect(synthesizeTitle(raw({ toolName: "WebFetch", toolInput: { url: "https://docs.example.com/api/v2/state#list", prompt: "find the list semantics" } })))
      .toBe("WebFetch docs.example.com/api/v2/state");
    expect(synthesizeTitle(raw({ toolName: "Agent", toolInput: { description: "Survey the drain harness", prompt: "..." } })))
      .toBe("Agent: Survey the drain harness");
  });

  it("uses the prompt's first line for a user prompt and the last message for a subagent", () => {
    expect(synthesizeTitle(raw({ hookType: "prompt_submit", userPrompt: "  ## 진행\n\n다음 사이클 시작" })))
      .toBe("Prompt: 진행");
    expect(synthesizeTitle(raw({ hookType: "subagent_stop", toolName: undefined, raw: { agent_id: "reviewer", last_message: "Found graph race in persist\n\ndetails..." } })))
      .toBe("Subagent: Found graph race in persist");
  });

  it("titles an assistant response by its first heading, however the hook carried it", () => {
    expect(synthesizeTitle(raw({ hookType: "assistant_response" as never, assistantResponse: "## Session Summary\n\n### Tasks\n- done" })))
      .toBe("Assistant: Session Summary");
    expect(synthesizeTitle(raw({ hookType: "assistant_response" as never, raw: { response: "Login now works with magic links.\nTry it." } })))
      .toBe("Assistant: Login now works with magic links.");
    expect(synthesizeTitle(raw({ hookType: "assistant_response" as never, toolInput: {}, toolOutput: "{} | ## Session Summary" })))
      .toBe("Assistant: {} | ## Session Summary");
    // The live rows carry it as the tool name on a post_tool_use hook.
    expect(synthesizeTitle(raw({ toolName: "assistant_response", toolInput: {}, toolOutput: "## Session Summary\n\n### Tasks" })))
      .toBe("Assistant: Session Summary");
  });

  it("falls back to the tool name plus the output's first line, then the tool name alone", () => {
    expect(synthesizeTitle(raw({ toolName: "Monitor", toolInput: {}, toolOutput: "deploy finished at 02:14\nnext" })))
      .toBe("Monitor: deploy finished at 02:14");
    expect(synthesizeTitle(raw({ toolName: "Monitor", toolInput: {} }))).toBe("Monitor");
  });

  it("keeps titles to one line of at most 80 characters", () => {
    const long = "x".repeat(200);
    const title = synthesizeTitle(raw({ toolName: "Bash", toolInput: { command: long } }));
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title).not.toMatch(/[\r\n]/);
  });
});

describe("the harness compaction prompt", () => {
  const compaction = "Below is a conversation log from a Claude Code coding session.\nCreate a summary to help the next session quickly understand the context.\n\n## Prioritize including\n- Design decisions";

  it("is recognised by its opening lines", () => {
    expect(isCompactionPrompt(compaction)).toBe(true);
    expect(isCompactionPrompt("Below is my plan for the auth rewrite")).toBe(false);
    expect(isCompactionPrompt("")).toBe(false);
  });

  it("is titled as such and ranked out of the way, not as a user prompt", () => {
    const compressed = buildSyntheticCompression(raw({ hookType: "prompt_submit", userPrompt: compaction }));
    expect(compressed.title).toBe("Auto-compact summary request");
    expect(compressed.importance).toBe(1);
  });
});

describe("harness notices captured as prompts", () => {
  // This session: 220 of 2,656 observations titled "Prompt: <task-notification>".
  const notice = '<task-notification>\n<task-id>b7kcb7r2o</task-id>\n<summary>Monitor event: "supervisor log" fired</summary>\n</task-notification>';
  const reminder = "[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.";

  it("titles a task notification by its summary and a system notice by its first line, at low importance", () => {
    const a = buildSyntheticCompression(raw({ hookType: "prompt_submit", userPrompt: notice }));
    expect(a.title).toBe('Harness notice: Monitor event: "supervisor log" fired');
    expect(a.importance).toBe(1);
    const b = buildSyntheticCompression(raw({ hookType: "prompt_submit", userPrompt: reminder }));
    expect(b.title).toBe("Harness notice: [SYSTEM NOTIFICATION - NOT USER INPUT]");
    expect(b.importance).toBe(1);
  });
});

describe("truncation never splits a surrogate pair", () => {
  // Live store 2026-09-11: two projections retried 433 and 180 times, each a
  // 180 s state::set timeout. Their narratives were cut at 400 characters in
  // the middle of an emoji, leaving a lone high surrogate; the state worker
  // never answers a set whose string is not valid UTF-8.
  const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it("keeps the narrative, subtitle and title valid wherever the cut lands inside an emoji", () => {
    // Sweep the boundary so at least one filler length puts the pair across it.
    for (let n = 360; n <= 410; n += 1) {
      const out = buildSyntheticCompression(raw({ toolName: "Bash", toolInput: { command: "ls" }, toolOutput: `${"x".repeat(n)}🔥 done` }));
      expect(LONE.test(out.narrative), `narrative at filler ${n}`).toBe(false);
      expect(out.narrative.length).toBeLessThanOrEqual(400);
    }
    for (let n = 100; n <= 125; n += 1) {
      const sub = buildSyntheticCompression(raw({ toolName: "Bash", toolInput: { command: "y".repeat(n) + "🎉🎉" } }));
      expect(LONE.test(sub.subtitle ?? ""), `subtitle at ${n}`).toBe(false);
      expect(LONE.test(sub.title), `title at ${n}`).toBe(false);
    }
    for (let n = 70; n <= 82; n += 1) {
      const title = buildSyntheticCompression(raw({ hookType: "prompt_submit", userPrompt: "z".repeat(n) + "🚀 go" }));
      expect(LONE.test(title.title), `prompt title at ${n}`).toBe(false);
      expect(title.title.length).toBeLessThanOrEqual(80);
    }
  });
});

describe("buildSyntheticCompression", () => {
  it("uses the synthesised title and keeps a real user prompt at normal importance", () => {
    const compressed = buildSyntheticCompression(raw({ toolName: "Bash", toolInput: { command: "git log --oneline -3" } }));
    expect(compressed.title).toBe("Bash: git log --oneline -3");
    expect(compressed.importance).toBe(5);
    const prompt = buildSyntheticCompression(raw({ hookType: "prompt_submit", userPrompt: "작업 어느 정도 진행됐는지 보고해" }));
    expect(prompt.title).toBe("Prompt: 작업 어느 정도 진행됐는지 보고해");
    expect(prompt.importance).toBe(5);
  });
});
