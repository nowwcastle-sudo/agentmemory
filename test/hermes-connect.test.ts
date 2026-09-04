import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installHermesIntegration,
  resolveHermesConfigPath,
  type HermesCommandRunner,
} from "../src/cli/connect/hermes.js";

const roots: string[] = [];
let originalAgentMemoryHome: string | undefined;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fakeRunner(
  configPath: string,
  options: { badArgsReadback?: boolean } = {},
): { calls: string[][]; run: HermesCommandRunner } {
  const calls: string[][] = [];
  const values = new Map<string, unknown>();
  return {
    calls,
    run: (_executablePath, args) => {
      calls.push([...args]);
      if (args.join(" ") === "config path") {
        return { status: 0, stdout: `${configPath}\n`, stderr: "" };
      }
      if (args[0] === "plugins" && args[1] === "doctor") {
        return { status: 0, stdout: "valid\n", stderr: "" };
      }
      if (args.join(" ") === "plugins enable agentmemory --no-allow-tool-override") {
        return { status: 0, stdout: "enabled\n", stderr: "" };
      }
      if (args[0] === "config" && args[1] === "set") {
        const key = args[2]!;
        const raw = args[3]!;
        let value: unknown = raw;
        try {
          value = JSON.parse(raw);
        } catch {}
        values.set(key, value);
        return { status: 0, stdout: "saved\n", stderr: "" };
      }
      if (args[0] === "config" && args[1] === "get") {
        const key = args.at(-1)!;
        const value = key === "mcp_servers.agentmemory.args" && options.badArgsReadback
          ? ["wrong"]
          : values.get(key);
        return { status: 0, stdout: `${JSON.stringify(value)}\n`, stderr: "" };
      }
      if (args.join(" ") === "plugins show agentmemory") {
        return {
          status: 0,
          stdout: '{"name":"agentmemory","enabled":true}\n',
          stderr: "",
        };
      }
      if (args.join(" ") === "memory status") {
        return {
          status: 0,
          stdout: '{"provider":"agentmemory","available":true}\n',
          stderr: "",
        };
      }
      return { status: 9, stdout: "", stderr: "unexpected command" };
    },
  };
}

beforeEach(() => {
  delete process.env["HERMES_HOME"];
  originalAgentMemoryHome = process.env["AGENTMEMORY_HOME"];
});

afterEach(() => {
  if (originalAgentMemoryHome === undefined) delete process.env["AGENTMEMORY_HOME"];
  else process.env["AGENTMEMORY_HOME"] = originalAgentMemoryHome;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Hermes package inclusion", () => {
  it("ships the Hermes integration in the npm artifact manifest", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
      files: string[];
    };
    expect(pkg.files).toContain("integrations/hermes/");
  });
});

describe("Hermes config path resolution", () => {
  it("matches the documented HERMES_HOME and platform-native defaults without invoking Hermes", () => {
    expect(
      resolveHermesConfigPath(
        { HERMES_HOME: "E:\\Hermes Profile" },
        "win32",
        "C:\\Users\\Laptop",
      ),
    ).toBe(resolve("E:\\Hermes Profile", "config.yaml"));
    expect(
      resolveHermesConfigPath(
        { LOCALAPPDATA: "E:\\Users\\Laptop\\AppData\\Local" },
        "win32",
        "E:\\Users\\Laptop",
      ),
    ).toBe(resolve("E:\\Users\\Laptop\\AppData\\Local", "hermes", "config.yaml"));
    expect(
      resolveHermesConfigPath({}, "linux", "/home/laptop"),
    ).toBe(resolve("/home/laptop", ".hermes", "config.yaml"));
  });
});

