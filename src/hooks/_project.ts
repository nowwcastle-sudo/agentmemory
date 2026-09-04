import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface ProjectIdentity {
  projectId: string;
  projectName: string;
  legacyProjectIds: string[];
}

const projectIdentityCache = new Map<string, ProjectIdentity>();
const gitProjectIdCache = new Map<string, string>();

function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function canonicalPath(path: string): string {
  if (process.platform !== "win32" && /^[A-Za-z]:[\\/]/.test(path)) {
    return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }
  let canonical = realPath(path);
  canonical = canonical.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function portableBasename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function gitRepository(cwd: string): { top: string; commonDir: string } | null {
  let current = realPath(cwd);
  try {
    if (!statSync(current).isDirectory()) current = dirname(current);
  } catch {
    return null;
  }
  while (true) {
    const dotGit = join(current, ".git");
    try {
      const metadata = statSync(dotGit);
      if (metadata.isDirectory()) {
        return { top: current, commonDir: realPath(dotGit) };
      }
      if (metadata.isFile()) {
        const pointer = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)\s*$/im)?.[1];
        if (!pointer) return null;
        const gitDir = realPath(resolve(current, pointer));
        let commonDir = gitDir;
        try {
          const common = readFileSync(join(gitDir, "commondir"), "utf8").trim();
          if (common) commonDir = realPath(resolve(gitDir, common));
        } catch {}
        return { top: current, commonDir };
      }
    } catch {}
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function hashProject(kind: "git" | "path", identity: string): string {
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return `${kind}:${hash}`;
}

function canonicalRemote(remote: string, cwd: string): string | null {
  const value = remote.trim();
  if (!value) return null;

  const scp = value.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (scp && !value.includes("://") && !/^[A-Za-z]:[\\/]/.test(value)) {
    const path = scp[2].replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return path ? `${scp[1].toLowerCase()}/${path}` : null;
  }

  try {
    const url = new URL(value);
    if (url.protocol === "file:") {
      return `file/${canonicalPath(decodeURIComponent(url.pathname))}`;
    }
    const host = url.hostname.toLowerCase();
    const port = url.port ? `:${url.port}` : "";
    const path = decodeURIComponent(url.pathname)
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/i, "");
    return host && path ? `${host}${port}/${path}` : null;
  } catch {
    return `file/${canonicalPath(resolve(cwd, value))}`;
  }
}

function gitRemoteIdentity(commonDir: string, cwd: string): string | null {
  const remotes = new Map<string, string>();
  try {
    const configured = readFileSync(join(commonDir, "config"), "utf8");
    let remoteName: string | null = null;
    for (const line of configured.split(/\r?\n/)) {
      const section = line.match(/^\s*\[remote\s+"([^"]+)"\]\s*$/i);
      if (section) {
        remoteName = section[1];
        continue;
      }
      if (/^\s*\[/.test(line)) {
        remoteName = null;
        continue;
      }
      const url = remoteName ? line.match(/^\s*url\s*=\s*(.+?)\s*$/i) : null;
      if (url) remotes.set(remoteName!, url[1]);
    }
  } catch {}
  const names = ["upstream", "origin"];
  for (const name of [...remotes.keys()].sort()) {
    if (!names.includes(name)) names.push(name);
  }
  for (const name of names) {
    const remote = remotes.get(name);
    if (!remote) continue;
    const canonical = canonicalRemote(remote, cwd);
    if (canonical) return canonical;
  }
  return null;
}

// Resolution order: explicit override → canonical Git remote → Git common dir → cwd realpath.
export function resolveProjectIdentity(
  cwd?: string,
  options: { useEnvOverride?: boolean } = {},
): ProjectIdentity {
  const explicit = process.env["AGENTMEMORY_PROJECT_NAME"];
  if (options.useEnvOverride !== false && explicit && explicit.trim()) {
    const project = explicit.trim();
    return { projectId: project, projectName: project, legacyProjectIds: [] };
  }
  const dir = cwd && cwd.trim() ? cwd : process.cwd();
  const cacheKey = canonicalPath(dir);
  const cached = projectIdentityCache.get(cacheKey);
  if (cached) return cached;
  const repository = gitRepository(dir);
  const canonicalCommonDir = repository
    ? canonicalPath(repository.commonDir)
    : null;
  const projectName = repository
    ? basename(canonicalCommonDir?.endsWith("/.git") ? dirname(canonicalCommonDir) : repository.top)
    : portableBasename(cacheKey);
  let identity: ProjectIdentity;
  if (repository && canonicalCommonDir) {
    const cachedProjectId = gitProjectIdCache.get(canonicalCommonDir);
    if (cachedProjectId) {
      identity = {
        projectId: cachedProjectId,
        projectName,
        legacyProjectIds: [projectName],
      };
      projectIdentityCache.set(cacheKey, identity);
      return identity;
    }
    const remote = gitRemoteIdentity(repository.commonDir, dir);
    if (remote) {
      identity = {
        projectId: hashProject("git", remote),
        projectName,
        legacyProjectIds: [projectName],
      };
    } else {
      identity = {
        projectId: hashProject("path", canonicalCommonDir),
        projectName,
        legacyProjectIds: [projectName],
      };
    }
    gitProjectIdCache.set(canonicalCommonDir, identity.projectId);
  } else {
    identity = {
      projectId: hashProject("path", cacheKey),
      projectName,
      legacyProjectIds: [projectName],
    };
  }
  projectIdentityCache.set(cacheKey, identity);
  return identity;
}

export function resolveProject(cwd?: string): string {
  return resolveProjectIdentity(cwd).projectId;
}

function sourceClientFromArgs(args: string[]): string | undefined {
  const flag = "--source-client";
  for (let index = args.length - 1; index >= 0; index--) {
    const value = args[index];
    if (value === flag) {
      const candidate = args[index + 1]?.trim();
      return candidate ? candidate.slice(0, 64) : undefined;
    }
    if (value?.startsWith(`${flag}=`)) {
      const candidate = value.slice(flag.length + 1).trim();
      return candidate ? candidate.slice(0, 64) : undefined;
    }
  }
  return undefined;
}

export function resolveProjectPayload(
  cwd?: string,
  args: string[] = process.argv.slice(2),
): {
  project: string;
  projectName: string;
  sourceClient?: string;
} {
  const identity = resolveProjectIdentity(cwd);
  const sourceClient = sourceClientFromArgs(args);
  return {
    project: identity.projectId,
    projectName: identity.projectName,
    ...(sourceClient ? { sourceClient } : {}),
  };
}

export function hookCwd(data: Record<string, unknown> | null | undefined): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  if (typeof data.cwd === "string" && data.cwd.trim()) return data.cwd;
  const roots = data.workspace_roots;
  if (Array.isArray(roots)) {
    for (const root of roots) {
      if (typeof root === "string" && root.trim()) return root;
    }
  }
  const projectDir =
    process.env["DEVIN_PROJECT_DIR"] || process.env["CLAUDE_PROJECT_DIR"];
  if (projectDir && projectDir.trim()) return projectDir;
  return undefined;
}
