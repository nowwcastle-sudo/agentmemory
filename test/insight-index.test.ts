import { describe, it, expect } from "vitest";
import {
  INSIGHT_PREVIEW_CHARS,
  toIndexRow,
  writeInsight,
  rebuildInsightIndex,
} from "../src/functions/insight-index.js";
import { KV } from "../src/state/schema.js";
import type { Insight } from "../src/types.js";

// The context path lists every insight on every session and keeps five, so
// the scope's full size (23.8 MB on the live store, 1,505 rows) crosses the
// engine socket for a few hundred bytes of output. The index is what the
// context path actually consumes: the scoring fields and a 240-character
// preview, nothing else. These tests pin that contract.

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
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function makeInsight(over: Partial<Insight> = {}): Insight {
  const now = "2026-09-10T12:00:00.000Z";
  return {
    id: over.id ?? "ins_1",
    title: over.title ?? "title",
    content: over.content ?? "content",
    confidence: over.confidence ?? 0.8,
    reinforcements: 0,
    sourceConceptCluster: over.sourceConceptCluster ?? ["graph"],
    sourceMemoryIds: [],
    sourceLessonIds: [],
    sourceCrystalIds: [],
    project: over.project,
    tags: [],
    createdAt: now,
    updatedAt: over.updatedAt ?? now,
    lastReinforcedAt: over.lastReinforcedAt,
    decayRate: 0.05,
    deleted: over.deleted,
  };
}

describe("insight index", () => {
  it("keeps the scoring fields and a bounded preview, and drops the content", () => {
    const long = "x".repeat(INSIGHT_PREVIEW_CHARS * 3);
    const row = toIndexRow(makeInsight({ content: long, project: "/p", confidence: 0.7 }));
    expect(row.preview).toHaveLength(INSIGHT_PREVIEW_CHARS);
    expect(row).not.toHaveProperty("content");
    expect(row).toMatchObject({
      id: "ins_1",
      title: "title",
      confidence: 0.7,
      project: "/p",
      sourceConceptCluster: ["graph"],
    });
  });

  it("writes the insight and its index row together", async () => {
    const kv = mockKV();
    const insight = makeInsight({ id: "ins_w", content: "body" });
    await writeInsight(kv as never, insight);
    expect(await kv.get(KV.insights, "ins_w")).toEqual(insight);
    expect(await kv.get(KV.insightIndex, "ins_w")).toEqual(toIndexRow(insight));
  });

  it("rebuilds the index from the full scope and reports the row count", async () => {
    const kv = mockKV();
    await kv.set(KV.insights, "a", makeInsight({ id: "a" }));
    await kv.set(KV.insights, "b", makeInsight({ id: "b", deleted: true }));
    const result = await rebuildInsightIndex(kv as never);
    expect(result).toEqual({ rows: 2 });
    const rows = await kv.list<{ id: string; deleted?: boolean }>(KV.insightIndex);
    expect(rows.map((r) => r.id).sort()).toEqual(["a", "b"]);
    // Deleted insights stay in the index flagged, so the reader can filter
    // them the same way it filters the full scope today.
    expect(rows.find((r) => r.id === "b")?.deleted).toBe(true);
  });
});
