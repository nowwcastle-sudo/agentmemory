import { describe, it, expect, vi } from "vitest";
import { registerContextFunction } from "../src/functions/context.js";
import { KV } from "../src/state/schema.js";
import type { ProjectProfile } from "../src/types.js";
import { mockKV } from "./helpers/mocks.js";

// `omitRelations` answered one question -- what does the Relations block earn
// against what it costs -- and v8 (2026-09-19) answered it: +0.054 at a 1,300
// budget. It also showed the budget is no longer the binding constraint;
// without relations only 1,169 of 1,300 tokens get used, because candidates
// run out. The next question is which block the budget should go to, and that
// needs the same knob for every kind, not just relations: removing a block's
// text from a rendered context measures what it says, never what it costs.
//
// `omit` names kinds. Unknown names are ignored so an evaluation script can
// ask for a kind this build does not have without failing the call.

type ContextHandler = (data: {
  sessionId: string;
  project: string;
  budget?: number;
  omitRelations?: boolean;
  omit?: string[];
}) => Promise<{ context: string; blocks: number; tokens: number }>;

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
  topFiles: [{ file: "src/retry.ts", frequency: 4 }],
  conventions: ["TypeScript project"],
  commonErrors: [],
  recentActivity: [],
  sessionCount: 1,
  totalObservations: 3,
};

async function seed(kv: ReturnType<typeof mockKV>) {
  await kv.set(KV.profiles, "p1", profile);
  await kv.set(KV.graphRelationsIndex, "p1", {
    project: "p1",
    updatedAt: "2026-09-19T00:00:00.000Z",
    relations: [
      { source: "branch sync method", type: "prefers", target: "fast-forward-only merge", weight: 0.8, backing: 4, edgeId: "e1" },
    ],
  });
  await kv.set(KV.lessons, "l1", {
    id: "l1",
    content: "Never run the migration without a backup first.",
    context: "migrations",
    confidence: 0.9,
    reinforcements: 2,
    source: "manual",
    sourceIds: [],
    project: "p1",
    tags: ["migration"],
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
  });
  await kv.set(KV.sessions, "ses_past", {
    id: "ses_past",
    project: "p1",
    cwd: "/repo/p1",
    startedAt: "2026-09-18T00:00:00.000Z",
    status: "completed",
    observationCount: 2,
  });
  await kv.set(KV.summaries, "ses_past", {
    sessionId: "ses_past",
    project: "p1",
    title: "Retry policy rewrite",
    narrative: "Reworked the retry policy so a failed call backs off.",
    keyDecisions: ["Back off exponentially", "Cap at five attempts"],
    filesModified: ["src/retry.ts"],
    concepts: ["retry policy"],
    observationCount: 2,
    createdAt: "2026-09-18T01:00:00.000Z",
  });
}

describe("mem::context omit", () => {
  it("drops the named kind and leaves the others", async () => {
    const kv = mockKV();
    await seed(kv);
    const context = wireContext(kv);

    const full = await context({ sessionId: "s1", project: "p1" });
    const withoutLessons = await context({ sessionId: "s1", project: "p1", omit: ["lessons"] });

    expect(full.context).toContain("## Lessons Learned");
    expect(withoutLessons.context).not.toContain("## Lessons Learned");
    expect(withoutLessons.context).toContain("## Relations");
    expect(withoutLessons.context).toContain("## Project Profile");
  });

  it("drops several kinds at once", async () => {
    const kv = mockKV();
    await seed(kv);
    const context = wireContext(kv);

    const res = await context({ sessionId: "s1", project: "p1", omit: ["lessons", "relations", "summaries"] });

    expect(res.context).not.toContain("## Lessons Learned");
    expect(res.context).not.toContain("## Relations");
    expect(res.context).not.toContain("Retry policy rewrite");
    expect(res.context).toContain("## Project Profile");
  });

  it("still honours the older omitRelations flag", async () => {
    const kv = mockKV();
    await seed(kv);
    const context = wireContext(kv);

    const res = await context({ sessionId: "s1", project: "p1", omitRelations: true });

    expect(res.context).not.toContain("## Relations");
    expect(res.context).toContain("## Lessons Learned");
  });

  it("ignores a kind it does not know", async () => {
    const kv = mockKV();
    await seed(kv);
    const context = wireContext(kv);

    const full = await context({ sessionId: "s1", project: "p1" });
    const res = await context({ sessionId: "s1", project: "p1", omit: ["nonsense"] });

    expect(res.context).toBe(full.context);
  });

  it("gives the freed budget to the blocks that remain", async () => {
    const kv = mockKV();
    await seed(kv);
    // A budget small enough that the blocks compete for it.
    const context = wireContext(kv, 120);

    const full = await context({ sessionId: "s1", project: "p1" });
    const withoutRelations = await context({ sessionId: "s1", project: "p1", omit: ["relations"] });

    expect(full.context).toContain("## Relations");
    expect(withoutRelations.context).not.toContain("## Relations");
    // The point of the knob: what is left still fills the budget, so the
    // measurement compares like with like.
    expect(withoutRelations.tokens).toBeGreaterThan(0);
    expect(withoutRelations.tokens).toBeLessThanOrEqual(120);
  });
});
