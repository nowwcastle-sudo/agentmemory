#!/usr/bin/env node
import { createHookDelivery, hookSessionId, stableHookCaptureId } from "./_delivery.js";
import { resolveProjectPayload, hookCwd } from "./_project.js";
import {
  parseCodexTranscriptText,
  readTranscriptTail,
  TRANSCRIPT_TAIL_BYTES,
} from "./codex-transcript.js";

const MAX_ARCHIVE_CAPTURES = 50;

function isSdkChildContext(payload: unknown): boolean {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (!payload || typeof payload !== "object") return false;
  return (payload as { entrypoint?: unknown }).entrypoint === "sdk-ts";
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    return;
  }
  if (!data || typeof data !== "object" || isSdkChildContext(data)) return;

  const sessionId = hookSessionId(data);
  if (!sessionId) return;
  const cwd = hookCwd(data) || process.cwd();
  const projectPayload = resolveProjectPayload(cwd);
  const rawAgentId = data.agent_id ?? data.agentId;
  const agentId = typeof rawAgentId === "string" && rawAgentId.trim()
    ? rawAgentId.trim().slice(0, 128)
    : undefined;
  const delivery = createHookDelivery({ timeoutMs: 250, priority: "terminal" });
  const transcriptPath = typeof data.transcript_path === "string" ? data.transcript_path : "";
  const transcript = transcriptPath
    ? readTranscriptTail(transcriptPath)
    : { text: "", truncated: false };
  const captures = parseCodexTranscriptText(transcript.text).slice(-MAX_ARCHIVE_CAPTURES);

  for (const capture of captures) {
    await delivery.enqueue("/agentmemory/observe", {
      captureId: stableHookCaptureId(sessionId, capture.captureEvent, capture.locator),
      hookType: capture.hookType,
      sessionId,
      ...projectPayload,
      cwd,
      ...(agentId ? { agentId } : {}),
      timestamp: capture.timestamp || new Date().toISOString(),
      data: capture.data,
    });
  }

  if (transcript.truncated) {
    await delivery.enqueue("/agentmemory/observe", {
      captureId: stableHookCaptureId(sessionId, "archive", "tail-truncated"),
      hookType: "notification",
      sessionId,
      ...projectPayload,
      cwd,
      ...(agentId ? { agentId } : {}),
      timestamp: new Date().toISOString(),
      data: {
        notification_type: "archive_reconcile_truncated",
        max_bytes: TRANSCRIPT_TAIL_BYTES,
      },
    });
  }

  await delivery.enqueue("/agentmemory/session/end", { sessionId });
  if (process.env["CLAUDE_MEMORY_BRIDGE"] === "true") {
    await delivery.enqueue("/agentmemory/claude-bridge/sync", {});
  }
  // Codex gives SessionEnd a one-second default deadline. Persist everything
  // first, then replay only this hook instance's terminal batch. Historical
  // backlog keeps its independent oldest-first recovery path and cannot starve
  // the current observation -> end ordering.
  await delivery.replayQueuedFor(600);
}

main().catch(() => process.exit(0));
