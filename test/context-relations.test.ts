import { describe, it, expect, vi } from "vitest";
import { registerContextFunction } from "../src/functions/context.js";
import { KV } from "../src/state/schema.js";
import type { ProjectProfile } from "../src/types.js";
import { mockKV } from "./helpers/mocks.js";

// The injected context block never carried a graph relation. It now reads the
// project's relations index row -- one get -- and renders a ## Relations block.

type ContextHandler = (data: { sessionId: string; project: string; budget?: number }) =>
  Promise<{ context: string; blocks: number; tokens: number }>;

function wireContext(kv: ReturnType<typeof mockKV>, budget = 4000): ContextHandler {
  let handler: ContextHandler | undefined;
  const sdk = {
    registerFunction: vi.fn((id: string, cb: ContextHandler) => {
      if (id === "mem::context") handler = cb;
    }),
  } as unknown as import("iii-sdk").ISdk;
  registerContextFunction(sdk, kv as never, budget);
  if (!handler) throw new Error("mem::context not registered");
  return handler;
}

const profile: ProjectProfile = {
  project: "p1",
  updatedAt: "2026-09-10T00:00:00.000Z",
  topConcepts: [{ concept: "retry policy", frequency: 9 }],
  topFiles: [],
  conventions: [],
  commonErrors: [],
  recentActivity: [],
  sessionCount: 1,
  totalObservations: 3,
};

