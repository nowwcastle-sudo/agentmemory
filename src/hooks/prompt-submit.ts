#!/usr/bin/env node
import { resolveProjectPayload, hookCwd } from "./_project.js";
import { defaultHookDelivery, hookSessionId, stableHookCaptureId } from "./_delivery.js";
import { promptContextPayload, shouldInjectOnPrompt } from "./_prompt-context.js";

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
const INJECT_CONTEXT = process.env["AGENTMEMORY_INJECT_CONTEXT"] === "true";
// Same tight cap as the start-of-session inject: an unreachable server must
// not hold up the prompt.
const INJECT_TIMEOUT_MS = 1500;

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
  return h;
}

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
  // The prompt's locator must stay reproducible from the rollout file:
  // session-end reconciliation rebuilds it as `turn_id || message`
  // (codex-transcript.ts) to dedupe against the live capture. A capture-moment
  // fallback here would make every reconciled prompt a duplicate, so the
  // same text twice in one session without turn ids stays one capture.
  await defaultHookDelivery().deliver("/agentmemory/observe", {
    captureId: stableHookCaptureId(sessionId, "prompt", data.turn_id ?? prompt),
    hookType: "prompt_submit",
    sessionId,
    ...resolveProjectPayload(cwd),
    cwd,
    ...(typeof data.agent_id === "string" ? { agentId: data.agent_id } : {}),
    timestamp: capturedAt,
    data: { prompt },
  });

  // With the question in hand, ask memory again. The start-of-session inject
  // ran before this text existed, so it ranked past sessions by recency
  // alone: on the 30 recall items of 2026-09-20 that put the right summary in
  // front of the reader 6 times, against 21 when the question is known.
  if (!INJECT_CONTEXT) return;
  const project = resolveProjectPayload(cwd).project;
  if (typeof project !== "string" || !project) return;
  try {
    // By id, not by listing: asking for 200 rows and searching them missed
    // this very session on the live store, and missed it silently.
    const sessionRes = await fetch(
      `${REST_URL}/agentmemory/sessions?sessionId=${encodeURIComponent(sessionId)}`,
      { headers: authHeaders(), signal: AbortSignal.timeout(INJECT_TIMEOUT_MS) },
    );
    if (!sessionRes.ok) return;
    const sessions = ((await sessionRes.json()) as { sessions?: Array<{ id: string; observationCount?: number }> }).sessions ?? [];
    const row = sessions[0] ?? null;
    if (!shouldInjectOnPrompt(row, prompt)) return;
    const res = await fetch(`${REST_URL}/agentmemory/context`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, project, focusText: prompt }),
      signal: AbortSignal.timeout(INJECT_TIMEOUT_MS),
    });
    if (!res.ok) return;
    const result = (await res.json()) as { context?: string };
    if (result.context) process.stdout.write(promptContextPayload(result.context));
  } catch {
    // Context injection is optional and must not block prompt capture.
  }
}

main().catch(() => process.exit(0));
