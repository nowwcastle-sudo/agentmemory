#!/usr/bin/env node
import { resolveProjectPayload, hookCwd } from "./_project.js";
import {
  defaultHookDelivery,
  hookEventLocator,
  hookSessionId,
  stableHookCaptureId,
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

  const sessionId = hookSessionId(data);
  if (!sessionId) return;

  const cwd = hookCwd(data) || process.cwd();

  const prompt = data.prompt ?? data.userPrompt;
  const capturedAt = new Date().toISOString();
  await defaultHookDelivery().deliver("/agentmemory/observe", {
    captureId: stableHookCaptureId(
      sessionId,
      "prompt",
      hookEventLocator([data.turn_id], capturedAt),
    ),
    hookType: "prompt_submit",
    sessionId,
    ...resolveProjectPayload(cwd),
    cwd,
    ...(typeof data.agent_id === "string" ? { agentId: data.agent_id } : {}),
    timestamp: capturedAt,
    data: { prompt },
  });
}

main().catch(() => process.exit(0));
