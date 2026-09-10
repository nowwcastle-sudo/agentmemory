import { describe, it, expect } from "vitest";
import { recountGraphStats } from "../src/functions/graph-stats-recount.js";
import { KV } from "../src/state/schema.js";
import type { GraphEdge, GraphNode, GraphSnapshot } from "../src/types.js";
import { mockKV } from "./helpers/mocks.js";

// The snapshot's stats are incremental counters that writes outside the
// persist seam never advanced, and the rebuild refuses above 25,000 nodes.
// Live store 2026-09-11: scopes 38,262 nodes / 61,754 edges, stats 23,224 /
// 32,964. A recount reads the scopes once and writes what is actually there.

function node(id: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, type: "concept", name: id, properties: {}, sourceObservationIds: ["o1"], createdAt: "2026-09-01T00:00:00.000Z", graphGeneration: "g2", ...extra };
}
function edge(id: string, type: GraphEdge["type"], a: string, b: string, extra: Partial<GraphEdge> = {}): GraphEdge {
  return { id, type, sourceNodeId: a, targetNodeId: b, weight: 0.8, sourceObservationIds: ["o1"], createdAt: "2026-09-01T00:00:00.000Z", graphGeneration: "g2", ...extra };
}
function snapshot(): GraphSnapshot {
  return {
    version: 1, topNodes: [], topEdges: [], topDegrees: {},
    stats: { totalNodes: 1, totalEdges: 1, nodesByType: { concept: 1 }, edgesByType: { uses: 1 } },
    updatedAt: "2026-09-01T00:00:00.000Z", dirty: true, graphGeneration: "g2",
  };
}

async function seed() {
  const kv = mockKV();
  await kv.set(KV.graphSnapshot, "current", snapshot());
  await kv.set(KV.graphNodes, "n1", node("n1"));
  await kv.set(KV.graphNodes, "n2", node("n2", { type: "file", name: "src/a.ts" }));
  await kv.set(KV.graphNodes, "n3", node("n3", { stale: true }));
  await kv.set(KV.graphNodes, "n4", node("n4", { graphGeneration: "g1" }));
  await kv.set(KV.graphEdges, "e1", edge("e1", "uses", "n1", "n2"));
  await kv.set(KV.graphEdges, "e2", edge("e2", "related_to", "n1", "n2", { stale: true }));
  await kv.set(KV.graphEdges, "e3", edge("e3", "uses", "n2", "n1", { isLatest: false }));
  await kv.set(KV.graphEdges, "e4", edge("e4", "covers" as never, "n1", "n2"));
  await kv.set(KV.graphEdges, "e5", edge("e5", "uses", "n1", "n2", { graphGeneration: "g1" }));
  await kv.set(KV.graphEdges, "e6", edge("e6", "uses", "n1", "n3"));
  return kv;
}

describe("recountGraphStats", () => {
  it("counts live rows only, reports the unknown types, and writes the snapshot", async () => {
    const kv = await seed();
    const result = await recountGraphStats(kv as never);
    expect(result.before).toEqual({ totalNodes: 1, totalEdges: 1 });
    expect(result.after).toEqual({ totalNodes: 2, totalEdges: 2 });
    expect(result.unknownTypes).toEqual({ covers: 1 });
    expect(result.staled).toBe(0);
    const snap = await kv.get<GraphSnapshot>(KV.graphSnapshot, "current");
    expect(snap!.stats).toEqual({ totalNodes: 2, totalEdges: 2, nodesByType: { concept: 1, file: 1 }, edgesByType: { uses: 1, covers: 1 } });
    expect(snap!.dirty).toBe(false);
    expect(snap!.graphGeneration).toBe("g2");
  });

  it("marks edges of unknown type stale when asked, and leaves them out of the count", async () => {
    const kv = await seed();
    const result = await recountGraphStats(kv as never, { staleUnknownTypes: true });
    expect(result.staled).toBe(1);
    expect(result.after).toEqual({ totalNodes: 2, totalEdges: 1 });
    expect((await kv.get<GraphEdge>(KV.graphEdges, "e4"))!.stale).toBe(true);
    const snap = await kv.get<GraphSnapshot>(KV.graphSnapshot, "current");
    expect(snap!.stats.edgesByType).toEqual({ uses: 1 });
  });

  it("does nothing and says so when there is no snapshot", async () => {
    const kv = mockKV();
    await kv.set(KV.graphNodes, "n1", node("n1", { graphGeneration: undefined }));
    const result = await recountGraphStats(kv as never);
    expect(result.before).toEqual({ totalNodes: 0, totalEdges: 0 });
    expect(result.after).toEqual({ totalNodes: 1, totalEdges: 0 });
    const snap = await kv.get<GraphSnapshot>(KV.graphSnapshot, "current");
    expect(snap!.stats.totalNodes).toBe(1);
  });
});
