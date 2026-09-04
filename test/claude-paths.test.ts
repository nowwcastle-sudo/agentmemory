import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  resolveClaudeConfigDir,
  resolveClaudeDebugDir,
  resolveClaudeProjectsDir,
  toClaudeProjectSlug,
  resolveClaudeStateFile,
} from "../src/claude-paths.js";

describe("Claude Code path resolution", () => {
  const home = "D:\\synthetic-home";
  const customRoot = "D:\\contained\\claude-config";

  it("derives settings, project sessions, debug logs, and state from CLAUDE_CONFIG_DIR", () => {
    const env = { CLAUDE_CONFIG_DIR: customRoot };

    expect(resolveClaudeConfigDir(env, home)).toBe(customRoot);
    expect(resolveClaudeProjectsDir(env, home)).toBe(join(customRoot, "projects"));
    expect(resolveClaudeDebugDir(env, home)).toBe(join(customRoot, "debug"));
    expect(resolveClaudeStateFile(env, home)).toBe(join(customRoot, ".claude.json"));
  });

  it("preserves Claude Code's asymmetric legacy defaults when no override exists", () => {
    expect(resolveClaudeConfigDir({}, home)).toBe(join(home, ".claude"));
    expect(resolveClaudeProjectsDir({}, home)).toBe(join(home, ".claude", "projects"));
    expect(resolveClaudeDebugDir({}, home)).toBe(join(home, ".claude", "debug"));
    expect(resolveClaudeStateFile({}, home)).toBe(join(home, ".claude.json"));
  });

  it("matches observed Windows project slugs by replacing drive colons and separators", () => {
    expect(toClaudeProjectSlug("D:\\AGENTMEMORY_FOR_ME\\repo")).toBe(
      "D--AGENTMEMORY_FOR_ME-repo",
    );
    expect(toClaudeProjectSlug("/home/user/repo")).toBe("-home-user-repo");
  });
});
