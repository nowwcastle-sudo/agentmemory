import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import type {
  AgentProbe,
  ConnectAdapter,
  ConnectOptions,
  ConnectResult,
} from "./types.js";
import {
  probeExecutable,
  type ProbeExecutableOptions,
} from "./probe.js";
import { backupFile, logBackup, logInstalled } from "./util.js";

export function resolveHermesConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = osPlatform(),
  home: string = homedir(),
): string {
  const configuredHome = env["HERMES_HOME"]?.trim();
  if (configuredHome) return resolve(configuredHome, "config.yaml");
  if (platform === "win32") {
    const localAppData = env["LOCALAPPDATA"]?.trim() || join(home, "AppData", "Local");
    return resolve(localAppData, "hermes", "config.yaml");
  }
  return resolve(home, ".hermes", "config.yaml");
}

const DOCS = "https://github.com/rohitg00/agentmemory/tree/main/integrations/hermes";

export type HermesCommandResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
  errorCode?: string;
};

export type HermesCommandRunner = (
  executablePath: string,
  args: string[],
) => HermesCommandResult;

type HermesInstallDependencies = {
  run?: HermesCommandRunner;
  sourceRoot?: string;
};

class HermesInstallFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const defaultHermesRunner: HermesCommandRunner = (executablePath, args) => {
  const result = spawnSync(executablePath, args, {
    shell: false,
    windowsHide: true,
    encoding: "utf-8",
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
  };
};

function checkedHermesCommand(
  run: HermesCommandRunner,
  executablePath: string,
  args: string[],
  reason: string,
): string {
  const result = run(executablePath, args);
  if (result.status !== 0) throw new HermesInstallFailure(reason);
  return String(result.stdout ?? "").trim();
}

function parseHermesValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value.trim();
  }
}

function treeHashes(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const name = relative(root, path);
        hashes[name] = createHash("sha256").update(readFileSync(path)).digest("hex");
      }
    }
  };
  visit(root);
  return hashes;
}

function removeTreeIfPresent(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    unlinkSync(path);
    return;
  }
  for (const name of readdirSync(path)) {
    removeTreeIfPresent(join(path, name));
  }
  rmdirSync(path);
}

function copyVerifiedHermesIntegration(sourceRoot: string, targetRoot: string): void {
  removeTreeIfPresent(targetRoot);
  mkdirSync(dirname(targetRoot), { recursive: true });
  cpSync(sourceRoot, targetRoot, {
    recursive: true,
    filter: (source) => {
      const name = source.replace(/\\/g, "/");
      return !name.includes("/__pycache__/") &&
        !name.endsWith("/__pycache__") &&
        !name.endsWith(".pyc");
    },
  });
  for (const name of ["plugin.yaml", "__init__.py", "README.md"]) {
    if (!statSync(join(targetRoot, name)).isFile()) {
      throw new HermesInstallFailure("hermes-plugin-copy-required-file");
    }
  }
  const sourceHashes = treeHashes(sourceRoot);
  const targetHashes = treeHashes(targetRoot);
  if (JSON.stringify(sourceHashes) !== JSON.stringify(targetHashes)) {
    throw new HermesInstallFailure("hermes-plugin-copy-hash");
  }
}

