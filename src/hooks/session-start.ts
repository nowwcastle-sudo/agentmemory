#!/usr/bin/env node
import { resolveProjectPayload, hookCwd } from "./_project.js";
import { createHookDelivery, hookSessionId } from "./_delivery.js";

// Inlined from ./sdk-guard so each hook bundles to a single self-contained
// .mjs (matches the pattern used by every other hook entry in tsdown.config).
function isSdkChildContext(payload: unknown): boolean {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (!payload || typeof payload !== "object") return false;
  return (payload as { entrypoint?: unknown }).entrypoint === "sdk-ts";
}

// Session-start hook.
//
// Always registers the session for observation tracking (so memories
// captured on PostToolUse get attached to the right session). Only writes
// project context to stdout — which Claude Code prepends to the very first
// turn — when AGENTMEMORY_INJECT_CONTEXT=true. Default off as of 0.8.10
// (#143); see pre-tool-use.ts for the full explanation.
const INJECT_CONTEXT = process.env["AGENTMEMORY_INJECT_CONTEXT"] === "true";

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";

// When the server is unreachable a 5s timeout multiplies hard under
// concurrent fan-out (Slack bots, multi-agent harnesses) and becomes a
// positive feedback loop that OOM-kills iii-engine (#221). Cap tight on
// both paths and skip the await entirely when the response is unused.
const INJECT_TIMEOUT_MS = 1500;
const REGISTER_TIMEOUT_MS = 800;

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
  return h;
}

function contextPayload(data: Record<string, unknown>, context: string): string {
  if (
    typeof data.cursor_version === "string" ||
    data.hook_event_name === "sessionStart"
  ) {
    return JSON.stringify({ additional_context: context });
  }
  if (process.env["DEVIN_PROJECT_DIR"] || data.prompt_id !== undefined) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
    });
  }
  return context;
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
  const projectPayload = resolveProjectPayload(cwd);
  const rawAgentId = data.agent_id ?? data.agentId;
  const agentId = typeof rawAgentId === "string" && rawAgentId.trim()
    ? rawAgentId.trim().slice(0, 128)
    : undefined;
  const startBody = {
    sessionId,
    ...projectPayload,
    cwd,
    ...(agentId ? { agentId } : {}),
    includeContext: false,
  };
  const delivery = createHookDelivery({ timeoutMs: REGISTER_TIMEOUT_MS });

  await delivery.deliver("/agentmemory/session/start", startBody);

  if (!INJECT_CONTEXT) {
    return;
  }

  try {
    const res = await fetch(`${REST_URL}/agentmemory/context`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        sessionId,
        project: projectPayload.project,
        ...(agentId ? { agentId } : {}),
      }),
      signal: AbortSignal.timeout(INJECT_TIMEOUT_MS),
    });
    if (!res.ok) return;
    try {
      const result = (await res.json()) as { context?: string };
      if (result.context) process.stdout.write(contextPayload(data, result.context));
    } catch {
      // Context injection is optional and must not block session capture.
    }
  } catch {
    // Context injection is optional and must not block session capture.
  }
}

main().catch(() => process.exit(0));
