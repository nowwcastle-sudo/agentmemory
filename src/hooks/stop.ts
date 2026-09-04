#!/usr/bin/env node
import { defaultHookDelivery, hookSessionId, stableHookCaptureId } from "./_delivery.js";
import { resolveProjectPayload, hookCwd } from "./_project.js";

// Inlined — see src/hooks/sdk-guard.ts for canonical version. Kept local
// per-hook so tsdown does not emit a shared hashed chunk that would churn
// the diff on every rebuild.
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
  if (isSdkChildContext(data)) {
    // Do not summarize from inside a Claude Agent SDK child session;
    // would re-enter agent-sdk provider and loop (see sdk-guard.ts).
    return;
  }

  const sessionId = hookSessionId(data);
  if (!sessionId) return;

  const assistantResponse = typeof data.last_assistant_message === "string"
    ? data.last_assistant_message.trim()
    : "";
  const cwd = hookCwd(data) || process.cwd();
  const delivery = defaultHookDelivery();
  if (assistantResponse) {
    await delivery.deliver("/agentmemory/observe", {
      captureId: stableHookCaptureId(
        sessionId,
        "assistant",
        data.turn_id ?? assistantResponse,
      ),
      hookType: "post_tool_use",
      sessionId,
      ...resolveProjectPayload(cwd),
      cwd,
      ...(typeof data.agent_id === "string" ? { agentId: data.agent_id } : {}),
      timestamp: new Date().toISOString(),
      data: {
        tool_name: "assistant_response",
        tool_input: { turn_id: data.turn_id },
        tool_output: assistantResponse,
      },
    });
  }

  // Stop fires once per agent turn. Checkpoint current work without marking
  // the session completed; a true SessionEnd uses session-end.ts.
  await delivery.deliver("/agentmemory/session/checkpoint", { sessionId });
}

main().catch(() => process.exit(0));
