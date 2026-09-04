import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMergedHooks, type HookManifest } from "../src/cli/connect/codex-hooks.js";
import { installStableHookBundle } from "../src/cli/connect/stable-hooks.js";

const roots: string[] = [];

function fixture(): {
  root: string;
  pluginRoot: string;
  stableRoot: string;
  sources: Record<string, string>;
} {
  const root = mkdtempSync(join(tmpdir(), "agentmemory-stable-hooks-"));
  roots.push(root);
  const pluginRoot = join(root, "package cache", "plugin");
  const stableRoot = join(root, "fresh home", ".agentmemory", "hooks", "current");
  mkdirSync(join(pluginRoot, "hooks"), { recursive: true });
  mkdirSync(join(pluginRoot, "scripts"), { recursive: true });
  const sources = {
    "session-start.mjs": "process.stdout.write('session-start')\n",
    "post-tool-use.mjs": "process.stdout.write('post-tool-use')\n",
  };
  for (const [name, source] of Object.entries(sources)) {
    writeFileSync(join(pluginRoot, "scripts", name), source, "utf-8");
  }
  writeFileSync(
    join(pluginRoot, "hooks", "hooks.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [{
          hooks: [{
            type: "command",
            command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs"',
          }],
        }],
      },
    }),
    "utf-8",
  );
  writeFileSync(
    join(pluginRoot, "hooks", "hooks.codex.json"),
    JSON.stringify({
      hooks: {
        PostToolUse: [{
          hooks: [{
            type: "command",
            command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/post-tool-use.mjs"',
          }],
        }],
      },
    }),
    "utf-8",
  );
  return { root, pluginRoot, stableRoot, sources };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("stable hook bundle", () => {
  it("copies only manifest-referenced scripts directly into the stable root and verifies hashes", () => {
    const { pluginRoot, stableRoot, sources } = fixture();
    const bundle = installStableHookBundle(pluginRoot, stableRoot, [
      "hooks.json",
      "hooks.codex.json",
    ]);

    expect(bundle.root).toBe(stableRoot);
    expect(bundle.files.sort()).toEqual([
      "post-tool-use.mjs",
      "session-start.mjs",
    ]);
    for (const [name, source] of Object.entries(sources)) {
      expect(readFileSync(join(stableRoot, name), "utf-8")).toBe(source);
      expect(bundle.hashes[name]).toBe(
        createHash("sha256").update(source).digest("hex"),
      );
    }
  });

  it("plans a dry-run without creating the stable root", () => {
    const { pluginRoot, stableRoot } = fixture();
    const bundle = installStableHookBundle(
      pluginRoot,
      stableRoot,
      ["hooks.json", "hooks.codex.json"],
      { dryRun: true },
    );

    expect(bundle.files).toHaveLength(2);
    expect(existsSync(stableRoot)).toBe(false);
  });

  it("rejects traversal outside the package scripts directory", () => {
    const { pluginRoot, stableRoot } = fixture();
    writeFileSync(
      join(pluginRoot, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{
            hooks: [{
              type: "command",
              command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/../secret.mjs"',
            }],
          }],
        },
      }),
      "utf-8",
    );

    expect(() =>
      installStableHookBundle(pluginRoot, stableRoot, ["hooks.json"])
    ).toThrow("unsafe hook script path");
    expect(existsSync(stableRoot)).toBe(false);
  });

  it("merges commands against the stable root and removes only managed legacy entries", () => {
    const { pluginRoot, stableRoot } = fixture();
    installStableHookBundle(pluginRoot, stableRoot, ["hooks.codex.json"]);
    const existing: HookManifest = {
      hooks: {
        PostToolUse: [
          { hooks: [{ type: "command", command: "node unrelated.mjs" }] },
          {
            hooks: [{
              type: "command",
              command: `node "${join(pluginRoot, "scripts", "old.mjs")}"`,
            }],
          },
          {
            hooks: [{
              type: "command",
              command: `node "${join(stableRoot, "old.mjs")}"`,
            }],
          },
        ],
      },
    };

    const merged = buildMergedHooks(
      existing,
      pluginRoot,
      "hooks.codex.json",
      [join(pluginRoot, "scripts"), stableRoot],
      stableRoot,
    );
    const serialized = JSON.stringify(merged);
    expect(serialized).not.toContain(pluginRoot);
    expect(serialized).toContain(stableRoot.replace(/\\/g, "\\\\"));
    expect(serialized).toContain("unrelated.mjs");
    expect(serialized).not.toContain("old.mjs");
  });

  it("starts every real stable entrypoint after the copied package source is removed", () => {
    const root = mkdtempSync(join(tmpdir(), "agentmemory-stable-real-"));
    roots.push(root);
    const sourcePlugin = resolve(__dirname, "..", "plugin");
    const copiedPlugin = join(root, "npm cache", "plugin");
    const removedPlugin = join(root, "npm cache", "plugin-removed");
    const home = join(root, "fresh home");
    const stableRoot = join(home, ".agentmemory", "hooks", "current");
    cpSync(sourcePlugin, copiedPlugin, { recursive: true });
    const bundle = installStableHookBundle(copiedPlugin, stableRoot, [
      "hooks.json",
      "hooks.codex.json",
    ]);
    renameSync(copiedPlugin, removedPlugin);

    const payload = JSON.stringify({
      session_id: "stable-cache-test",
      cwd: root,
      prompt: "stable hook canary",
      tool_name: "Read",
      tool_input: { file_path: join(root, "sample.txt") },
      tool_response: {},
      reason: "test",
    });
    const safeEnv: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      TEMP: process.env["TEMP"],
      TMP: process.env["TMP"],
      SystemRoot: process.env["SystemRoot"],
      ComSpec: process.env["ComSpec"],
      PATH: process.env["PATH"],
      AGENTMEMORY_URL: "http://127.0.0.1:1",
      AGENTMEMORY_OUTBOX_DIR: join(home, ".agentmemory", "outbox", "codex"),
    };

    for (const name of bundle.files) {
      const result = spawnSync(process.execPath, [join(stableRoot, name)], {
        input: payload,
        encoding: "utf-8",
        env: safeEnv,
        shell: false,
        windowsHide: true,
        timeout: 15000,
      });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      expect(result.error?.message ?? "", name).not.toContain("ETIMEDOUT");
      expect(output, name).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/);
    }
  }, 120_000);
});
