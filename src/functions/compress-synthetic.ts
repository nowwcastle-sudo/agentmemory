import type {
  RawObservation,
  CompressedObservation,
  ObservationType,
} from "../types.js";

// Zero-LLM compression path. Converts a RawObservation into a
// CompressedObservation using only heuristics — no Claude call, no token
// spend. This is the default as of 0.8.8 (#138); users who want richer
// LLM-generated summaries set AGENTMEMORY_AUTO_COMPRESS=true.

function inferType(
  toolName: string | undefined,
  hookType: string,
): ObservationType {
  if (hookType === "post_tool_failure") return "error";
  if (hookType === "prompt_submit") return "conversation";
  if (hookType === "subagent_stop" || hookType === "task_completed")
    return "subagent";
  if (hookType === "notification") return "notification";

  if (!toolName) return "other";
  // Normalize camelCase and kebab-case into word chunks so we can match
  // substrings like "WebFetch" -> "web" / "fetch".
  const n = toolName
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
  const hasWord = (word: string) =>
    new RegExp(`(^|_)${word}(_|$)`).test(n) ||
    n === word ||
    n.endsWith(word) ||
    n.startsWith(word);
  if (["fetch", "http", "web"].some(hasWord)) return "web_fetch";
  if (["grep", "search", "glob", "find"].some(hasWord)) return "search";
  if (["bash", "shell", "exec", "run"].some(hasWord)) return "command_run";
  if (["edit", "update", "patch", "replace"].some(hasWord)) return "file_edit";
  if (["write", "create"].some(hasWord)) return "file_write";
  if (["read", "view"].some(hasWord)) return "file_read";
  if (["task", "agent"].some(hasWord)) return "subagent";
  return "other";
}

function extractFiles(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const o = input as Record<string, unknown>;
  const out = new Set<string>();
  for (const key of [
    "file_path",
    "filepath",
    "path",
    "filePath",
    "file",
    "pattern",
  ]) {
    const v = o[key];
    if (typeof v === "string" && v.length > 0 && v.length < 512) out.add(v);
  }
  return [...out];
}

function stringifyForNarrative(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
}

// --- titles -----------------------------------------------------------
//
// Until 2026-09-11 the title was the tool name and nothing else, so 43% of
// what search returned on the live store was titled "Bash", "Read" or
// "prompt_submit" (65 of 150 top-10 rows over 15 queries). A title now says
// what the tool did, from its input: the command's description or first
// line, the file's last two path segments, the pattern and place, the
// prompt's first line. The harness's own compaction request, captured on
// prompt_submit, is named as such and ranked out of the way.

const TITLE_MAX = 80;

const firstLine = (s: string): string =>
  s
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? "";

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

const finishTitle = (s: string): string => truncate(oneLine(s), TITLE_MAX);

const lastSegments = (p: string, n = 2): string =>
  p.split(/[\\/]+/).filter((x) => x.length > 0).slice(-n).join("/");

