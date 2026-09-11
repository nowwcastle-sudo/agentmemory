#!/usr/bin/env node
import {
  defaultHookDelivery,
  hookEventLocator,
  hookSessionId,
  stableHookCaptureId,
} from "./_delivery.js";
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
  const capturedAt = new Date().toISOString();
  await defaultHookDelivery().deliver("/agentmemory/observe", {
    captureId: stableHookCaptureId(
      sessionId,
      "post_compact",
      hookEventLocator([data.turn_id], capturedAt),
    ),
    hookType: "post_compact",
    sessionId,
    ...resolveProjectPayload(cwd),
    cwd,
    ...(typeof data.agent_id === "string" ? { agentId: data.agent_id } : {}),
    timestamp: capturedAt,
    data: {
      trigger: data.trigger,
      model: data.model,
      turn_id: data.turn_id,
    },
  });
}

main().catch(() => process.exit(0));
