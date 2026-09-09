import type { ISdk } from "../iii-compat.js";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { KV, generateId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import type {
  Memory,
  Session,
  RawObservation,
  CompressedObservation,
  SessionSummary,
} from "../types.js";
import { logger } from "../logger.js";

const ALLOWED_DIRS = [resolve(homedir(), ".agentmemory")];

interface ProjectIdentityMigrationInput {
  fromProject: string;
  toProjectId: string;
  toProjectName: string;
  dryRun?: boolean;
  snapshotConfirmed?: boolean;
}

interface ProjectIdentityMigrationCounts {
  sessions: number;
  rawObservations: number;
  observations: number;
  memories: number;
  summaries: number;
}

export async function migrateProjectIdentity(
  kv: StateKV,
  input: ProjectIdentityMigrationInput,
): Promise<{
  success: true;
  dryRun: boolean;
  matched: ProjectIdentityMigrationCounts;
  updated: ProjectIdentityMigrationCounts;
  requiresGraphRebuild: true;
  requiresIndexRebuild: true;
}> {
  const fromProject = input.fromProject?.trim();
  const toProjectId = input.toProjectId?.trim();
  const toProjectName = input.toProjectName?.trim();
  if (!fromProject || !toProjectId || !toProjectName) {
    throw new Error("fromProject, toProjectId, and toProjectName are required");
  }
  if (fromProject === toProjectId) {
    throw new Error("fromProject and toProjectId must be different");
  }
  const dryRun = input.dryRun ?? true;
  if (!dryRun && input.snapshotConfirmed !== true) {
    throw new Error("snapshotConfirmed=true is required before applying migration");
  }

  const sessions = await kv.list<Session>(KV.sessions);
  const memories = await kv.list<Memory>(KV.memories);
  const summaries = await kv.list<SessionSummary>(KV.summaries);
  const sessionUpdates: Session[] = [];
  const rawUpdates: RawObservation[] = [];
  const observationUpdates: CompressedObservation[] = [];
  const memoryUpdates: Memory[] = [];
  const summaryUpdates: SessionSummary[] = [];

  for (const session of sessions) {
    const [rawRows, observations] = await Promise.all([
      kv.list<RawObservation>(KV.rawObservations(session.id)),
      kv.list<CompressedObservation>(KV.observations(session.id)),
    ]);
    for (const row of rawRows) {
      if (row.projectId === fromProject) {
        rawUpdates.push({
          ...row,
          projectId: toProjectId,
          projectName: toProjectName,
        });
      }
    }
    for (const row of observations) {
      if (row.projectId === fromProject) {
        observationUpdates.push({
          ...row,
          projectId: toProjectId,
          projectName: toProjectName,
        });
      }
    }
    if (session.project === fromProject) {
      sessionUpdates.push({
        ...session,
        project: toProjectId,
        projectName: toProjectName,
      });
    }
  }
  for (const memory of memories) {
    if (memory.project === fromProject) {
      memoryUpdates.push({
        ...memory,
        project: toProjectId,
        projectName: toProjectName,
      });
    }
  }
  for (const summary of summaries) {
    if (summary.project === fromProject) {
      summaryUpdates.push({
        ...summary,
        project: toProjectId,
        projectName: toProjectName,
      });
    }
  }

  const matched: ProjectIdentityMigrationCounts = {
    sessions: sessionUpdates.length,
    rawObservations: rawUpdates.length,
    observations: observationUpdates.length,
    memories: memoryUpdates.length,
    summaries: summaryUpdates.length,
  };
  const updated: ProjectIdentityMigrationCounts = dryRun
    ? { sessions: 0, rawObservations: 0, observations: 0, memories: 0, summaries: 0 }
    : { ...matched };

  if (!dryRun) {
    for (const row of rawUpdates) {
      await kv.set(KV.rawObservations(row.sessionId), row.id, row);
    }
    for (const row of observationUpdates) {
      await kv.set(KV.observations(row.sessionId), row.id, row);
    }
    for (const row of memoryUpdates) {
      await kv.set(KV.memories, row.id, row);
    }
    for (const row of summaryUpdates) {
      await kv.set(KV.summaries, row.sessionId, row);
    }
    for (const row of sessionUpdates) {
      await kv.set(KV.sessions, row.id, row);
    }
  }

  logger.info("project identity migration complete", {
    dryRun,
    fromProject,
    toProjectId,
    matched,
  });
  return {
    success: true,
    dryRun,
    matched,
    updated,
    requiresGraphRebuild: true,
    requiresIndexRebuild: true,
  };
}

function isAllowedPath(dbPath: string): boolean {
  const resolved = resolve(dbPath);
  return ALLOWED_DIRS.some((dir) => resolved.startsWith(dir + "/"));
}

// Infer memory project from the majority project of its associated sessions.
// Returns { updated, skipped } — safe to run repeatedly (idempotent).
export async function inferMemoryProjects(
  kv: StateKV,
  dryRun = false,
): Promise<{ updated: number; skipped: number; ambiguous: number }> {
  const memories = await kv.list<Memory>(KV.memories);
  const sessionCache = new Map<string, Session | null>();

  const loadSession = async (sid: string): Promise<Session | null> => {
    if (sessionCache.has(sid)) return sessionCache.get(sid)!;
    const s = await kv.get<Session>(KV.sessions, sid).catch(() => null);
    sessionCache.set(sid, s);
    return s;
  };

  let updated = 0;
  let skipped = 0;
  let ambiguous = 0;

  for (const memory of memories) {
    if (memory.project) {
      skipped++;
      continue;
    }

    const sessionIds = memory.sessionIds ?? [];
    if (sessionIds.length === 0) {
      ambiguous++;
      continue;
    }

    const projects: string[] = [];
    for (const sid of sessionIds) {
      const session = await loadSession(sid);
      if (session?.project) projects.push(session.project);
    }

    if (projects.length === 0) {
      ambiguous++;
      continue;
    }

    // Majority-vote: count frequency of each project value.
    const freq = new Map<string, number>();
    for (const p of projects) freq.set(p, (freq.get(p) ?? 0) + 1);
    const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    const [topProject, topCount] = sorted[0];

    // Require a strict majority (> 50%) to avoid misattributing a memory
    // that was genuinely built from sessions across multiple projects.
    if (topCount <= projects.length / 2 && sorted.length > 1) {
      ambiguous++;
      continue;
    }

    if (!dryRun) {
      memory.project = topProject;
      await kv.set(KV.memories, memory.id, memory);
    }
    updated++;
  }

  logger.info("inferMemoryProjects complete", { updated, skipped, ambiguous, dryRun });
  return { updated, skipped, ambiguous };
}

export function registerMigrateFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::migrate",
    async (data: {
      dbPath?: string;
      step?: string;
      dryRun?: boolean;
      fromProject?: string;
      toProjectId?: string;
      toProjectName?: string;
      snapshotConfirmed?: boolean;
    }) => {
      // In-place KV migration steps (no SQLite dependency).
      if (data.step === "infer-memory-projects") {
        const dryRun = data.dryRun ?? false;
        logger.info("Migration step: infer-memory-projects", { dryRun });
        const result = await inferMemoryProjects(kv, dryRun);
        return { success: true, step: "infer-memory-projects", ...result };
      }

      if (data.step === "project-identity") {
        try {
          return await migrateProjectIdentity(kv, {
            fromProject: data.fromProject ?? "",
            toProjectId: data.toProjectId ?? "",
            toProjectName: data.toProjectName ?? "",
            dryRun: data.dryRun,
            snapshotConfirmed: data.snapshotConfirmed,
          });
        } catch (error) {
          return {
            success: false,
            step: "project-identity",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      if (!data.dbPath) {
        return {
          success: false,
          error: "Either step or dbPath is required",
        };
      }

      logger.info("Migration started", { dbPath: data.dbPath });

      if (!isAllowedPath(data.dbPath)) {
        return {
          success: false,
          error: `Path not allowed. Must be under: ${ALLOWED_DIRS.join(", ")}`,
        };
      }

      let Database: any;
      try {
        // @ts-expect-error optional dependency
        Database = (await import("better-sqlite3")).default;
      } catch {
        return {
          success: false,
          error:
            "better-sqlite3 not installed. Run: npm install better-sqlite3",
        };
      }

      const fs = await import("node:fs");
      if (!fs.existsSync(data.dbPath)) {
        return { success: false, error: `Database not found: ${data.dbPath}` };
      }

      let db: any;
      try {
        db = Database(data.dbPath, { readonly: true });
        let sessionCount = 0;
        let obsCount = 0;
        let summaryCount = 0;

        const sessions = db
          .prepare("SELECT * FROM sessions ORDER BY created_at DESC")
          .all() as any[];
        for (const row of sessions) {
          const session: Session = {
            id: row.session_id || row.id,
            project: row.project_path || row.project || "unknown",
            cwd: row.cwd || row.project_path || "",
            startedAt:
              row.created_at || row.started_at || new Date().toISOString(),
            endedAt: row.ended_at || row.updated_at,
            status: "completed",
            observationCount: 0,
          };
          await kv.set(KV.sessions, session.id, session);
          sessionCount++;
        }

        let observations: any[] = [];
        try {
          observations = db
            .prepare("SELECT * FROM observations ORDER BY created_at ASC")
            .all() as any[];
        } catch {
          try {
            observations = db
              .prepare(
                "SELECT * FROM compressed_observations ORDER BY created_at ASC",
              )
              .all() as any[];
          } catch {
            logger.warn("No observation tables found");
          }
        }

        for (const row of observations) {
          const sessionId = row.session_id || "migrated";
          const obs: CompressedObservation = {
            id: row.id || generateId("mig"),
            sessionId,
            timestamp: row.created_at || new Date().toISOString(),
            type: row.type || "other",
            title: row.title || row.summary || "Migrated observation",
            subtitle: row.subtitle,
            facts: safeJsonParse(row.facts, []),
            narrative: row.narrative || row.content || "",
            concepts: safeJsonParse(row.concepts, []),
            files: safeJsonParse(row.files, []),
            importance: row.importance || 5,
          };
          await kv.set(KV.observations(sessionId), obs.id, obs);
          obsCount++;
        }

        let summaries: any[] = [];
        try {
          summaries = db
            .prepare("SELECT * FROM session_summaries")
            .all() as any[];
        } catch {
          logger.warn("No summaries table found");
        }

        for (const row of summaries) {
          const summary: SessionSummary = {
            sessionId: row.session_id,
            project: row.project || "unknown",
            createdAt: row.created_at || new Date().toISOString(),
            title: row.title || "Migrated session",
            narrative: row.narrative || row.summary || "",
            keyDecisions: safeJsonParse(row.key_decisions, []),
            filesModified: safeJsonParse(row.files_modified, []),
            concepts: safeJsonParse(row.concepts, []),
            observationCount: row.observation_count || 0,
          };
          await kv.set(KV.summaries, row.session_id, summary);
          summaryCount++;
        }

        logger.info("Migration complete", {
          sessionCount,
          obsCount,
          summaryCount,
        });
        return { success: true, sessionCount, obsCount, summaryCount };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Migration failed", { error: msg });
        return { success: false, error: "Migration failed" };
      } finally {
        try {
          if (db) db.close();
        } catch {}
      }
    },
  );
}

function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (Array.isArray(value)) return value as T;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
}
