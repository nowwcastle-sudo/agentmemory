import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

export interface TranscriptCapture {
  hookType: "prompt_submit" | "post_tool_use" | "post_tool_failure" | "notification";
  captureEvent: "prompt" | "tool" | "assistant" | "title";
  locator: string;
  timestamp?: string;
  data: Record<string, unknown>;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item) => {
      const block = asRecord(item);
      if (!block) return [];
      const text = block.text;
      return typeof text === "string" ? [text] : [];
    })
    .join("\n")
    .trim();
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function cursorPrompts(entry: JsonRecord): string[] {
  if (entry.role !== "user") return [];
  const message = asRecord(entry.message);
  const text = contentText(message?.content);
  const matches = [...text.matchAll(/<user_query>\n?([\s\S]*?)\n?<\/user_query>/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  if (matches.length > 0) return matches;
  const prompt = text.trim();
  return prompt ? [prompt] : [];
}

export function readTranscriptTail(path: string): { text: string; truncated: boolean } {
  if (!path.endsWith(".jsonl")) return { text: "", truncated: false };
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return { text, truncated: start > 0 };
  } catch {
    return { text: "", truncated: false };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function parseCodexTranscriptText(text: string): TranscriptCapture[] {
  const entries: Array<{ line: number; entry: JsonRecord }> = [];
  for (const [line, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    try {
      const entry = asRecord(JSON.parse(raw));
      if (entry) entries.push({ line, entry });
    } catch {
      // A malformed line does not invalidate later durable rollout items.
    }
  }

  const calls = new Map<string, { name: string; input: unknown }>();
  for (const { entry } of entries) {
    if (entry.type !== "response_item") continue;
    const payload = asRecord(entry.payload);
    if (!payload) continue;
    const callId = typeof payload.call_id === "string" ? payload.call_id : "";
    if (!callId) continue;
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      calls.set(callId, {
        name: typeof payload.name === "string" ? payload.name : "unknown",
        input: parseArguments(payload.arguments ?? payload.input),
      });
    } else if (payload.type === "local_shell_call") {
      calls.set(callId, { name: "local_shell", input: payload.action ?? payload.command });
    }
  }

  const captures: TranscriptCapture[] = [];
  let currentTurnId = "";
  for (const { line, entry } of entries) {
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    if (entry.type === "turn_context") {
      const payload = asRecord(entry.payload);
      currentTurnId = typeof payload?.turn_id === "string" ? payload.turn_id : currentTurnId;
      continue;
    }

    if (entry.type === "response_item") {
      const payload = asRecord(entry.payload);
      if (!payload) continue;
      if (payload.type === "message") {
        const role = payload.role;
        const message = contentText(payload.content);
        if (!message) continue;
        if (role === "user") {
          if (message.startsWith("<environment_context>")) continue;
          captures.push({
            hookType: "prompt_submit",
            captureEvent: "prompt",
            locator: currentTurnId || message,
            timestamp,
            data: { prompt: message, archive_reconciled: true },
          });
        } else if (role === "assistant") {
          captures.push({
            hookType: "post_tool_use",
            captureEvent: "assistant",
            locator: currentTurnId || message,
            timestamp,
            data: {
              tool_name: "assistant_response",
              tool_input: { turn_id: currentTurnId || undefined },
              tool_output: message,
              archive_reconciled: true,
            },
          });
        }
        continue;
      }

      if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
        const callId = typeof payload.call_id === "string" ? payload.call_id : "";
        if (!callId) continue;
        const call = calls.get(callId) ?? { name: "unknown", input: undefined };
        const output = parseArguments(payload.output);
        const outputRecord = asRecord(output);
        const failed = outputRecord?.success === false;
        captures.push({
          hookType: failed ? "post_tool_failure" : "post_tool_use",
          captureEvent: "tool",
          locator: callId,
          timestamp,
          data: {
            tool_name: call.name,
            tool_input: call.input,
            tool_output: output,
            call_id: callId,
            archive_reconciled: true,
          },
        });
      }
      continue;
    }

    if (entry.type === "event_msg") {
      const payload = asRecord(entry.payload);
      if (payload?.type !== "thread_name_updated") continue;
      const title = payload.thread_name ?? payload.name;
      if (typeof title !== "string" || !title.trim()) continue;
      captures.push({
        hookType: "notification",
        captureEvent: "title",
        locator: title.trim(),
        timestamp,
        data: {
          notification_type: "thread_name_updated",
          title: title.trim(),
          archive_reconciled: true,
        },
      });
      continue;
    }

    for (const prompt of cursorPrompts(entry)) {
      captures.push({
        hookType: "prompt_submit",
        captureEvent: "prompt",
        locator: prompt,
        timestamp,
        data: { prompt, archive_reconciled: true },
      });
    }
  }
  return captures;
}