export function findHermesIntegrationRoot(startUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(startUrl));
  for (let index = 0; index < 12; index++) {
    const candidate = join(dir, "integrations", "hermes");
    if (
      existsSync(join(candidate, "plugin.yaml")) &&
      existsSync(join(candidate, "__init__.py"))
    ) {
      return resolve(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new HermesInstallFailure("hermes-integration-not-found");
}

export async function installHermesIntegration(
  executablePath: string,
  opts: ConnectOptions,
  dependencies: HermesInstallDependencies = {},
): Promise<ConnectResult> {
  const run = dependencies.run ?? defaultHermesRunner;
  if (opts.dryRun) {
    const plannedConfigPath = resolveHermesConfigPath();
    p.log.info(`[dry-run] Would install the Hermes agentmemory plugin for ${plannedConfigPath}`);
    return { kind: "installed", mutatedPath: plannedConfigPath };
  }

  let configPath: string;
  try {
    configPath = checkedHermesCommand(
      run,
      executablePath,
      ["config", "path"],
      "hermes-config-path",
    )
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "";
    if (!configPath) throw new HermesInstallFailure("hermes-config-path-empty");
  } catch (error) {
    return {
      kind: "skipped",
      reason: error instanceof HermesInstallFailure
        ? error.reason
        : "hermes-config-path",
    };
  }

  const hermesHome = dirname(configPath);
  const pluginsRoot = join(hermesHome, "plugins");
  const targetRoot = join(pluginsRoot, "agentmemory");
  const stagingRoot = join(pluginsRoot, `agentmemory.tmp-${process.pid}`);
  const previousRoot = join(pluginsRoot, `agentmemory.previous-${process.pid}`);
  const sourceRoot = dependencies.sourceRoot ?? findHermesIntegrationRoot();
  const configExisted = existsSync(configPath);
  let backupPath: string | undefined;
  let previousMoved = false;
  let targetInstalled = false;

  try {
    checkedHermesCommand(
      run,
      executablePath,
      ["plugins", "doctor", sourceRoot, "--ci"],
      "hermes-plugin-doctor",
    );
    if (configExisted) {
      backupPath = backupFile(configPath, "hermes", "yaml");
      logBackup(backupPath);
    }

    copyVerifiedHermesIntegration(sourceRoot, stagingRoot);
    if (existsSync(targetRoot)) {
      removeTreeIfPresent(previousRoot);
      renameSync(targetRoot, previousRoot);
      previousMoved = true;
    }
    renameSync(stagingRoot, targetRoot);
    targetInstalled = true;

    checkedHermesCommand(
      run,
      executablePath,
      ["plugins", "enable", "agentmemory", "--no-allow-tool-override"],
      "hermes-plugin-enable",
    );
    const settings: Array<[string, string]> = [
      ["memory.provider", "agentmemory"],
      ["mcp_servers.agentmemory.command", "npx"],
      ["mcp_servers.agentmemory.args", '["-y","@agentmemory/mcp"]'],
    ];
    for (const [key, value] of settings) {
      checkedHermesCommand(
        run,
        executablePath,
        ["config", "set", key, value],
        `hermes-config-set-${key}`,
      );
    }

    const provider = parseHermesValue(checkedHermesCommand(
      run,
      executablePath,
      ["config", "get", "--json", "memory.provider"],
      "hermes-readback-provider",
    ));
    if (provider !== "agentmemory") {
      throw new HermesInstallFailure("hermes-readback-provider");
    }
    const command = parseHermesValue(checkedHermesCommand(
      run,
      executablePath,
      ["config", "get", "--json", "mcp_servers.agentmemory.command"],
      "hermes-readback-mcp-command",
    ));
    if (command !== "npx") {
      throw new HermesInstallFailure("hermes-readback-mcp-command");
    }
    const args = parseHermesValue(checkedHermesCommand(
      run,
      executablePath,
      ["config", "get", "--json", "mcp_servers.agentmemory.args"],
      "hermes-readback-mcp-args",
    ));
    if (!Array.isArray(args) || args.length !== 2 || args[0] !== "-y" || args[1] !== "@agentmemory/mcp") {
      throw new HermesInstallFailure("hermes-readback-mcp-args");
    }

    const pluginStatus = checkedHermesCommand(
      run,
      executablePath,
      ["plugins", "show", "agentmemory"],
      "hermes-readback-plugin",
    ).toLowerCase();
    if (!pluginStatus.includes("agentmemory") || pluginStatus.includes("disabled")) {
      throw new HermesInstallFailure("hermes-readback-plugin");
    }
    const memoryStatus = checkedHermesCommand(
      run,
      executablePath,
      ["memory", "status"],
      "hermes-readback-memory",
    ).toLowerCase();
    if (!memoryStatus.includes("agentmemory") || memoryStatus.includes("unavailable")) {
      throw new HermesInstallFailure("hermes-readback-memory");
    }

    removeTreeIfPresent(previousRoot);
    logInstalled("Hermes Agent", configPath);
    return {
      kind: "installed",
      mutatedPath: configPath,
      ...(backupPath !== undefined && { backupPath }),
    };
  } catch (error) {
    removeTreeIfPresent(stagingRoot);
    if (targetInstalled) removeTreeIfPresent(targetRoot);
    if (previousMoved && existsSync(previousRoot)) renameSync(previousRoot, targetRoot);
    if (backupPath && existsSync(backupPath)) copyFileSync(backupPath, configPath);
    else if (!configExisted) rmSync(configPath, { force: true });
    return {
      kind: "skipped",
      reason: error instanceof HermesInstallFailure
        ? error.reason
        : "hermes-install-failed",
    };
  }
}

export function probeHermes(
  options: ProbeExecutableOptions = {},
): AgentProbe {
  const executable = probeExecutable(["hermes"], {
    ...options,
    timeoutMs: options.timeoutMs ?? 15_000,
  });
  const configPath = resolveHermesConfigPath(
    options.env ?? process.env,
    options.platform ?? osPlatform(),
  );
  const hermesDir = dirname(configPath);
  const configExists = existsSync(hermesDir) || existsSync(configPath);
  const configText = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
  const mcpWired = configText.includes("agentmemory") &&
    configText.includes("@agentmemory/mcp") &&
    configText.includes("npx");
  const pluginListed = existsSync(
    join(hermesDir, "plugins", "agentmemory", "plugin.yaml"),
  );
  const wiring = mcpWired && pluginListed
    ? "wired"
    : mcpWired || pluginListed
      ? "partial"
      : "unwired";

  return {
    ...executable,
    presence: executable.presence === "executable"
      ? "executable"
      : configExists
        ? "config-only"
        : "absent",
    configPath,
    wiring,
    activation: wiring === "unwired" ? "not-checked" : "restart-required",
    durability: pluginListed ? "outbox-capable" : "not-checked",
  };
}

export const adapter: ConnectAdapter = {
  name: "hermes",
  displayName: "Hermes Agent",
  category: "native",
  docs: DOCS,
  protocolNote:
    "→ Using MCP. Hooks are also available — see https://github.com/rohitg00/agentmemory/tree/main/integrations/hermes.",

  detect(): boolean {
    return probeHermes().usable;
  },

  probe(options): AgentProbe {
    return probeHermes(options);
  },

  async install(opts: ConnectOptions): Promise<ConnectResult> {
    const executable = probeExecutable(["hermes"], {
      executeVersion: !opts.dryRun,
      timeoutMs: 15_000,
    });
    if (!executable.usable || !executable.executablePath) {
      return {
        kind: "skipped",
        reason: executable.reason ?? "hermes-executable-unavailable",
      };
    }
    return installHermesIntegration(executable.executablePath, opts);
  },
};
