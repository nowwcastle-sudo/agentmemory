import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { resolveProject } from "../src/hooks/_project.js";

// The checkout directory is not necessarily named "agentmemory" — contributors clone
// into forks, worktrees and arbitrary paths — so the git-toplevel assertions run against
// a throwaway repo whose name we control instead of against process.cwd().
const REPO_NAME = "amem-fixture-repo";

describe("resolveProject — hook project basename resolver", () => {
  const originalEnv = process.env.AGENTMEMORY_PROJECT_NAME;

  let tmpRoot: string;
  let repoDir: string;
  let nestedDir: string;
  let worktreeDir: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "amem-project-"));
    repoDir = join(tmpRoot, REPO_NAME);
    nestedDir = join(repoDir, "src", "hooks");
    worktreeDir = join(tmpRoot, "linked-worktree");
    mkdirSync(nestedDir, { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: repoDir, stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=AgentMemory Test",
        "-c",
        "user.email=agentmemory-test@example.invalid",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "fixture",
      ],
      { cwd: repoDir, stdio: "ignore" },
    );
    execFileSync("git", ["worktree", "add", "--quiet", "--detach", worktreeDir], {
      cwd: repoDir,
      stdio: "ignore",
    });
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    delete process.env.AGENTMEMORY_PROJECT_NAME;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEnv === undefined) {
      delete process.env.AGENTMEMORY_PROJECT_NAME;
    } else {
      process.env.AGENTMEMORY_PROJECT_NAME = originalEnv;
    }
  });

  it("AGENTMEMORY_PROJECT_NAME env wins over everything", () => {
    process.env.AGENTMEMORY_PROJECT_NAME = "my-override";
    expect(resolveProject("/var/log")).toBe("my-override");
    expect(resolveProject(repoDir)).toBe("my-override");
  });

  it("trims whitespace on env override", () => {
    process.env.AGENTMEMORY_PROJECT_NAME = "  spaced  ";
    expect(resolveProject("/var/log")).toBe("spaced");
  });

  it("ignores empty env override", () => {
    process.env.AGENTMEMORY_PROJECT_NAME = "   ";
    const withWhitespace = resolveProject(repoDir);
    delete process.env.AGENTMEMORY_PROJECT_NAME;
    expect(withWhitespace).toBe(resolveProject(repoDir));
  });

  it("uses one stable scope ID for a repository and its linked worktree", () => {
    const canonical = resolveProject(repoDir);
    expect(canonical).toMatch(/^path:[0-9a-f]{32}$/);
    expect(resolveProject(worktreeDir)).toBe(canonical);
  });

  it("uses the same stable scope ID from a nested repository directory", () => {
    expect(resolveProject(nestedDir)).toBe(resolveProject(repoDir));
  });

  it("uses one credential-free scope ID for equivalent Git remotes", () => {
    const cloneA = join(tmpRoot, "clone-a");
    const cloneB = join(tmpRoot, "clone-b");
    mkdirSync(cloneA, { recursive: true });
    mkdirSync(cloneB, { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: cloneA, stdio: "ignore" });
    execFileSync("git", ["init", "--quiet"], { cwd: cloneB, stdio: "ignore" });
    execFileSync(
      "git",
      ["remote", "add", "upstream", "https://secret-token@github.com/Owner/Repo.git"],
      { cwd: cloneA, stdio: "ignore" },
    );
    execFileSync(
      "git",
      ["remote", "add", "upstream", "git@github.com:Owner/Repo.git"],
      { cwd: cloneB, stdio: "ignore" },
    );

    const first = resolveProject(cloneA);
    expect(first).toMatch(/^git:[0-9a-f]{32}$/);
    expect(resolveProject(cloneB)).toBe(first);
    expect(first).not.toContain("secret-token");
  }, 30_000);

  it("keeps the display name and legacy basename separate from the stable ID", async () => {
    const projectModule = await import("../src/hooks/_project.js");
    const identity = projectModule.resolveProjectIdentity(repoDir);

    expect(identity).toEqual({
      projectId: resolveProject(repoDir),
      projectName: REPO_NAME,
      legacyProjectIds: [REPO_NAME],
    });
  });

  it("builds an atomic hook payload with stable ID and display name", async () => {
    const projectModule = await import("../src/hooks/_project.js");

    expect(projectModule.resolveProjectPayload(repoDir)).toEqual({
      project: resolveProject(repoDir),
      projectName: REPO_NAME,
    });
  });

  it("adds an explicit host source to the atomic hook payload", async () => {
    const projectModule = await import("../src/hooks/_project.js");

    expect(
      projectModule.resolveProjectPayload(repoDir, [
        "--source-client",
        "codex",
      ]),
    ).toEqual({
      project: resolveProject(repoDir),
      projectName: REPO_NAME,
      sourceClient: "codex",
    });
  });

  it("separates non-git directories that share a basename", () => {
    // mkdtemp lands under os.tmpdir(), which is not always outside a repository —
    // TMPDIR pointed at a working directory makes git walk up and find one, and the
    // fallback under test never runs. Ceiling the upward search at the parent so the
    // directory is genuinely repo-less. The ceiling must be a resolved path: git
    // compares it after resolving symlinks, and on macOS tmpdir() is one.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "amem-noproj-")));
    const other = join(tmpRoot, "foreign", basename(dir));
    mkdirSync(other, { recursive: true });
    const priorCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = [dirname(dir), dirname(other)].join(
      process.platform === "win32" ? ";" : ":",
    );
    try {
      expect(resolveProject(dir)).toMatch(/^path:[0-9a-f]{32}$/);
      expect(resolveProject(other)).toMatch(/^path:[0-9a-f]{32}$/);
      expect(resolveProject(other)).not.toBe(resolveProject(dir));
    } finally {
      if (priorCeiling === undefined) {
        delete process.env.GIT_CEILING_DIRECTORIES;
      } else {
        process.env.GIT_CEILING_DIRECTORIES = priorCeiling;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults to process.cwd() when no cwd argument given", () => {
    vi.spyOn(process, "cwd").mockReturnValue(repoDir);
    expect(resolveProject()).toBe(resolveProject(repoDir));
  });

  it("defaults to process.cwd() when cwd argument is empty", () => {
    vi.spyOn(process, "cwd").mockReturnValue(repoDir);
    expect(resolveProject("")).toBe(resolveProject(repoDir));
    expect(resolveProject("   ")).toBe(resolveProject(repoDir));
  });
});