/** "export X=1; cd /repo && npm test" -> "npm test": the prefix is plumbing. */
function stripShellPrefix(command: string): string {
  let c = command.trim();
  for (;;) {
    const next = c.replace(/^(?:export\s+\w+=\S*\s*;?\s*|cd\s+[^;&|]+?\s*(?:;|&&)\s*|set\s+-\w+\s*;?\s*)/, "");
    if (next === c) break;
    c = next;
  }
  return c;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v : undefined;

// Titles that are a tool or hook name and nothing else: what every synthetic
// row carried before 2026-09-11. Kept here (no imports) so ranking and the
// retitle pass can share it without a cycle through search.ts.
const BARE_TITLES = new Set([
  "bash", "read", "edit", "write", "grep", "glob", "powershell", "pwsh",
  "monitor", "agent", "skill", "todowrite", "webfetch", "websearch", "task",
  "notebookedit", "multiedit", "ls", "observation", "shell", "apply_patch",
  "prompt_submit", "post_tool_use", "pre_tool_use", "post_tool_failure",
  "session_start", "session_end", "stop", "subagent_stop", "subagent_start",
  "user_prompt_submit", "notification", "task_completed", "pre_compact",
  "post_compact", "assistant_response",
]);

// Hook names as a title prefix ("assistant_response: ## Session Summary")
// are still hook-name titles; a tool name as a prefix ("Bash: npm test") is
// the descriptive form and is not.
const HOOK_NAMES = new Set([
  "prompt_submit", "post_tool_use", "pre_tool_use", "post_tool_failure",
  "session_start", "session_end", "stop", "subagent_stop", "subagent_start",
  "user_prompt_submit", "notification", "task_completed", "pre_compact",
  "post_compact", "assistant_response",
]);

export function isBareTitle(title: string | undefined): boolean {
  const t = (title ?? "").trim();
  if (t.length <= 2) return true;
  const lower = t.toLowerCase();
  if (BARE_TITLES.has(lower)) return true;
  const colon = lower.indexOf(":");
  return colon > 0 && HOOK_NAMES.has(lower.slice(0, colon).trim());
}

/**
 * Task notifications, system notices and CI events reach the prompt hook as
 * if the user had typed them (this session: 220 of 2,656 observations).
 */
export function isHarnessNotice(text: string): boolean {
  return /^\s*(<task-notification>|\[SYSTEM NOTIFICATION|<system-reminder>|<ci-monitor-event>)/i.test(text);
}

function harnessNoticeTitle(text: string): string {
  const summary = /<summary>([\s\S]*?)<\/summary>/i.exec(text)?.[1];
  const line = summary ? oneLine(summary) : firstLine(text);
  return finishTitle(`Harness notice: ${line}`);
}

/** The harness asks for a compaction summary through the same prompt hook. */
export function isCompactionPrompt(text: string): boolean {
  const head = text.trim().slice(0, 400);
  if (head.length === 0) return false;
  return (
    /^Below is a conversation log from a .{0,40}session/i.test(head) ||
    /Create a summary to help the next session/i.test(head)
  );
}

export function synthesizeTitle(raw: RawObservation): string {
  const toolName = raw.toolName ?? raw.hookType;
  const input = (raw.toolInput && typeof raw.toolInput === "object" ? raw.toolInput : {}) as Record<string, unknown>;
  const data = (raw.raw && typeof raw.raw === "object" ? raw.raw : {}) as Record<string, unknown>;

  if (raw.hookType === "prompt_submit") {
    const prompt = raw.userPrompt ?? str(data["prompt"]) ?? "";
    if (isCompactionPrompt(prompt)) return "Auto-compact summary request";
    if (isHarnessNotice(prompt)) return harnessNoticeTitle(prompt);
    const line = firstLine(prompt).replace(/^[#>\-*\s]+/, "");
    return line ? finishTitle(`Prompt: ${line}`) : "Prompt";
  }
  if (raw.hookType === "subagent_stop" || raw.hookType === "task_completed") {
    const last = str(data["last_message"]) ?? str(data["result"]) ?? str(data["summary"]);
    const line = last ? firstLine(last) : "";
    if (line) return finishTitle(`Subagent: ${line}`);
    return toolName ? finishTitle(toolName) : "Subagent";
  }
  if (raw.hookType === "notification") {
    const message = str(data["message"]) ?? str(data["title"]);
    return message ? finishTitle(`Notification: ${firstLine(message)}`) : "Notification";
  }
  if (raw.hookType === "assistant_response" || (raw.toolName ?? "").toLowerCase() === "assistant_response") {
    // The compaction summary the harness writes arrives here too ("## Session
    // Summary"); its first heading is the right title.
    const text =
      raw.assistantResponse ??
      str(data["response"]) ??
      str(data["last_message"]) ??
      str(data["message"]) ??
      str(data["content"]) ??
      (typeof raw.toolOutput === "string" ? raw.toolOutput : undefined) ??
      "";
    const line = firstLine(text).replace(/^[#>\-*\s]+/, "");
    return line ? finishTitle(`Assistant: ${line}`) : "Assistant response";
  }

  const tool = toolName || "observation";
  const lower = tool.toLowerCase();
  const command = str(input["command"]);
  const description = str(input["description"]);
  const filePath =
    str(input["file_path"]) ?? str(input["filePath"]) ?? str(input["notebook_path"]) ?? str(input["path"]);

  if (command || /^(bash|powershell|pwsh|shell|sh|zsh|cmd|terminal|exec)$/.test(lower)) {
    if (description) return finishTitle(`${tool}: ${firstLine(description)}`);
    if (command) return finishTitle(`${tool}: ${firstLine(stripShellPrefix(command))}`);
  }
  if (/^(read|edit|write|multiedit|notebookedit|view|create)$/.test(lower) && filePath) {
    return finishTitle(`${tool} ${lastSegments(filePath)}`);
  }
  const pattern = str(input["pattern"]);
  if (lower === "grep" && pattern) {
    const place = str(input["path"]);
    return finishTitle(`Grep "${firstLine(pattern)}" in ${place ? lastSegments(place, 3) : "."}`);
  }
  if (lower === "glob" && pattern) return finishTitle(`Glob ${firstLine(pattern)}`);
  const url = str(input["url"]);
  if (/^(webfetch|fetch|web_fetch)$/.test(lower) && url) {
    try {
      const u = new URL(url);
      return finishTitle(`${tool} ${u.host}${u.pathname.replace(/\/$/, "")}`);
    } catch {
      return finishTitle(`${tool} ${url}`);
    }
  }
  const query = str(input["query"]);
  if (/^(websearch|web_search|search)$/.test(lower) && query) return finishTitle(`${tool} "${firstLine(query)}"`);
  if (description) return finishTitle(`${tool}: ${firstLine(description)}`);
  for (const key of ["title", "name", "query", "prompt", "text"]) {
    const v = str(input[key]);
    if (v) return finishTitle(`${tool}: ${firstLine(v)}`);
  }
  if (filePath) return finishTitle(`${tool} ${lastSegments(filePath)}`);
  const output = typeof raw.toolOutput === "string" ? firstLine(raw.toolOutput) : "";
  if (output) return finishTitle(`${tool}: ${output}`);
  return finishTitle(tool);
}

export function buildSyntheticCompression(
  raw: RawObservation,
): CompressedObservation {
  const toolName = raw.toolName ?? raw.hookType;
  const inputStr = stringifyForNarrative(raw.toolInput);
  const outputStr = stringifyForNarrative(raw.toolOutput);
  const promptStr = raw.userPrompt ?? "";

  const narrativeParts = [promptStr, inputStr, outputStr].filter(
    (s) => s.length > 0,
  );

  const result: CompressedObservation = {
    id: raw.id,
    sessionId: raw.sessionId,
    timestamp: raw.timestamp,
    type: inferType(toolName, raw.hookType),
    title: synthesizeTitle(raw),
    subtitle: inputStr ? truncate(inputStr, 120) : undefined,
    facts: [],
    narrative: truncate(narrativeParts.join(" | "), 400),
    concepts: [],
    files: extractFiles(raw.toolInput),
    // The harness's own compaction request is not the user's work: keep it
    // out of every "important observations" cut.
    importance:
      raw.hookType === "prompt_submit" && (isCompactionPrompt(promptStr) || isHarnessNotice(promptStr)) ? 1 : 5,
    confidence: 0.3,
  };
  if (raw.modality) result.modality = raw.modality;
  if (raw.imageData) result.imageData = raw.imageData;
  if (raw.agentId) result.agentId = raw.agentId;
  if (raw.sourceClient) result.sourceClient = raw.sourceClient;
  if (raw.projectId) result.projectId = raw.projectId;
  if (raw.projectName) result.projectName = raw.projectName;
  result.visibility = raw.visibility ?? "project";
  result.sourceKind = "observation";
  if (raw.origin) result.origin = raw.origin;
  return result;
}
