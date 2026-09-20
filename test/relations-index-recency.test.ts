import { describe, it, expect } from "vitest";
import {
  toRelationRow,
  upsertRelation,
  RELATIONS_INDEX_CAP,
  type ProjectRelationsIndex,
} from "../src/functions/graph-relations-index.js";
import type { GraphEdge } from "../src/types.js";

// The index keeps 200 rows per project and cuts the rest, so a judgment that
// does not survive the cut can never be rendered. Measured 2026-09-20 over
// the 30 recall questions, replaying the cap offline: today's order kept a
// judgment scoring >= 0.8 against the question for 5 questions; ordering
// judgments newest-first kept one for 11, and lost one.
//
// The cause is what the order rewards. `weight x log(1 + backing)` rewards
// repetition: a command run fifty times outranks a decision stated once. A
// decision is stated once by definition, and it is in force because it is
// recent, not because it recurs.
//
// Structural rows keep the old order: they describe the code, where
// repetition really is evidence.

const edge = (
  id: string,
  type: string,
  backing: number,
  createdAt: string,
): GraphEdge =>
  ({
    id,
    type,
    sourceNodeId: `${id}-s`,
    targetNodeId: `${id}-t`,
    weight: 0.8,
    sourceObservationIds: Array.from({ length: backing }, (_, i) => `obs_${id}_${i}`),
    createdAt,
  }) as GraphEdge;

const emptyIndex = (): ProjectRelationsIndex => ({ project: "p1", updatedAt: "", relations: [] });

describe("relation rows carry when the edge was made", () => {
  it("keeps the edge's createdAt on the row", () => {
    const row = toRelationRow(edge("e1", "prefers", 1, "2026-09-20T00:00:00.000Z"), "a", "b");

    expect(row.createdAt).toBe("2026-09-20T00:00:00.000Z");
  });

  it("leaves it out when the edge has none", () => {
    const bare = { ...edge("e2", "prefers", 1, "") } as GraphEdge;
    delete (bare as { createdAt?: string }).createdAt;

    expect(toRelationRow(bare, "a", "b").createdAt).toBeUndefined();
  });
});

describe("what survives the 200-row cap", () => {
  it("keeps a recent judgment over a much-repeated older one", () => {
    let index = emptyIndex();
    // 200 old judgments, each backed fifty times: today's order fills the cap
    // with these and nothing else fits.
    for (let i = 0; i < RELATIONS_INDEX_CAP; i++) {
      index = upsertRelation(
        index,
        toRelationRow(edge(`old_${i}`, "prefers", 50, "2026-08-01T00:00:00.000Z"), `old source ${i}`, "old target"),
      );
    }
    index = upsertRelation(
      index,
      toRelationRow(edge("new", "prefers", 1, "2026-09-20T00:00:00.000Z"), "today's decision", "what was chosen"),
    );

    expect(index.relations).toHaveLength(RELATIONS_INDEX_CAP);
    expect(index.relations.some((r) => r.edgeId === "new")).toBe(true);
  });

  it("still puts judgments ahead of structural rows", () => {
    let index = emptyIndex();
    index = upsertRelation(index, toRelationRow(edge("struct", "defines", 90, "2026-09-20T00:00:00.000Z"), "file.ts", "thing"));
    index = upsertRelation(index, toRelationRow(edge("judge", "rejected", 1, "2026-08-01T00:00:00.000Z"), "option A", "option B"));

    expect(index.relations[0].edgeId).toBe("judge");
  });

  it("orders structural rows by evidence, as before", () => {
    let index = emptyIndex();
    index = upsertRelation(index, toRelationRow(edge("thin", "defines", 1, "2026-09-20T00:00:00.000Z"), "a.ts", "thin thing"));
    index = upsertRelation(index, toRelationRow(edge("thick", "defines", 40, "2026-08-01T00:00:00.000Z"), "b.ts", "thick thing"));

    expect(index.relations[0].edgeId).toBe("thick");
  });

  it("falls back to evidence for judgments with no timestamp", () => {
    let index = emptyIndex();
    const undated = toRelationRow(edge("undated", "prefers", 30, ""), "x", "y");
    delete (undated as { createdAt?: string }).createdAt;
    index = upsertRelation(index, undated);
    const thin = toRelationRow(edge("thin", "prefers", 1, ""), "p", "q");
    delete (thin as { createdAt?: string }).createdAt;
    index = upsertRelation(index, thin);

    expect(index.relations[0].edgeId).toBe("undated");
  });
});
