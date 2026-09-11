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

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
  return h;
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
  const delivery = defaultHookDelivery();
  const capturedAt = new Date().toISOString();

  await delivery.deliver("/agentmemory/observe", {
    captureId: stableHookCaptureId(
      sessionId,
      "pre_compact",
      hookEventLocator([data.turn_id], capturedAt),
    ),
    hookType: "pre_compact",
    sessionId,
    ...projectPayload,
    cwd,
    ...(typeof data.agent_id === "string" ? { agentId: data.agent_id } : {}),
    timestamp: capturedAt,
    data: {
      trigger: data.trigger,
      turn_id: data.turn_id,
    },
  });

  if (process.env["CLAUDE_MEMORY_BRIDGE"] === "true") {
    await delivery.deliver("/agentmemory/claude-bridge/sync", {});
  }

  try {
    const res = await fetch(`${REST_URL}/agentmemory/context`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ sessionId, project: projectPayload.project, budget: 1500 }),
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      const result = (await res.json()) as { context?: string };
      if (result.context) {
        process.stdout.write(result.context);
      }
    }
  } catch {
    // best effort -- don't block compaction
  }
}

main().catch(() => process.exit(0));
