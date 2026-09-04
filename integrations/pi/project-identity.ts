import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface ProjectIdentity {
  project: string;
  projectName: string;
}

const identityCache = new Map<string, ProjectIdentity>();
const gitProjectIdCache = new Map<string, string>();

function realPath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return resolve(value);
  }
}

function canonicalPath(value: string): string {
  let canonical = realPath(value);
  canonical = canonical.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function projectHash(kind: "git" | "path", value: string): string {
  return `${kind}:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function canonicalRemote(remote: string, cwd: string): string | null {
  const value = remote.trim();
  const scp = value.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (scp && !value.includes("://") && !/^[A-Za-z]:[\\/]/.test(value)) {
    const remotePath = scp[2].replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return remotePath ? `${scp[1].toLowerCase()}/${remotePath}` : null;
  }
  try {
    const url = new URL(value);
    if (url.protocol === "file:") {
      return `file/${canonicalPath(decodeURIComponent(url.pathname))}`;
    }
    const remotePath = decodeURIComponent(url.pathname)
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/i, "");
    return url.hostname && remotePath
      ? `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}/${remotePath}`
      : null;
  } catch {
    return value ? `file/${canonicalPath(resolve(cwd, value))}` : null;
  }
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
      if (metadata.isDirectory()) return { top: current, commonDir: realPath(dotGit) };
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

function configuredRemoteIdentity(commonDir: string, cwd: string): string | null {
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

export function resolveProjectIdentity(cwd: string): ProjectIdentity {
  const explicit = process.env["AGENTMEMORY_PROJECT_NAME"]?.trim();
  if (explicit) return { project: explicit, projectName: explicit };
  const cacheKey = canonicalPath(cwd);
  const cached = identityCache.get(cacheKey);
  if (cached) return cached;
  const repository = gitRepository(cwd);
  let identity: ProjectIdentity;
  if (repository) {
    const canonicalCommonDir = canonicalPath(repository.commonDir);
    const projectName = basename(
      canonicalCommonDir.endsWith("/.git") ? dirname(canonicalCommonDir) : repository.top,
    );
    let project = gitProjectIdCache.get(canonicalCommonDir);
    if (!project) {
      const remote = configuredRemoteIdentity(repository.commonDir, cwd);
      project = remote
        ? projectHash("git", remote)
        : projectHash("path", canonicalCommonDir);
      gitProjectIdCache.set(canonicalCommonDir, project);
    }
    identity = { project, projectName };
  } else {
    identity = { project: projectHash("path", cacheKey), projectName: basename(cacheKey) || cwd };
  }
  identityCache.set(cacheKey, identity);
  return identity;
}
