import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerContextFunction } from "../src/functions/context.js";
import { KV } from "../src/state/schema.js";
import type { Insight, ProjectProfile } from "../src/types.js";
import { toIndexRow } from "../src/functions/insight-index.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      if (!store.has(scope)) return [];
      return Array.from(store.get(scope)!.values()) as T[];
    },
  };
}

type ContextHandler = (data: {
  sessionId: string;
  project: string;
  budget?: number;
}) => Promise<{ context: string; blocks: number; tokens: number }>;

function wireContext(kv: ReturnType<typeof mockKV>, budget = 4000) {
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

function makeInsight(over: Partial<Insight> = {}): Insight {
  const now = new Date().toISOString();
  return {
    id: over.id ?? `insight_${Math.random().toString(36).slice(2)}`,
    title: over.title ?? "default insight title",
    content: over.content ?? "default insight content",
    confidence: over.confidence ?? 0.8,
    reinforcements: over.reinforcements ?? 0,
    sourceConceptCluster: over.sourceConceptCluster ?? ["anchor"],
    sourceMemoryIds: over.sourceMemoryIds ?? [],
    sourceLessonIds: over.sourceLessonIds ?? [],
    sourceCrystalIds: over.sourceCrystalIds ?? [],
    project: over.project,
    tags: over.tags ?? [],
    createdAt: over.createdAt ?? now,
    updatedAt: over.updatedAt ?? now,
    lastReinforcedAt: over.lastReinforcedAt,
    lastDecayedAt: over.lastDecayedAt,
    decayRate: over.decayRate ?? 0.05,
    deleted: over.deleted,
  };
}

async function seedInsight(kv: ReturnType<typeof mockKV>, partial: Partial<Insight>) {
  const insight = makeInsight(partial);
  await kv.set(KV.insights, insight.id, insight);
  return insight;
}

async function seedProfile(kv: ReturnType<typeof mockKV>, project: string, concepts: string[]) {
  const profile: ProjectProfile = {
    project,
    updatedAt: new Date().toISOString(),
    topConcepts: concepts.map((concept, i) => ({ concept, frequency: 10 - i })),
    topFiles: [],
    conventions: [],
    commonErrors: [],
    recentActivity: [],
    sessionCount: 1,
    totalObservations: 1,
  };
  await kv.set(KV.profiles, project, profile);
}

describe("mem::context — insights auto-injection (ontology-lite follow-up)", () => {
  let kv: ReturnType<typeof mockKV>;
  let handler: ContextHandler;

  beforeEach(() => {
    kv = mockKV();
    handler = wireContext(kv);
  });

  it("includes an 'Insights' block carrying title and content", async () => {
    await seedProfile(kv, "/tmp/proj", ["anchor"]);
    await seedInsight(kv, {
      id: "insight_a",
      title: "canonical-key-marker",
      content: "normalize names before dedup",
      confidence: 0.9,
    });
    const result = await handler({ sessionId: "ses_a", project: "/tmp/proj" });
    expect(result.context).toContain("## Insights");
    expect(result.context).toContain("canonical-key-marker");
    expect(result.context).toContain("normalize names before dedup");
  });

  it("omits the block when there are no insights, and ignores deleted ones", async () => {
    let result = await handler({ sessionId: "ses_empty", project: "/tmp/proj" });
    expect(result.context).not.toContain("## Insights");

    await seedInsight(kv, { id: "insight_deleted", title: "deleted-insight-marker", deleted: true });
    result = await handler({ sessionId: "ses_deleted", project: "/tmp/proj" });
    expect(result.context).not.toContain("## Insights");
    expect(result.context).not.toContain("deleted-insight-marker");
  });

  it("caps the block at five insights ordered by score", async () => {
    await seedProfile(kv, "/tmp/proj", ["anchor"]);
    for (let i = 0; i < 7; i++) {
      await seedInsight(kv, {
        id: `insight_${i}`,
        title: `cap-marker-${i}`,
        confidence: 0.5 + i * 0.05, // 0.50 .. 0.80
      });
    }
    const result = await handler({ sessionId: "ses_cap", project: "/tmp/proj" });
    for (const i of [6, 5, 4, 3, 2]) expect(result.context).toContain(`cap-marker-${i}`);
    for (const i of [1, 0]) expect(result.context).not.toContain(`cap-marker-${i}`);
  });

  // Unrelated insights are no longer candidates (see the next test), so the
  // boost now orders insights that do overlap: more overlap outranks a little
  // more confidence.
  it("ranks the insight with more concept overlap above a slightly more confident one", async () => {
    await seedProfile(kv, "/tmp/proj", ["graph schema", "TypeScript"]);
    // 0.80 * (1 + 0.5 * 1/2) = 1.000
    await seedInsight(kv, {
      id: "insight_related",
      title: "strong-overlap-marker",
      confidence: 0.8,
      sourceConceptCluster: ["Graph Schema", "validation"],
    });
    // 0.85 * (1 + 0.5 * 1/4) = 0.956
    await seedInsight(kv, {
      id: "insight_weaker",
      title: "weak-overlap-marker",
      confidence: 0.85,
      sourceConceptCluster: ["graph schema", "cooking", "travel", "music"],
    });
    const result = await handler({ sessionId: "ses_rank", project: "/tmp/proj" });
    const strong = result.context.indexOf("strong-overlap-marker");
    const weak = result.context.indexOf("weak-overlap-marker");
    expect(strong).toBeGreaterThan(-1);
    expect(weak).toBeGreaterThan(-1);
    expect(strong).toBeLessThan(weak);
  });

  // 2026-09-18: every one of 29 projects received the same five project-less
  // insights (CAP25 validation, one project's PR governance), three of them
  // saying the same thing, because relevance only boosted the score. A
  // project-less insight now has to share a concept with the project.
  it("leaves out a project-less insight that shares no concept with the project", async () => {
    await seedProfile(kv, "/tmp/proj", ["graph schema"]);
    await seedInsight(kv, { id: "i_rel", title: "shares-a-concept", sourceConceptCluster: ["Graph Schema"] });
    await seedInsight(kv, { id: "i_unrel", title: "shares-nothing", confidence: 0.99, sourceConceptCluster: ["cooking"] });
    const result = await handler({ sessionId: "ses_gate", project: "/tmp/proj" });
    expect(result.context).toContain("shares-a-concept");
    expect(result.context).not.toContain("shares-nothing");
  });

  it("leaves out project-less insights when the project has no profile concepts", async () => {
    await seedInsight(kv, { id: "i_any", title: "global-without-anchor", sourceConceptCluster: ["anything"] });
    const result = await handler({ sessionId: "ses_noprof", project: "/tmp/proj" });
    expect(result.context).not.toContain("## Insights");
  });

  it("keeps an insight scoped to this project without any concept overlap", async () => {
    await seedInsight(kv, { id: "i_own", title: "own-project-insight", project: "/tmp/proj" });
    const result = await handler({ sessionId: "ses_own", project: "/tmp/proj" });
    expect(result.context).toContain("own-project-insight");
  });

  it("excludes insights scoped to another project and keeps global ones", async () => {
    await seedProfile(kv, "/tmp/proj", ["anchor"]);
    await seedInsight(kv, { id: "insight_other", title: "other-project-insight", project: "/tmp/other" });
    await seedInsight(kv, { id: "insight_global", title: "global-insight-marker", project: undefined });
    const result = await handler({ sessionId: "ses_scope", project: "/tmp/proj" });
    expect(result.context).not.toContain("other-project-insight");
    expect(result.context).toContain("global-insight-marker");
  });
});

describe("mem::context — reads the insight index, not the whole scope", () => {
  let kv: ReturnType<typeof mockKV>;
  let handler: ContextHandler;

  beforeEach(() => {
    kv = mockKV();
    handler = wireContext(kv);
  });

  it("serves insights from the index without listing mem:insights", async () => {
    await seedProfile(kv, "/tmp/proj", ["anchor"]);
    const listed: string[] = [];
    const inner = kv.list;
    kv.list = async <T>(scope: string): Promise<T[]> => {
      listed.push(scope);
      return inner<T>(scope);
    };
    const insight = makeInsight({
      id: "insight_idx",
      title: "index-only-marker",
      content: "served from the index row",
      confidence: 0.9,
    });
    await kv.set(KV.insightIndex, insight.id, toIndexRow(insight));

    const result = await handler({ sessionId: "ses_idx", project: "/tmp/proj" });
    expect(result.context).toContain("index-only-marker");
    expect(result.context).toContain("served from the index row");
    expect(listed).toContain(KV.insightIndex);
    expect(listed).not.toContain(KV.insights);
  });

  it("scores concept overlap against the true cluster size, not the stored prefix", async () => {
    await seedProfile(kv, "/tmp/proj", ["alpha", "beta", "gamma", "delta"]);
    // A: all four stored names match, cluster really is four -> overlap 1.0
    //    score 0.80 * 1.5 = 1.20
    // B: same four stored names match, but the true cluster is eight -> 0.5
    //    score 0.85 * 1.25 = 1.0625; ranked by the prefix alone it would be
    //    0.85 * 1.5 = 1.275 and B would wrongly come first.
    const four = ["alpha", "beta", "gamma", "delta"];
    await kv.set(KV.insightIndex, "ins_a", {
      ...toIndexRow(makeInsight({ id: "ins_a", title: "exact-four-marker", confidence: 0.8, sourceConceptCluster: four })),
      clusterSize: 4,
    });
    await kv.set(KV.insightIndex, "ins_b", {
      ...toIndexRow(makeInsight({ id: "ins_b", title: "wide-eight-marker", confidence: 0.85, sourceConceptCluster: four })),
      clusterSize: 8,
    });
    const result = await handler({ sessionId: "ses_size", project: "/tmp/proj" });
    const a = result.context.indexOf("exact-four-marker");
    const b = result.context.indexOf("wide-eight-marker");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
  });

  // Regression guard for stores that predate the index: behaviour is
  // unchanged, only slower, until mem::insight-index-rebuild has run.
  it("falls back to the full scope when the index is empty", async () => {
    await seedProfile(kv, "/tmp/proj", ["anchor"]);
    await seedInsight(kv, { id: "insight_legacy", title: "legacy-scope-marker" });
    const result = await handler({ sessionId: "ses_legacy", project: "/tmp/proj" });
    expect(result.context).toContain("legacy-scope-marker");
  });
});
