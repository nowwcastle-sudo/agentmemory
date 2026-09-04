import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { existsSync, writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  buildMergedHooks,
  findPluginRoot,
  type HookManifest,
} from "../src/cli/connect/codex-hooks.js";

const PLUGIN_ROOT = resolve(__dirname, "..", "plugin");

describe("findPluginRoot", () => {
  it("locates the bundled plugin/ directory from src/cli/connect/", () => {
    const root = findPluginRoot();
    expect(root).toBe(PLUGIN_ROOT);
  });
});

describe("buildMergedHooks", () => {
  it("rewrites ${CLAUDE_PLUGIN_ROOT} to absolute pluginRoot in every command", () => {
    const merged = buildMergedHooks(null, PLUGIN_ROOT);
    for (const entries of Object.values(merged.hooks)) {
      for (const entry of entries) {
        for (const handler of entry.hooks) {
          expect(handler.command).not.toContain("${CLAUDE_PLUGIN_ROOT}");
          expect(handler.command).toContain(`${PLUGIN_ROOT}/scripts/`);
        }
      }
    }
  });

  it("stamps every AgentMemory hook as Codex provenance", () => {
    const merged = buildMergedHooks(null, PLUGIN_ROOT);
    for (const entries of Object.values(merged.hooks)) {
      for (const entry of entries) {
        for (const handler of entry.hooks) {
          expect(handler.command).toContain("--source-client codex");
        }
      }
    }
  });

  it("preserves matchers from the bundled manifest (e.g. PreToolUse)", () => {
    const merged = buildMergedHooks(null, PLUGIN_ROOT);
    const preToolUse = merged.hooks["PreToolUse"];
    expect(preToolUse).toBeDefined();
    expect(preToolUse!.length).toBeGreaterThan(0);
    expect(preToolUse![0].matcher).toBe("Edit|Write|Read|Glob|Grep");
  });

  it("includes the complete current Codex hook event set", () => {
    const merged = buildMergedHooks(null, PLUGIN_ROOT);
    for (const event of [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PermissionRequest",
      "PreCompact",
      "PostCompact",
      "SessionEnd",
      "SubagentStart",
      "SubagentStop",
      "Stop",
      "Interrupt",
    ]) {
      expect(Object.keys(merged.hooks)).toContain(event);
    }
  });

  it("appends to existing user hooks without dropping them", () => {
    const existing: HookManifest = {
      hooks: {
        SessionStart: [
          {
            hooks: [{ type: "command", command: "echo user-custom" }],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [{ type: "command", command: "echo another-user-hook" }],
          },
        ],
      },
    };
    const merged = buildMergedHooks(existing, PLUGIN_ROOT);
    const sessionStart = merged.hooks["SessionStart"]!;
    const userHook = sessionStart.find((e) =>
      e.hooks.some((h) => h.command === "echo user-custom"),
    );
    expect(userHook, "user's SessionStart hook should survive").toBeDefined();
    const ours = sessionStart.find((e) =>
      e.hooks.some((h) => h.command.includes(`${PLUGIN_ROOT}/scripts/session-start.mjs`)),
    );
    expect(ours, "agentmemory SessionStart hook should be appended").toBeDefined();
  });

  it("re-install strips previous agentmemory entries (idempotent by script path)", () => {
    const first = buildMergedHooks(null, PLUGIN_ROOT);
    const second = buildMergedHooks(first, PLUGIN_ROOT);
    for (const event of Object.keys(first.hooks)) {
      expect(
        second.hooks[event]!.length,
        `${event} should not double after second install`,
      ).toBe(first.hooks[event]!.length);
    }
  });

  it("re-install preserves unrelated user entries", () => {
    const userEntry = {
      hooks: [{ type: "command", command: "echo user-untouchable" }],
    };
    const withUser: HookManifest = {
      hooks: {
        SessionStart: [userEntry],
        Stop: [{ hooks: [{ type: "command", command: "echo also-user" }] }],
      },
    };
    const installed = buildMergedHooks(withUser, PLUGIN_ROOT);
    const reinstalled = buildMergedHooks(installed, PLUGIN_ROOT);
    expect(
      reinstalled.hooks["SessionStart"]!.some((e) =>
        e.hooks.some((h) => h.command === "echo user-untouchable"),
      ),
    ).toBe(true);
    expect(
      reinstalled.hooks["Stop"]!.some((e) =>
        e.hooks.some((h) => h.command === "echo also-user"),
      ),
    ).toBe(true);
  });

  it("handles empty existing manifest object", () => {
    const merged = buildMergedHooks({ hooks: {} }, PLUGIN_ROOT);
    expect(Object.keys(merged.hooks).length).toBeGreaterThan(0);
  });
});

describe("buildMergedHooks file round-trip", () => {
  it("produces JSON that parses back to a structurally equivalent manifest", () => {
    const dir = join(tmpdir(), `agentmemory-codex-hooks-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "hooks.json");
    try {
      const merged = buildMergedHooks(null, PLUGIN_ROOT);
      writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
      const reread = JSON.parse(readFileSync(path, "utf-8")) as HookManifest;
      expect(Object.keys(reread.hooks).sort()).toEqual(Object.keys(merged.hooks).sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Codex adapter stable hook fallback", () => {
  let home: string;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agentmemory-codex-stable-"));
    originalHome = process.env["HOME"];
    originalUserprofile = process.env["USERPROFILE"];
    process.env["HOME"] = home;
    process.env["USERPROFILE"] = home;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    if (originalUserprofile === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = originalUserprofile;
    rmSync(home, { recursive: true, force: true });
    vi.resetModules();
  });

  it("writes only stable user-scope paths and refreshes them when MCP is already wired", async () => {
    const { adapter } = await import("../src/cli/connect/codex.js?stable=" + Date.now());
    const first = await adapter.install({
      dryRun: false,
      force: false,
      withHooks: true,
      guidelines: false,
    });
    expect(first.kind).toBe("installed");

    const stableRoot = join(home, ".agentmemory", "hooks", "current");
    const hooksPath = join(home, ".codex", "hooks.json");
    const hooks = JSON.parse(readFileSync(hooksPath, "utf-8")) as HookManifest;
    const commands = Object.values(hooks.hooks)
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

    const removed = commands[0]!.match(/node "([^"]+)"/)![1]!;
    rmSync(removed, { force: true });
    const second = await adapter.install({
      dryRun: false,
      force: false,
      withHooks: true,
      guidelines: false,
    });
    expect(second.kind).toBe("already-wired");
    expect(existsSync(removed)).toBe(true);
  });
});
