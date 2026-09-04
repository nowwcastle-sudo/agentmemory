import { describe, expect, it } from "vitest";
import type {
  CompressedObservation,
  Memory,
  RawObservation,
  Session,
  SessionSummary,
} from "../src/types.js";
import { migrateProjectIdentity } from "../src/functions/migrate.js";
import { KV } from "../src/state/schema.js";
import { mockKV } from "./helpers/mocks.js";

const FROM = "agentmemory";
const TO = "git:0123456789abcdef0123456789abcdef";

async function fixture() {
  const kv = mockKV();
  const oldSession: Session = {
    id: "ses_old",
    project: FROM,
    cwd: "/work/agentmemory",
    startedAt: "2026-08-28T00:00:00.000Z",
    status: "completed",
    observationCount: 1,
  };
  const otherSession: Session = {
    ...oldSession,
    id: "ses_other",
    project: "other-project",
    cwd: "/work/other",
  };
  const raw: RawObservation = {
    id: "raw_old",
    sessionId: oldSession.id,
    timestamp: oldSession.startedAt,
    hookType: "prompt_submit",
    raw: { prompt: "hello" },
    projectId: FROM,
  };
  const observation: CompressedObservation = {
    id: "obs_old",
    sessionId: oldSession.id,
    timestamp: oldSession.startedAt,
    type: "discovery",
    title: "legacy observation",
    facts: [],
    narrative: "legacy",
    concepts: [],
    files: [],
    importance: 5,
    projectId: FROM,
  };
  const memory: Memory = {
    id: "mem_old",
    createdAt: oldSession.startedAt,
    updatedAt: oldSession.startedAt,
    type: "fact",
    title: "legacy memory",
    content: "legacy",
    concepts: [],
    files: [],
    sessionIds: [oldSession.id],
    strength: 7,
    version: 1,
    isLatest: true,
    project: FROM,
  };
  const summary: SessionSummary = {
    sessionId: oldSession.id,
    project: FROM,
    createdAt: oldSession.startedAt,
    title: "legacy summary",
    narrative: "legacy",
    keyDecisions: [],
    filesModified: [],
    concepts: [],
    observationCount: 1,
  };
  await kv.set(KV.sessions, oldSession.id, oldSession);
  await kv.set(KV.sessions, otherSession.id, otherSession);
  await kv.set(KV.rawObservations(oldSession.id), raw.id, raw);
  await kv.set(KV.observations(oldSession.id), observation.id, observation);
  await kv.set(KV.memories, memory.id, memory);
  await kv.set(KV.summaries, summary.sessionId, summary);
  return { kv, oldSession, otherSession, raw, observation, memory, summary };
}

describe("migrateProjectIdentity", () => {
  it("is dry-run by default and reports every exact legacy match", async () => {
    const { kv } = await fixture();

    const result = await migrateProjectIdentity(kv, {
      fromProject: FROM,
      toProjectId: TO,
      toProjectName: "AgentMemory",
    });

    expect(result).toMatchObject({
      success: true,
      dryRun: true,
      matched: {
        sessions: 1,
        rawObservations: 1,
        observations: 1,
        memories: 1,
        summaries: 1,
      },
      requiresGraphRebuild: true,
      requiresIndexRebuild: true,
    });
    expect((await kv.get<Session>(KV.sessions, "ses_old"))?.project).toBe(FROM);
  });

  it("requires snapshot confirmation before applying", async () => {
    const { kv } = await fixture();

    await expect(
      migrateProjectIdentity(kv, {
        fromProject: FROM,
        toProjectId: TO,
        toProjectName: "AgentMemory",
        dryRun: false,
      }),
    ).rejects.toThrow(/snapshot/i);
  });

  it("updates canonical rows only, leaves other projects untouched, and is idempotent", async () => {
    const { kv } = await fixture();
    const input = {
      fromProject: FROM,
      toProjectId: TO,
      toProjectName: "AgentMemory",
      dryRun: false,
      snapshotConfirmed: true,
    } as const;

    const first = await migrateProjectIdentity(kv, input);
    expect(first.updated).toEqual(first.matched);
    expect(await kv.get<Session>(KV.sessions, "ses_old")).toMatchObject({
      project: TO,
      projectName: "AgentMemory",
    });
    expect(await kv.get<RawObservation>(KV.rawObservations("ses_old"), "raw_old")).toMatchObject({
      projectId: TO,
      projectName: "AgentMemory",
    });
    expect(await kv.get<CompressedObservation>(KV.observations("ses_old"), "obs_old")).toMatchObject({
      projectId: TO,
      projectName: "AgentMemory",
    });
    expect(await kv.get<Memory>(KV.memories, "mem_old")).toMatchObject({
      project: TO,
      projectName: "AgentMemory",
    });
    expect(await kv.get<SessionSummary>(KV.summaries, "ses_old")).toMatchObject({
      project: TO,
      projectName: "AgentMemory",
    });
    expect((await kv.get<Session>(KV.sessions, "ses_other"))?.project).toBe("other-project");

    const second = await migrateProjectIdentity(kv, input);
    expect(second.matched).toEqual({
      sessions: 0,
      rawObservations: 0,
      observations: 0,
      memories: 0,
      summaries: 0,
    });
  });
});
