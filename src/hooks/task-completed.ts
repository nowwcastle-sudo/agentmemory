#!/usr/bin/env node
import { resolveProjectPayload, hookCwd } from "./_project.js";
import { defaultHookDelivery, hookSessionId, stableHookCaptureId } from "./_delivery.js";

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

  await defaultHookDelivery().deliver("/agentmemory/observe", {
    captureId: stableHookCaptureId(
      sessionId,
      "task_completed",
      data.task_id ?? data.turn_id ?? data.task_subject,
    ),
    hookType: "task_completed",
    sessionId,
    ...resolveProjectPayload(cwd),
    cwd,
    ...(typeof data.agent_id === "string" ? { agentId: data.agent_id } : {}),
    timestamp: new Date().toISOString(),
    data: {
      task_id: data.task_id,
      task_subject: data.task_subject,
      task_description: typeof data.task_description === "string"
        ? data.task_description.slice(0, 2000)
        : "",
      teammate_name: data.teammate_name,
      team_name: data.team_name,
    },
  });
}

main().catch(() => process.exit(0));