describe("Hermes automatic registration", () => {
  it.skipIf(process.platform !== "win32")(
    "does not crash while preparing a missing plugin path under a Unicode home",
    () => {
      const root = mkdtempSync(join(tmpdir(), "agentmemory-hermes-unicode-"));
      roots.push(root);
      const hermesHome = join(root, "새 사용자 Home", "Hermes Home");
      const configPath = join(hermesHome, "config.yaml");
      mkdirSync(hermesHome, { recursive: true });
      writeFileSync(configPath, "unrelated: keep\n", "utf-8");

      const moduleUrl = pathToFileURL(
        resolve("src", "cli", "connect", "hermes.ts"),
      ).href;
      const sourceRoot = resolve("integrations", "hermes");
      const script = `
        const { installHermesIntegration } = await import(process.env.HERMES_TEST_MODULE_URL);
        const values = new Map();
        const run = (_executablePath, args) => {
          const command = args.join(" ");
          if (command === "config path") {
            return { status: 0, stdout: process.env.HERMES_TEST_CONFIG_PATH + "\\n", stderr: "" };
          }
          if (args[0] === "plugins" && args[1] === "doctor") {
            return { status: 0, stdout: "valid\\n", stderr: "" };
          }
          if (command === "plugins enable agentmemory --no-allow-tool-override") {
            return { status: 0, stdout: "enabled\\n", stderr: "" };
          }
          if (args[0] === "config" && args[1] === "set") {
            let value = args[3];
            try { value = JSON.parse(value); } catch {}
            values.set(args[2], value);
            return { status: 0, stdout: "saved\\n", stderr: "" };
          }
          if (args[0] === "config" && args[1] === "get") {
            return { status: 0, stdout: JSON.stringify(values.get(args.at(-1))) + "\\n", stderr: "" };
          }
          if (command === "plugins show agentmemory") {
            return { status: 0, stdout: "agentmemory enabled\\n", stderr: "" };
          }
          if (command === "memory status") {
            return { status: 0, stdout: "agentmemory available\\n", stderr: "" };
          }
          return { status: 9, stdout: "", stderr: "unexpected command" };
        };
        const first = await installHermesIntegration(
          "fake-hermes.exe",
          { dryRun: false, force: false },
          { run, sourceRoot: process.env.HERMES_TEST_SOURCE_ROOT },
        );
        const second = await installHermesIntegration(
          "fake-hermes.exe",
          { dryRun: false, force: false },
          { run, sourceRoot: process.env.HERMES_TEST_SOURCE_ROOT },
        );
        if (first.kind !== "installed" || second.kind !== "installed") process.exitCode = 3;
      `;
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            AGENTMEMORY_HOME: join(root, "AgentMemory Home"),
            HOME: join(root, "User Home"),
            USERPROFILE: join(root, "User Home"),
            HERMES_TEST_CONFIG_PATH: configPath,
            HERMES_TEST_MODULE_URL: moduleUrl,
            HERMES_TEST_SOURCE_ROOT: sourceRoot,
          },
          encoding: "utf-8",
          timeout: 30_000,
          windowsHide: true,
        },
      );

      expect(result.status, String(result.stderr ?? "")).toBe(0);
      expect(existsSync(join(hermesHome, "plugins", "agentmemory", "plugin.yaml"))).toBe(true);
    },
  );

  it("doctors, copies, enables, configures, and reads back every required component", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmemory-hermes-connect-"));
    roots.push(root);
    const hermesHome = join(root, "Hermes Home");
    process.env["AGENTMEMORY_HOME"] = join(root, "AgentMemory Home");
    process.env["HERMES_HOME"] = hermesHome;
    const configPath = join(hermesHome, "config.yaml");
    mkdirSync(hermesHome, { recursive: true });
    writeFileSync(configPath, "unrelated: keep\n", "utf-8");
    const beforeHash = sha256(configPath);
    const fake = fakeRunner(configPath);
    const sourceRoot = resolve("integrations", "hermes");

    const result = await installHermesIntegration(
      "fake-hermes.exe",
      { dryRun: false, force: false },
      { run: fake.run, sourceRoot },
    );

    expect(result.kind).toBe("installed");
    expect(fake.calls).toContainEqual(["plugins", "doctor", sourceRoot, "--ci"]);
    expect(fake.calls).toContainEqual([
      "plugins",
      "enable",
      "agentmemory",
      "--no-allow-tool-override",
    ]);
    expect(fake.calls).toContainEqual([
      "config",
      "set",
      "memory.provider",
      "agentmemory",
    ]);
    expect(fake.calls).toContainEqual([
      "config",
      "set",
      "mcp_servers.agentmemory.command",
      "npx",
    ]);
    expect(fake.calls).toContainEqual([
      "config",
      "set",
      "mcp_servers.agentmemory.args",
      '["-y","@agentmemory/mcp"]',
    ]);
    for (const name of ["plugin.yaml", "__init__.py", "README.md"]) {
      expect(existsSync(join(hermesHome, "plugins", "agentmemory", name))).toBe(true);
    }
    expect(sha256(configPath)).toBe(beforeHash);
  });

  it("keeps dry-run read-only without invoking the side-effecting Hermes CLI", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmemory-hermes-dry-run-"));
    roots.push(root);
    const hermesHome = join(root, "Hermes Home");
    process.env["AGENTMEMORY_HOME"] = join(root, "AgentMemory Home");
    process.env["HERMES_HOME"] = hermesHome;
    const configPath = join(hermesHome, "config.yaml");
    const fake = fakeRunner(configPath);

    const result = await installHermesIntegration(
      "fake-hermes.exe",
      { dryRun: true, force: false },
      { run: fake.run, sourceRoot: resolve("integrations", "hermes") },
    );

    expect(result.kind).toBe("installed");
    expect(fake.calls).toEqual([]);
    expect(existsSync(hermesHome)).toBe(false);
  });

  it("restores an existing plugin and config when required read-back does not match", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmemory-hermes-rollback-"));
    roots.push(root);
    const hermesHome = join(root, "Hermes Home");
    process.env["AGENTMEMORY_HOME"] = join(root, "AgentMemory Home");
    const configPath = join(hermesHome, "config.yaml");
    const pluginRoot = join(hermesHome, "plugins", "agentmemory");
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(configPath, "original: true\n", "utf-8");
    writeFileSync(join(pluginRoot, "old-marker.txt"), "old", "utf-8");
    const configHash = sha256(configPath);
    const fake = fakeRunner(configPath, { badArgsReadback: true });

    const result = await installHermesIntegration(
      "fake-hermes.exe",
      { dryRun: false, force: false },
      { run: fake.run, sourceRoot: resolve("integrations", "hermes") },
    );

    expect(result).toEqual({
      kind: "skipped",
      reason: "hermes-readback-mcp-args",
    });
    expect(sha256(configPath)).toBe(configHash);
    expect(readFileSync(join(pluginRoot, "old-marker.txt"), "utf-8")).toBe("old");
    expect(existsSync(join(dirname(pluginRoot), `agentmemory.tmp-${process.pid}`))).toBe(false);
  });
});
