import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadClaudeBridgeConfig } from "../src/config.js";

// bridge path must match Claude Code's slug convention exactly:
//   ~/.claude/projects/<slug>/memory/MEMORY.md
// where <slug> replaces every / and \ with - and KEEPS any leading -.
// The memory/ subdirectory holds MEMORY.md (the index) plus per-topic
// .md files — this is where Claude Code 2.x actually reads/writes.
describe("loadClaudeBridgeConfig path (#625)", () => {
  const ORIG_ENV = { ...process.env };
  beforeEach(() => {
    delete process.env["CLAUDE_MEMORY_BRIDGE"];
    delete process.env["CLAUDE_PROJECT_PATH"];
    delete process.env["CLAUDE_MEMORY_LINE_BUDGET"];
    delete process.env["CLAUDE_CONFIG_DIR"];
    delete process.env["AGENTMEMORY_PROJECT_NAME"];
  });
  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  it("preserves leading - on POSIX absolute paths", () => {
    process.env["CLAUDE_MEMORY_BRIDGE"] = "true";
    process.env["CLAUDE_PROJECT_PATH"] = "/home/user/repos/my-project";
    const cfg = loadClaudeBridgeConfig();
    expect(cfg.memoryFilePath).toBe(
      join(homedir(), ".claude", "projects", "-home-user-repos-my-project", "memory", "MEMORY.md"),
    );
  });

  it("writes MEMORY.md inside the memory/ subdir under the slug dir", () => {
    process.env["CLAUDE_MEMORY_BRIDGE"] = "true";
    process.env["CLAUDE_PROJECT_PATH"] = "/Users/x/agentmemory";
    const cfg = loadClaudeBridgeConfig();
    expect(cfg.memoryFilePath).toMatch(/-Users-x-agentmemory[/\\]memory[/\\]MEMORY\.md$/);
  });

  it("returns empty memoryFilePath when bridge disabled", () => {
    const cfg = loadClaudeBridgeConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.memoryFilePath).toBe("");
  });

  it("returns empty memoryFilePath when project path unset", () => {
    process.env["CLAUDE_MEMORY_BRIDGE"] = "true";
    const cfg = loadClaudeBridgeConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.memoryFilePath).toBe("");
  });

  it("handles Windows-style backslash paths by swapping to -", () => {
    process.env["CLAUDE_MEMORY_BRIDGE"] = "true";
    process.env["CLAUDE_PROJECT_PATH"] = "C:\\Users\\x\\project";
    const cfg = loadClaudeBridgeConfig();
    expect(cfg.memoryFilePath).toMatch(/C--Users-x-project[/\\]memory[/\\]MEMORY\.md$/);
  });

  it("uses the custom Claude configuration root and canonical project override", () => {
    const customRoot = join(homedir(), "contained-claude-config");
    process.env["CLAUDE_MEMORY_BRIDGE"] = "true";
    process.env["CLAUDE_PROJECT_PATH"] = "D:\\contained\\bridge-project";
    process.env["CLAUDE_CONFIG_DIR"] = customRoot;
    process.env["AGENTMEMORY_PROJECT_NAME"] = "capability-cohort-bridge";

    const cfg = loadClaudeBridgeConfig();

    expect(cfg.projectId).toBe("capability-cohort-bridge");
    expect(cfg.legacyProjectIds).toEqual([]);
    expect(cfg.memoryFilePath).toBe(
      join(
        customRoot,
        "projects",
        "D--contained-bridge-project",
        "memory",
        "MEMORY.md",
      ),
    );
  });
});
