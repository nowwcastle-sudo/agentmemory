import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentProbe } from "../src/cli/connect/types.js";
import { probeExecutable } from "../src/cli/connect/probe.js";
import { probeHermes } from "../src/cli/connect/hermes.js";

const sandboxes: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "am-connect-probe-"));
  sandboxes.push(dir);
  return dir;
}

function executable(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, "placeholder", "utf-8");
  return path;
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("connect executable probe", () => {
  it("exposes the staged AgentProbe contract", () => {
    const probe: AgentProbe = {
      presence: "absent",
      usable: false,
      wiring: "unknown",
      activation: "not-checked",
      durability: "not-checked",
    };
    expect(probe.presence).toBe("absent");
  });

  it("reports absent when PATH has no matching exact file", () => {
    const dir = sandbox();
    expect(
      probeExecutable(["claude"], {
        env: { PATH: dir, PATHEXT: ".EXE;.CMD" },
        platform: "win32",
        spawn: vi.fn() as never,
      }),
    ).toMatchObject({
      presence: "absent",
      usable: false,
      reason: "executable-not-found",
    });
  });

  it("calls the absolute executable without a shell and keeps one version line", () => {
    const dir = sandbox();
    const path = executable(dir, "claude.EXE");
    const spawn = vi.fn(() => ({
      status: 0,
      stdout: "Claude Code 2.1.241\nextra line\n",
      stderr: "",
    }));

    const result = probeExecutable(["claude"], {
      env: { PATH: dir, PATHEXT: ".EXE;.CMD" },
      platform: "win32",
      spawn: spawn as never,
    });

    expect(result).toMatchObject({
      presence: "executable",
      usable: true,
      executablePath: path,
      version: "Claude Code 2.1.241",
    });
    expect(spawn).toHaveBeenCalledWith(path, ["--version"], {
      shell: false,
      windowsHide: true,
      encoding: "utf-8",
      timeout: 5000,
    });
  });

  it("finds an exact executable without starting it for a dry-run probe", () => {
    const dir = sandbox();
    const path = executable(dir, "hermes.EXE");
    const spawn = vi.fn(() => {
      throw new Error("dry-run probe must not start the external CLI");
    });

    const result = probeExecutable(["hermes"], {
      env: { PATH: dir, PATHEXT: ".EXE" },
      platform: "win32",
      spawn: spawn as never,
      executeVersion: false,
    });

    expect(result).toMatchObject({
      presence: "executable",
      usable: true,
      executablePath: path,
    });
    expect(result.version).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("continues past an unusable shim to a later executable", () => {
    const first = sandbox();
    const second = sandbox();
    const shim = executable(first, "codex.CMD");
    const binary = executable(second, "codex.EXE");
    const spawn = vi.fn((path: string) =>
      path === shim
        ? { status: null, stdout: "", stderr: "", error: new Error("spawn failed") }
        : { status: 0, stdout: "codex-cli 0.150.1\n", stderr: "" },
    );

    const result = probeExecutable(["codex"], {
      env: { PATH: `${first};${second}`, PATHEXT: ".EXE;.CMD" },
      platform: "win32",
      spawn: spawn as never,
    });

    expect(result).toMatchObject({
      usable: true,
      executablePath: binary,
      version: "codex-cli 0.150.1",
    });
  });

  it("reports a found executable that exits non-zero as unusable", () => {
    const dir = sandbox();
    const path = executable(dir, "hermes.EXE");
    const result = probeExecutable(["hermes"], {
      env: { PATH: dir, PATHEXT: ".EXE" },
      platform: "win32",
      spawn: vi.fn(() => ({ status: 7, stdout: "", stderr: "bad" })) as never,
    });

    expect(result).toMatchObject({
      presence: "executable",
      usable: false,
      executablePath: path,
      reason: "version-exit-7",
    });
  });

  it("reports a bounded version timeout without output content", () => {
    const dir = sandbox();
    const path = executable(dir, "claude.EXE");
    const timeout = Object.assign(new Error("timed out with environment details"), {
      code: "ETIMEDOUT",
    });
    const result = probeExecutable(["claude"], {
      env: { PATH: dir, PATHEXT: ".EXE" },
      platform: "win32",
      spawn: vi.fn(() => ({ status: null, stdout: "", stderr: "", error: timeout })) as never,
      timeoutMs: 25,
    });

    expect(result).toMatchObject({
      presence: "executable",
      usable: false,
      executablePath: path,
      reason: "version-timeout",
    });
    expect(result.reason).not.toContain("environment details");
  });

  it("gives the measured slow-start Hermes executable a bounded 15 second probe", () => {
    const dir = sandbox();
    const path = executable(dir, "hermes.EXE");
    const spawn = vi.fn(() => ({
      status: 0,
      stdout: "Hermes Agent v0.20.5\n",
      stderr: "",
    }));

    const result = probeHermes({
      env: {
        PATH: dir,
        PATHEXT: ".EXE",
        HERMES_HOME: join(dir, "Hermes Home"),
      },
      platform: "win32",
      spawn: spawn as never,
    });

    expect(result.usable).toBe(true);
    expect(spawn).toHaveBeenCalledWith(path, ["--version"], {
      shell: false,
      windowsHide: true,
      encoding: "utf-8",
      timeout: 15_000,
    });
  });

  it("classifies a config directory without an executable as config-only", async () => {
    const home = sandbox();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const previous = {
      HOME: process.env["HOME"],
      USERPROFILE: process.env["USERPROFILE"],
      PATH: process.env["PATH"],
    };
    process.env["HOME"] = home;
    process.env["USERPROFILE"] = home;
    process.env["PATH"] = "";
    vi.resetModules();
    try {
      const { adapter } = await import("../src/cli/connect/claude-code.js?probe=" + Date.now());
      expect(adapter.probe?.()).toMatchObject({
        presence: "config-only",
        usable: false,
        configPath: join(home, ".claude.json"),
        wiring: "unwired",
        activation: "not-checked",
        durability: "not-checked",
        reason: "executable-not-found",
      });
      expect(adapter.detect()).toBe(false);
    } finally {
      if (previous.HOME === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previous.HOME;
      if (previous.USERPROFILE === undefined) delete process.env["USERPROFILE"];
      else process.env["USERPROFILE"] = previous.USERPROFILE;
      if (previous.PATH === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previous.PATH;
    }
  });
});
