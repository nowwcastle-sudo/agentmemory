#!/usr/bin/env node
import { defaultHookDelivery, hookSessionId, stableHookCaptureId } from "./_delivery.js";
import { resolveProjectPayload, hookCwd } from "./_project.js";

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
  const locator = data.turn_id || data.tool_use_id || data.tool_name || "permission";
  await defaultHookDelivery().deliver("/agentmemory/observe", {
    captureId: stableHookCaptureId(sessionId, "permission", locator),
    hookType: "notification",
    sessionId,
    ...resolveProjectPayload(cwd),
    cwd,
    ...(typeof data.agent_id === "string" ? { agentId: data.agent_id } : {}),
    timestamp: new Date().toISOString(),
    data: {
      notification_type: "permission_prompt",
      tool_name: data.tool_name,
      tool_input: data.tool_input,
      permission_mode: data.permission_mode,
      turn_id: data.turn_id,
    },
  });
}

main().catch(() => process.exit(0));
