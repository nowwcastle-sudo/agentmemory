import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildMergedHooks,
  findPluginRoot,
  type HookManifest,
} from "../src/cli/connect/codex-hooks.js";

const PLUGIN_ROOT = resolve(__dirname, "..", "plugin");

describe("buildMergedHooks against plugin/hooks/hooks.json (Claude Code)", () => {
  it("locates the same plugin root used by the codex variant", () => {
    expect(findPluginRoot()).toBe(PLUGIN_ROOT);
  });

  it("rewrites ${CLAUDE_PLUGIN_ROOT} to absolute pluginRoot in every command", () => {
    const merged = buildMergedHooks(null, PLUGIN_ROOT, "hooks.json");
    for (const entries of Object.values(merged.hooks)) {
      for (const entry of entries) {
        for (const handler of entry.hooks) {
          expect(handler.command).not.toContain("${CLAUDE_PLUGIN_ROOT}");
          expect(handler.command).toContain(`${PLUGIN_ROOT}/scripts/`);
        }
      }
    }
  });

  it("stamps every AgentMemory hook as Claude Code provenance", () => {
    const merged = buildMergedHooks(null, PLUGIN_ROOT, "hooks.json");
    for (const entries of Object.values(merged.hooks)) {
      for (const entry of entries) {
        for (const handler of entry.hooks) {
          expect(handler.command).toContain("--source-client claude-code");
        }
      }
    }
  });

  it("includes Claude-only events that hooks.codex.json omits", () => {
    const merged = buildMergedHooks(null, PLUGIN_ROOT, "hooks.json");
    const events = Object.keys(merged.hooks);
    expect(events).toContain("SessionStart");
    expect(events).toContain("Stop");
    const claudeOnly = ["SessionEnd", "SubagentStop", "Notification"];
    expect(
      claudeOnly.some((e) => events.includes(e)),
      `hooks.json should include at least one Claude-only event (${claudeOnly.join(", ")})`,
    ).toBe(true);
  });

  it("appends to existing user hooks without dropping them", () => {
    const existing: HookManifest = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "echo user-custom-claude" }] },
        ],
      },
    };
    const merged = buildMergedHooks(existing, PLUGIN_ROOT, "hooks.json");
    const sessionStart = merged.hooks["SessionStart"]!;
    expect(
      sessionStart.some((e) =>
        e.hooks.some((h) => h.command === "echo user-custom-claude"),
      ),
    ).toBe(true);
    expect(
      sessionStart.some((e) =>
        e.hooks.some((h) =>
          h.command.includes(`${PLUGIN_ROOT}/scripts/session-start.mjs`),
        ),
      ),
    ).toBe(true);
  });

  it("re-install strips previous agentmemory entries (idempotent)", () => {
    const first = buildMergedHooks(null, PLUGIN_ROOT, "hooks.json");
    const second = buildMergedHooks(first, PLUGIN_ROOT, "hooks.json");
    for (const event of Object.keys(first.hooks)) {
      expect(
        second.hooks[event]!.length,
        `${event} should not double after second install`,
      ).toBe(first.hooks[event]!.length);
    }
  });
});

describe("Claude Code adapter stable hook fallback", () => {
  let home: string;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;
  let originalClaudeConfigDir: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agentmemory-claude-stable-"));
    originalHome = process.env["HOME"];
    originalUserprofile = process.env["USERPROFILE"];
    originalClaudeConfigDir = process.env["CLAUDE_CONFIG_DIR"];
    process.env["HOME"] = home;
    process.env["USERPROFILE"] = home;
    delete process.env["CLAUDE_CONFIG_DIR"];
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    if (originalUserprofile === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = originalUserprofile;
    if (originalClaudeConfigDir === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
    else process.env["CLAUDE_CONFIG_DIR"] = originalClaudeConfigDir;
    rmSync(home, { recursive: true, force: true });
    vi.resetModules();
  });

  it("writes only stable user-scope hook commands with verified files", async () => {
    const { adapter } = await import("../src/cli/connect/claude-code.js?stable=" + Date.now());
    const result = await adapter.install({
      dryRun: false,
      force: false,
      withHooks: true,
      guidelines: false,
    });
    expect(result.kind).toBe("installed");

    const stableRoot = join(home, ".agentmemory", "hooks", "current");
    const settings = JSON.parse(
      readFileSync(join(home, ".claude", "settings.json"), "utf-8"),
    ) as HookManifest;
    const commands = Object.values(settings.hooks)
      .flatMap((entries) => entries)
      .flatMap((entry) => entry.hooks)
      .map((handler) => handler.command);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toContain(stableRoot);
      expect(command).not.toContain(PLUGIN_ROOT);
      const referenced = command.match(/node "([^"]+)"/)?.[1];
      expect(referenced).toBeDefined();
      expect(existsSync(referenced!)).toBe(true);
    }
  });

  it("writes MCP state and hook settings only under CLAUDE_CONFIG_DIR", async () => {
    const customRoot = join(home, "contained-claude-config");
    process.env["CLAUDE_CONFIG_DIR"] = customRoot;
    vi.resetModules();
    const { adapter } = await import(
      "../src/cli/connect/claude-code.js?custom-root=" + Date.now()
    );

    const result = await adapter.install({
      dryRun: false,
      force: false,
      withHooks: true,
      guidelines: false,
    });

    expect(result.kind).toBe("installed");
    expect(result.mutatedPath).toBe(join(customRoot, ".claude.json"));
    expect(existsSync(join(customRoot, ".claude.json"))).toBe(true);
    expect(existsSync(join(customRoot, "settings.json"))).toBe(true);
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  });
});
