import { homedir } from "node:os";
import { join } from "node:path";

type ClaudePathEnvironment = Readonly<Record<string, string | undefined>>;

export function toClaudeProjectSlug(projectPath: string): string {
  return projectPath.replace(/[/\\:]/g, "-");
}

export function resolveClaudeConfigDir(
  env: ClaudePathEnvironment = process.env,
  home = homedir(),
): string {
  const configured = env["CLAUDE_CONFIG_DIR"]?.trim();
  return configured || join(home, ".claude");
}

export function resolveClaudeProjectsDir(
  env: ClaudePathEnvironment = process.env,
  home = homedir(),
): string {
  return join(resolveClaudeConfigDir(env, home), "projects");
}

export function resolveClaudeDebugDir(
  env: ClaudePathEnvironment = process.env,
  home = homedir(),
): string {
  return join(resolveClaudeConfigDir(env, home), "debug");
}

export function resolveClaudeStateFile(
  env: ClaudePathEnvironment = process.env,
  home = homedir(),
): string {
  const configured = env["CLAUDE_CONFIG_DIR"]?.trim();
  return configured
    ? join(configured, ".claude.json")
    : join(home, ".claude.json");
}