describe("mem::context relations block", () => {
  // The session window already leaves out the session asking; relations it
  // produced itself are the same kind of echo. Measured 2026-09-18: the
  // relations-effect spike's strongest case cited "Observation #4 --uses-->
  // Get-CimInstance", extracted from the very session under test.
  it("leaves out relations the asking session produced itself", async () => {
    const kv = mockKV();
    await kv.set(KV.profiles, "p1", profile);
    await kv.set(KV.graphRelationsIndex, "p1", {
      project: "p1",
      updatedAt: "2026-09-11T00:00:00.000Z",
      relations: [
        { source: "own echo", type: "uses", target: "Get-CimInstance", weight: 0.9, backing: 4, edgeId: "e_own", sessions: ["s_now"] },
        { source: "shared", type: "causes", target: "both", weight: 0.9, backing: 4, edgeId: "e_shared", sessions: ["s_now", "s_old"] },
        { source: "earlier work", type: "causes", target: "timeout", weight: 0.9, backing: 4, edgeId: "e_old", sessions: ["s_old"] },
        { source: "no provenance", type: "causes", target: "anything", weight: 0.9, backing: 4, edgeId: "e_none" },
      ],
    });
    const result = await wireContext(kv)({ sessionId: "s_now", project: "p1" });
    expect(result.context).not.toContain("own echo");
    expect(result.context).not.toContain("shared --causes");
    expect(result.context).toContain("earlier work --causes--> timeout");
    expect(result.context).toContain("no provenance --causes--> anything");
  });

  it("renders the project's typed relations from the index row and lists no graph scope", async () => {
    const kv = mockKV();
    const listed: string[] = [];
    const list = kv.list.bind(kv);
    kv.list = (async <T,>(scope: string): Promise<T[]> => {
      listed.push(scope);
      return list<T>(scope);
    }) as typeof kv.list;
    await kv.set(KV.profiles, "p1", profile);
    await kv.set(KV.graphRelationsIndex, "p1", {
      project: "p1",
      updatedAt: "2026-09-11T00:00:00.000Z",
      relations: [
        { source: "cache", type: "implements", target: "src/cache.ts", weight: 0.95, backing: 80, edgeId: "e2" },
        { source: "retry policy", type: "implements", target: "src/retry.ts", weight: 0.7, backing: 3, edgeId: "e1" },
      ],
    });

    const context = wireContext(kv);
    const result = await context({ sessionId: "s_now", project: "p1" });

    expect(result.context).toContain("## Relations");
    expect(result.context).toContain("- retry policy --implements--> src/retry.ts (3 obs)");
    expect(result.context).toContain("- cache --implements--> src/cache.ts (80 obs)");
    expect(result.context.indexOf("retry policy --implements")).toBeLessThan(result.context.indexOf("cache --implements"));
    expect(listed).not.toContain(KV.graphNodes);
    expect(listed).not.toContain(KV.graphEdges);
    expect(listed).not.toContain(KV.graphRelationsIndex);
  });

  it("lets the session's first prompt and files decide which relations lead", async () => {
    const kv = mockKV();
    await kv.set(KV.profiles, "p1", profile);
    await kv.set(KV.graphRelationsIndex, "p1", {
      project: "p1",
      updatedAt: "2026-09-11T00:00:00.000Z",
      relations: [
        { source: "retry policy", type: "implements", target: "src/retry.ts", weight: 0.7, backing: 3, edgeId: "e1" },
        { source: "cache", type: "implements", target: "src/cache.ts", weight: 0.95, backing: 80, edgeId: "e2" },
        { source: "logging", type: "uses", target: "src/log.ts", weight: 0.6, backing: 5, edgeId: "e3" },
      ],
    });
    // The current session: its row carries the first prompt; its observations name files.
    await kv.set(KV.sessions, "s_now", { id: "s_now", project: "p1", cwd: "/r", startedAt: "2026-09-11T00:00:00.000Z", status: "active", observationCount: 1, firstPrompt: "why does logging drop lines" });
    await kv.set(KV.observations("s_now"), "o1", { id: "o1", sessionId: "s_now", timestamp: "2026-09-11T00:00:00.000Z", type: "file_edit", title: "Edit log.ts", facts: [], narrative: "", concepts: [], files: ["src/log.ts"], importance: 5 });

    const context = wireContext(kv);
    const result = await context({ sessionId: "s_now", project: "p1" });
    const i = (s: string) => result.context.indexOf(s);
    expect(i("- logging --uses--> src/log.ts")).toBeGreaterThan(-1);
    expect(i("- logging --uses--> src/log.ts")).toBeLessThan(i("- retry policy --implements-->"));
    expect(i("- retry policy --implements-->")).toBeLessThan(i("- cache --implements-->"));
  });

  it("omits the block when the project has no index row", async () => {
    const kv = mockKV();
    await kv.set(KV.profiles, "p1", profile);
    const context = wireContext(kv);
    const result = await context({ sessionId: "s_now", project: "p1" });
    expect(result.context).not.toContain("## Relations");
  });

  // Blocks are filled newest-first against the token budget, and a session's
  // block took its recency from the summary's createdAt while the same loop's
  // observation branch took it from the session's startedAt. Re-summarizing
  // therefore reordered the context: a backfill on 2026-09-17 gave 303 of 429
  // summaries a createdAt more than a day after their session -- one by 21
  // days -- and a three-week-old session outranked a relations index rebuilt
  // the day before, taking the whole budget with it.
  it("ranks a session by when it happened, not by when its summary was written", async () => {
    const kv = mockKV();
    await kv.set(KV.profiles, "p1", profile);
    await kv.set(KV.sessions, "s_old", {
      id: "s_old",
      project: "p1",
      cwd: "/repo",
      startedAt: "2026-08-27T00:00:00.000Z",
      status: "completed",
      observationCount: 4,
    });
    await kv.set(KV.summaries, "s_old", {
      sessionId: "s_old",
      project: "p1",
      createdAt: "2026-09-17T00:00:00.000Z", // backfilled three weeks later
      title: "An old session summarized today",
      narrative: "Work that happened three weeks before this summary was written.",
      keyDecisions: ["Chose the old approach for the old reason"],
      filesModified: ["src/old.ts"],
      concepts: ["old work"],
      observationCount: 4,
    });
    await kv.set(KV.graphRelationsIndex, "p1", {
      project: "p1",
      updatedAt: "2026-09-16T00:00:00.000Z", // newer than the session, older than the backfill
      relations: [
        { source: "retry policy", type: "rejected", target: "blanket sleep", weight: 0.9, backing: 4, edgeId: "e_keep" },
      ],
    });

    // Room for one of the two.
    const context = wireContext(kv, 90);
    const result = await context({ sessionId: "s_now", project: "p1" });
    expect(result.context).toContain("## Relations");
    expect(result.context).not.toContain("An old session summarized today");
  });

  // A scheduled task files a session every run and the window is the ten
  // newest. 2026-09-18, one project: 3 of the 6 summarized sessions in its
  // window were runs of the same daily task. The first attempt keyed on the
  // first 120 characters of any prompt and collapsed unrelated work that
  // shared the harness's compaction boilerplate, so this keys only on the
  // task name the scheduler writes at the very start of the prompt.
  describe("scheduled-task runs share one window slot", () => {
    const seed = async (
      kv: ReturnType<typeof mockKV>,
      id: string,
      startedAt: string,
      firstPrompt: string,
      title: string,
    ) => {
      await kv.set(KV.sessions, id, {
        id, project: "p1", cwd: "/repo", startedAt, status: "completed",
        observationCount: 3, firstPrompt,
      });
      await kv.set(KV.summaries, id, {
        sessionId: id, project: "p1", createdAt: startedAt, title,
        narrative: "narrative", keyDecisions: ["a decision"], filesModified: [],
        concepts: [], observationCount: 3,
      });
    };
    const task = (name: string) =>
      `<scheduled-task name="${name}" file="C:\\tasks\\${name}\\SKILL.md">\nRun it.`;

    it("keeps only the newest run of each task and reaches further back", async () => {
      const kv = mockKV();
      await kv.set(KV.profiles, "p1", profile);
      await seed(kv, "t_new", "2026-09-17T11:00:00.000Z", task("nightly-check"), "Nightly check — no changes");
      await seed(kv, "t_mid", "2026-09-16T11:00:00.000Z", task("nightly-check"), "Nightly check — nothing applied");
      await seed(kv, "o_new", "2026-09-16T10:00:00.000Z", task("other-job"), "Other job — ran");
      for (let d = 0; d < 9; d++) {
        const day = String(15 - d).padStart(2, "0");
        await seed(kv, `w_${d}`, `2026-09-${day}T09:00:00.000Z`, `Real work item ${d}`, `Real work ${d}`);
      }
      const result = await wireContext(kv)({ sessionId: "s_now", project: "p1" });
      expect(result.context).toContain("Nightly check — no changes");
      expect(result.context).not.toContain("Nightly check — nothing applied");
      expect(result.context).toContain("Other job — ran");
      // 1 + 1 task slots leave 8 for real work: 0..7 land, 8 does not.
      expect(result.context).toContain("Real work 7");
      expect(result.context).not.toContain("Real work 8");
    });

    // Codex runs side sessions of its own -- ambient suggestions, a safety
    // filter over them, a memory-consolidation agent. 97 of them on
    // 2026-09-18, and a suggestion run's summary reads like a decision that
    // was made ("Prioritize lossless recovery of worker 3111"). They are not
    // the owner's work, so they take no window slot.
    it("leaves codex's own side sessions out of the window", async () => {
      const kv = mockKV();
      await kv.set(KV.profiles, "p1", profile);
      await seed(kv, "x1", "2026-09-17T12:00:00.000Z",
        "# Overview\nGenerate 0 to 3 hyperpersonalized suggestions for what this user", "Suggestion run");
      await seed(kv, "x2", "2026-09-17T11:00:00.000Z",
        "You are an expert at upholding safety and compliance standards for Codex", "Safety filter run");
      await seed(kv, "x3", "2026-09-17T10:00:00.000Z",
        "## Memory Writing Agent: Phase 2 (Consolidation)\nYou are a Memory Writing Agent", "Consolidation run");
      await seed(kv, "w1", "2026-09-16T10:00:00.000Z",
        "[Base] You are operating inside the Buzz platform", "Buzz agent work");
      for (let d = 0; d < 9; d++) {
        await seed(kv, `r_${d}`, `2026-09-${String(15 - d).padStart(2, "0")}T09:00:00.000Z`, `Real item ${d}`, `Real item work ${d}`);
      }
      const result = await wireContext(kv)({ sessionId: "s_now", project: "p1" });
      for (const t of ["Suggestion run", "Safety filter run", "Consolidation run"]) {
        expect(result.context).not.toContain(t);
      }
      expect(result.context).toContain("Buzz agent work");
      // Buzz + 9 real sessions fill all ten slots.
      expect(result.context).toContain("Real item work 8");
    });

    it("never merges sessions that only share an opening, like the compaction boilerplate", async () => {
      const kv = mockKV();
      await kv.set(KV.profiles, "p1", profile);
      const boiler =
        "Below is a conversation log from a Claude Code coding session. Create a summary to help the next session";
      await seed(kv, "b1", "2026-09-17T00:00:00.000Z", `${boiler} A`, "Boilerplate work A");
      await seed(kv, "b2", "2026-09-16T00:00:00.000Z", `${boiler} B`, "Boilerplate work B");
      await seed(kv, "b3", "2026-09-15T00:00:00.000Z", `${boiler} C`, "Boilerplate work C");
      // A tag later in the prompt is quoted text, not a scheduler run.
      await seed(kv, "q1", "2026-09-14T00:00:00.000Z", `See ${task("nightly-check")}`, "Quoted tag one");
      await seed(kv, "q2", "2026-09-13T00:00:00.000Z", `Also ${task("nightly-check")}`, "Quoted tag two");
      const result = await wireContext(kv)({ sessionId: "s_now", project: "p1" });
      for (const t of ["Boilerplate work A", "Boilerplate work B", "Boilerplate work C", "Quoted tag one", "Quoted tag two"]) {
        expect(result.context).toContain(t);
      }
    });
  });

  it("drops the block, not the rest, when it does not fit the budget", async () => {
    const kv = mockKV();
    await kv.set(KV.profiles, "p1", profile);
    const relations = Array.from({ length: 12 }, (_, i) => ({
      source: `concept number ${i} with a long name`, type: "uses", target: `src/some/deep/path/file_${i}.ts`, weight: 0.9, backing: 10, edgeId: `e${i}`,
    }));
    await kv.set(KV.graphRelationsIndex, "p1", { project: "p1", updatedAt: "2026-09-11T00:00:00.000Z", relations });
    const context = wireContext(kv, 120);
    const result = await context({ sessionId: "s_now", project: "p1" });
    expect(result.context).toContain("## Project Profile");
    expect(result.context).not.toContain("## Relations");
  });
});
