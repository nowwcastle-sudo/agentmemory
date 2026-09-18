import { describe, it, expect, vi } from "vitest";
import { registerContextFunction } from "../src/functions/context.js";
import { KV } from "../src/state/schema.js";
import { toIndexRow } from "../src/functions/insight-index.js";
import type { Insight } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      store.has(scope) ? (Array.from(store.get(scope)!.values()) as T[]) : [],
  };
}

type ContextHandler = (data: { sessionId: string; project: string; budget?: number }) =>
  Promise<{ context: string; blocks: number; tokens: number }>;

function wireContext(kv: ReturnType<typeof mockKV>, budget: number): ContextHandler {
  let handler: ContextHandler | undefined;
  const sdk = {
    registerFunction: vi.fn((id: string, cb: ContextHandler) => {
      if (id === "mem::context") handler = cb;
    }),
  } as unknown as import("iii-sdk").ISdk;
  registerContextFunction(sdk, kv as never, budget);
  return handler!;
}

const NOW = Date.now();
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

async function seed(kv: ReturnType<typeof mockKV>) {
  // The insights share a concept with the project, as they must to be shown.
  await kv.set(KV.profiles, "p1", {
    project: "p1", updatedAt: iso(0), topConcepts: [{ concept: "anchor", frequency: 1 }],
    topFiles: [], conventions: [], commonErrors: [], recentActivity: [], sessionCount: 1, totalObservations: 1,
  });
  // Five insights, the newest material, each with a long preview: the block
  // is ~430 tokens in full and ~60 as titles only.
  for (let i = 0; i < 5; i++) {
    const insight: Insight = {
      id: `ins_${i}`, title: `Insight title ${i}`, content: `insight body ${i} `.repeat(30),
      confidence: 0.9 - i * 0.01, reinforcements: 0, sourceConceptCluster: ["anchor"],
      sourceMemoryIds: [], sourceLessonIds: [], sourceCrystalIds: [], tags: [],
      createdAt: iso(1), updatedAt: iso(1), decayRate: 0.05,
    };
    await kv.set(KV.insightIndex, insight.id, toIndexRow(insight));
  }
  // Three summarized sessions, each ~210 tokens in full.
  for (const [id, hoursAgo] of [["a", 2], ["b", 3], ["c", 4]] as const) {
    await kv.set(KV.sessions, `s_${id}`, {
      id: `s_${id}`, project: "p1", cwd: "/repo", startedAt: iso(hoursAgo),
      status: "completed", observationCount: 3,
    });
    await kv.set(KV.summaries, `s_${id}`, {
      sessionId: `s_${id}`, project: "p1", createdAt: iso(hoursAgo), title: `Session title ${id}`,
      narrative: `narrative-${id} `.repeat(50), keyDecisions: [`decision ${id}`],
      filesModified: [`src/${id}.ts`], concepts: [], observationCount: 3,
    });
  }
}

// 2026-09-18, 29 projects at the live budget of 1000: a block that did not
// fit whole was dropped whole. The 550-token insights block and the session
// summaries were either/or -- six projects showed no session at all, thirteen
// no insights. The fill now places every block's short form first, newest
// first, then spends what is left upgrading blocks to full, newest first.
describe("mem::context budget fill", () => {
  it("fits every kind in short form before any block gets its detail", async () => {
    const kv = mockKV();
    await seed(kv);
    const { context } = await wireContext(kv, 400)({ sessionId: "s_now", project: "p1" });

    expect(context).toContain("## Insights");
    for (let i = 0; i < 5; i++) expect(context).toContain(`Insight title ${i}`);
    for (const id of ["a", "b", "c"]) {
      expect(context).toContain(`Session title ${id}`);
      expect(context).toContain(`decision ${id}`);
    }
    // Detail goes to the newest block that still fits in full.
    expect(context).toContain("narrative-a");
    expect(context).not.toContain("narrative-b");
    expect(context).not.toContain("insight body 0");
  });

  it("renders every block in full when the budget allows", async () => {
    const kv = mockKV();
    await seed(kv);
    const { context } = await wireContext(kv, 100_000)({ sessionId: "s_now", project: "p1" });
    for (const id of ["a", "b", "c"]) {
      expect(context).toContain(`narrative-${id}`);
      expect(context).toContain(`src/${id}.ts`);
    }
    expect(context).toContain("insight body 0");
  });

  it("keeps blocks in recency order whatever form they take", async () => {
    const kv = mockKV();
    await seed(kv);
    const { context } = await wireContext(kv, 400)({ sessionId: "s_now", project: "p1" });
    const order = ["## Insights", "Session title a", "Session title b", "Session title c"]
      .map((marker) => context.indexOf(marker));
    expect(order.every((pos) => pos >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it("stays within the budget", async () => {
    const kv = mockKV();
    await seed(kv);
    const result = await wireContext(kv, 400)({ sessionId: "s_now", project: "p1" });
    expect(result.tokens).toBeLessThanOrEqual(400);
  });
});
