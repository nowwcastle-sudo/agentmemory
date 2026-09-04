#!/usr/bin/env node
import { resolveProjectPayload, hookCwd } from "./_project.js";
import { defaultHookDelivery, hookSessionId, stableHookCaptureId } from "./_delivery.js";

// Inlined from ./sdk-guard so each hook bundles to a single self-contained
// .mjs (matches the pattern used by every other hook entry in tsdown.config).
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
  const agentId = data.agent_id || data.agentName;
  const agentType = data.agent_type || data.agentDisplayName || data.agentName;

  const cwd = hookCwd(data) || process.cwd();

  await defaultHookDelivery().deliver("/agentmemory/observe", {
    captureId: stableHookCaptureId(sessionId, "subagent_start", agentId ?? data.turn_id),
    hookType: "subagent_start",
    sessionId,
    ...resolveProjectPayload(cwd),
    cwd,
    ...(typeof agentId === "string" ? { agentId } : {}),
    timestamp: new Date().toISOString(),
    data: {
      agent_id: agentId,
      agent_type: agentType,
      parent_agent_id: data.parent_agent_id,
      turn_id: data.turn_id,
    },
  });
}

main().catch(() => process.exit(0));
