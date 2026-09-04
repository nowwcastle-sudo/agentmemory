import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface PathLayoutOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export interface AgentMemoryPathLayout {
  configRoot: string;
  envFile: string;
  runtimeDir: string;
  backupsDir: string;
  snapshotsDir: string;
  hooksDir: string;
}

export function resolvePathLayout(
  options: PathLayoutOptions = {},
): AgentMemoryPathLayout {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const configRoot = join(home, ".agentmemory");
  const runtimeDir = env["AGENTMEMORY_RUNTIME_DIR"]
    ? resolve(env["AGENTMEMORY_RUNTIME_DIR"])
    : configRoot;
  return {
    configRoot,
    envFile: join(configRoot, ".env"),
    runtimeDir,
    backupsDir: join(configRoot, "backups"),
    snapshotsDir: env["SNAPSHOT_DIR"]
      ? resolve(env["SNAPSHOT_DIR"])
      : join(configRoot, "snapshots"),
    hooksDir: join(configRoot, "hooks", "current"),
  };
}

export function agentMemoryOutboxPath(
  adapter: string,
  options: PathLayoutOptions = {},
): string {
  const env = options.env ?? process.env;
  return env["AGENTMEMORY_OUTBOX_DIR"]
    ? resolve(env["AGENTMEMORY_OUTBOX_DIR"])
    : join(resolvePathLayout(options).configRoot, "outbox", adapter);
}

export function runtimeMetadataPath(
  name: string,
  options: PathLayoutOptions = {},
): string {
  return join(resolvePathLayout(options).runtimeDir, name);
}
