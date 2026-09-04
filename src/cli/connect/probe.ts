import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import type { AgentProbe, AgentProbeOptions } from "./types.js";

export type ProbeExecutableOptions = AgentProbeOptions & {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawn?: typeof spawnSync;
  timeoutMs?: number;
};

export type ExecutableProbe = Pick<
  AgentProbe,
  "presence" | "usable" | "executablePath" | "version" | "reason"
>;

function firstOutputLine(value: unknown): string | undefined {
  const line = String(value ?? "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line || undefined;
}

function exactFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function probeExecutable(
  names: string[],
  options: ProbeExecutableOptions = {},
): ExecutableProbe {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? spawnSync;
  const timeout = options.timeoutMs ?? 5000;
  const pathValue = env["PATH"] ?? env["Path"] ?? env["path"] ?? "";
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const directories = pathValue
    .split(pathDelimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  const pathext = platform === "win32"
    ? (env["PATHEXT"] ?? env["Pathext"] ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [""];

  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const hasExtension = extname(name).length > 0;
    const suffixes = platform === "win32" && !hasExtension ? pathext : [""];
    const roots = isAbsolute(name) ? [""] : directories;
    for (const root of roots) {
      for (const suffix of suffixes) {
        const candidate = isAbsolute(name)
          ? `${name}${suffix}`
          : resolve(join(root, `${name}${suffix}`));
        const identity = platform === "win32" ? candidate.toLowerCase() : candidate;
        if (seen.has(identity) || !exactFile(candidate)) continue;
        seen.add(identity);
        candidates.push(candidate);
      }
    }
  }

  let firstFailure: ExecutableProbe | null = null;
  if (options.executeVersion === false && candidates[0] !== undefined) {
    return {
      presence: "executable",
      usable: true,
      executablePath: candidates[0],
    };
  }
  for (const executablePath of candidates) {
    const result = spawn(executablePath, ["--version"], {
      shell: false,
      windowsHide: true,
      encoding: "utf-8",
      timeout,
    });
    if (result.status === 0) {
      const version = firstOutputLine(result.stdout) ?? firstOutputLine(result.stderr);
      return {
        presence: "executable",
        usable: true,
        executablePath,
        ...(version !== undefined && { version }),
      };
    }

    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    const reason = errorCode === "ETIMEDOUT"
      ? "version-timeout"
      : typeof result.status === "number"
        ? `version-exit-${result.status}`
        : "version-spawn-failed";
    firstFailure ??= {
      presence: "executable",
      usable: false,
      executablePath,
      reason,
    };
  }

  return firstFailure ?? {
    presence: "absent",
    usable: false,
    reason: "executable-not-found",
  };
}
