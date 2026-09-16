#!/usr/bin/env node
import { resolveProjectPayload, hookCwd } from "./_project.js";
import {
  defaultHookDelivery,
  hookSessionId,
  stableHookCaptureId,
  toolEventLocator,
} from "./_delivery.js";

function isSdkChildContext(payload: unknown): boolean {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (!payload || typeof payload !== "object") return false;
  return (payload as { entrypoint?: unknown }).entrypoint === "sdk-ts";
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    return;
  }

  if (!data || typeof data !== "object") return;
  if (isSdkChildContext(data)) return;
  if (data.is_interrupt || data.isInterrupt) return;

  const sessionId = hookSessionId(data);
  if (!sessionId) return;
  const toolName = data.tool_name ?? data.toolName;
  const toolInput = data.tool_input ?? data.toolArgs;
  const error = data.error ?? data.errorMessage;

  const cwd = hookCwd(data) || process.cwd();

  const capturedAt = new Date().toISOString();
  const toolUseId = toolEventLocator(data, capturedAt);
  await defaultHookDelivery().deliver("/agentmemory/observe", {
    captureId: stableHookCaptureId(sessionId, "tool", toolUseId),
    hookType: "post_tool_failure",
    sessionId,
    ...resolveProjectPayload(cwd),
    cwd,
    ...(typeof data.agent_id === "string" ? { agentId: data.agent_id } : {}),
    timestamp: capturedAt,
    data: {
      tool_name: toolName,
      tool_input: truncate(toolInput, 4000),
      error: truncate(error, 4000),
      call_id: toolUseId,
    },
  });
}

function truncate(value: unknown, max: number): unknown {
  if (typeof value === "string") {
    return value.length > max ? `${value.slice(0, max)}...[truncated]` : value;
  }
  if (value && typeof value === "object") {
    const serialized = JSON.stringify(value);
    return serialized.length > max ? `${serialized.slice(0, max)}...[truncated]` : value;
  }
  return value;
}

main().catch(() => process.exit(0));
