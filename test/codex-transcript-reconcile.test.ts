import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCodexTranscriptText,
  readTranscriptTail,
  TRANSCRIPT_TAIL_BYTES,
} from "../src/hooks/codex-transcript.js";
import { stableHookCaptureId } from "../src/hooks/_delivery.js";

describe("Codex rollout archive reconciliation", () => {
  it("recovers user, assistant, tool, and thread-title events with stable locators", () => {
    const transcript = [
      {
        timestamp: "2026-08-28T01:00:00.000Z",
        type: "session_meta",
        payload: { id: "codex-session-1", cwd: "/repo/shared" },
      },
      {
        timestamp: "2026-08-28T01:00:01.000Z",
        type: "turn_context",
        payload: { turn_id: "turn-1" },
      },
      {
        timestamp: "2026-08-28T01:00:01.100Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "inspect graph capture" }],
        },
      },
      {
        timestamp: "2026-08-28T01:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "call-1",
          name: "read_file",
          arguments: JSON.stringify({ path: "src/graph.ts" }),
        },
      },
      {
        timestamp: "2026-08-28T01:00:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-1",
          output: { content: "graph source", success: true },
        },
      },
      {
        timestamp: "2026-08-28T01:00:04.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "I found the missing edge." }],
        },
      },
      {
        timestamp: "2026-08-28T01:00:05.000Z",
        type: "event_msg",
        payload: { type: "thread_name_updated", thread_name: "Graph capture repair" },
      },
    ].map((line) => JSON.stringify(line)).join("\n");

    const first = parseCodexTranscriptText(transcript);
    const second = parseCodexTranscriptText(transcript);
    expect(first.map((event) => event.hookType)).toEqual([
      "prompt_submit",
      "post_tool_use",
      "post_tool_use",
      "notification",
    ]);
    expect(first[0].data).toEqual({ prompt: "inspect graph capture", archive_reconciled: true });
    expect(first[1].data).toMatchObject({
      tool_name: "read_file",
      tool_input: { path: "src/graph.ts" },
      tool_output: { content: "graph source", success: true },
      call_id: "call-1",
    });
    expect(first[2].data).toMatchObject({
      tool_name: "assistant_response",
      tool_output: "I found the missing edge.",
    });
    expect(first[3].data).toMatchObject({ title: "Graph capture repair" });
    expect(first.map((event) => event.locator)).toEqual(second.map((event) => event.locator));
    expect(first.map((event) => event.captureEvent)).toEqual([
      "prompt",
      "tool",
      "assistant",
      "title",
    ]);
    expect(first[0].locator).toBe("turn-1");
    expect(first[1].locator).toBe("call-1");
    expect(
      stableHookCaptureId("codex-session-1", first[0].captureEvent, first[0].locator),
    ).toBe(stableHookCaptureId("codex-session-1", "prompt", "turn-1"));
    expect(
      stableHookCaptureId("codex-session-1", first[1].captureEvent, first[1].locator),
    ).toBe(stableHookCaptureId("codex-session-1", "tool", "call-1"));
  });

  it("keeps Cursor-style user_query compatibility without treating malformed lines as events", () => {
    const transcript = [
      "not-json",
      JSON.stringify({
        role: "user",
        message: {
          content: [{ type: "text", text: "<user_query>\nlegacy prompt\n</user_query>" }],
        },
      }),
    ].join("\n");
    expect(parseCodexTranscriptText(transcript)).toMatchObject([
      { hookType: "prompt_submit", data: { prompt: "legacy prompt", archive_reconciled: true } },
    ]);
  });

  it("bounds archive reads and discards the partial first line", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmemory-codex-tail-"));
    const path = join(dir, "rollout.jsonl");
    const finalLine = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "tail prompt" }],
      },
    });
    try {
      writeFileSync(path, `${"x".repeat(TRANSCRIPT_TAIL_BYTES + 32)}\n${finalLine}\n`);
      const tail = readTranscriptTail(path);
      expect(tail.truncated).toBe(true);
      expect(tail.text).toBe(`${finalLine}\n`);
      expect(parseCodexTranscriptText(tail.text)[0]).toMatchObject({
        captureEvent: "prompt",
        data: { prompt: "tail prompt" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
