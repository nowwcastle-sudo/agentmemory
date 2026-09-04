import type { HookType, RawObservation } from "../types.js";
import { generateId } from "../state/schema.js";
import { resolveProjectIdentity } from "../hooks/_project.js";

interface JsonlEntry {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  toolUseResult?: unknown;
  [k: string]: unknown;
}

export interface ParsedTranscript {
  sessionId: string;
  project: string;
  projectName: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  observations: RawObservation[];
}

// Memoized per import run: transcripts repeat the same cwd on every line.
const projectByCwd = new Map<string, { project: string; projectName: string }>();

function deriveProject(cwd: string): { project: string; projectName: string } {
  if (!cwd) return { project: "unknown", projectName: "unknown" };
  const cached = projectByCwd.get(cwd);
  if (cached) return cached;
  // A bulk import spans projects, so the process-wide explicit override must
  // not relabel every transcript. The resolver still applies the same remote,
  // common-dir, and path hashing rules as live hooks.
  const identity = resolveProjectIdentity(cwd, { useEnvOverride: false });
  const project = {
    project: identity.projectId,
    projectName: identity.projectName,
  };
  projectByCwd.set(cwd, project);
  return project;
}

function toText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry.type === "text" && typeof entry.text === "string") {
      parts.push(entry.text);
    }
  }
  return parts.join("\n");
}

function extractToolUses(content: unknown): Array<{ id: string; name: string; input: unknown }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; name: string; input: unknown }> = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry.type === "tool_use") {
      out.push({
        id: typeof entry.id === "string" ? entry.id : "",
        name: typeof entry.name === "string" ? entry.name : "unknown",
        input: entry.input,
      });
    }
  }
  return out;
}

function extractToolResults(content: unknown): Array<{ toolUseId: string; output: unknown; isError: boolean }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ toolUseId: string; output: unknown; isError: boolean }> = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry.type === "tool_result") {
      out.push({
        toolUseId: typeof entry.tool_use_id === "string" ? entry.tool_use_id : "",
        output: entry.content,
        isError: entry.is_error === true,
      });
    }
  }
  return out;
}

export function parseJsonlText(text: string, fallbackSessionId?: string): ParsedTranscript {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const entries: JsonlEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") entries.push(parsed as JsonlEntry);
    } catch {
      // skip malformed lines
    }
  }

  let sessionId = "";
  let cwd = "";
  let firstTs = "";
  let lastTs = "";

  const observations: RawObservation[] = [];

  for (const entry of entries) {
    if (entry.sessionId && !sessionId) sessionId = entry.sessionId;
    if (typeof entry.cwd === "string" && entry.cwd.trim() && !cwd) cwd = entry.cwd;
    const ts = entry.timestamp || new Date().toISOString();
    if (!firstTs) firstTs = ts;
    lastTs = ts;

    const role = entry.message?.role;
    const content = entry.message?.content;

    if (entry.type === "user" && role === "user") {
      const toolResults = extractToolResults(content);
      if (toolResults.length > 0) {
        for (const result of toolResults) {
          observations.push({
            id: generateId("obs"),
            sessionId: sessionId || "imported",
            timestamp: ts,
            hookType: (result.isError ? "post_tool_failure" : "post_tool_use") as HookType,
            toolName: undefined,
            toolInput: { toolUseId: result.toolUseId },
            toolOutput: result.output,
            raw: entry,
          });
        }
      } else {
        const text = toText(content);
        if (text.trim().length > 0) {
          observations.push({
            id: generateId("obs"),
            sessionId: sessionId || "imported",
            timestamp: ts,
            hookType: "prompt_submit" as HookType,
            userPrompt: text,
            raw: entry,
          });
        }
      }
    } else if (entry.type === "assistant" && role === "assistant") {
      const text = toText(content);
      const tools = extractToolUses(content);
      if (text.trim().length > 0) {
        observations.push({
          id: generateId("obs"),
          sessionId: sessionId || "imported",
          timestamp: ts,
          hookType: "stop" as HookType,
          assistantResponse: text,
          raw: entry,
        });
      }
      for (const tool of tools) {
        observations.push({
          id: generateId("obs"),
          sessionId: sessionId || "imported",
          timestamp: ts,
          hookType: "pre_tool_use" as HookType,
          toolName: tool.name,
          toolInput: tool.input,
          raw: { toolUseId: tool.id, entry },
        });
      }
    } else if (entry.type === "summary" || entry.type === "system") {
      // ignore meta entries
    }
  }

  const effectiveSessionId = sessionId || fallbackSessionId || generateId("sess");
  for (const obs of observations) {
    if (obs.sessionId === "imported") obs.sessionId = effectiveSessionId;
  }

  const nowIso = new Date().toISOString();
  const projectIdentity = deriveProject(cwd);
  return {
    sessionId: effectiveSessionId,
    ...projectIdentity,
    cwd: cwd || process.cwd(),
    startedAt: firstTs || nowIso,
    endedAt: lastTs || nowIso,
    observations,
  };
}
