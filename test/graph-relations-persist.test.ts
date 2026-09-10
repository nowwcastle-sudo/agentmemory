import { describe, it, expect } from "vitest";
import { persistGraphDelta } from "../src/functions/graph.js";
import { readProjectRelations } from "../src/functions/graph-relations-index.js";
import { KV } from "../src/state/schema.js";
import type { GraphEdge, GraphNode } from "../src/types.js";
import { mockKV } from "./helpers/mocks.js";

// The index must not drift from the graph: every typed edge that goes through
// the persist seam lands in its project's row, with the stored node names.

const mkNode = (id: string, name: string, type: GraphNode["type"] = "concept"): GraphNode =>
  ({ id, type, name, properties: {}, sourceObservationIds: [id], projectId: "p1", visibility: "project", createdAt: "2026-09-03T00:00:00.000Z" });
const mkEdge = (id: string, s: string, t: string, type: GraphEdge["type"], extra: Partial<GraphEdge> = {}): GraphEdge =>
  ({ id, type, sourceNodeId: s, targetNodeId: t, weight: 0.85, sourceObservationIds: [id], projectId: "p1", createdAt: "2026-09-03T00:00:00.000Z", ...extra });

describe("persistGraphDelta keeps the relations index", () => {
  it("adds a typed edge to its project row with the stored names, and ignores related_to", async () => {
    const kv = mockKV();
    await persistGraphDelta(
      kv as never,
      [mkNode("c", "Retry-Policy"), mkNode("f", "src/retry.ts", "file"), mkNode("l", "logging")],
      [mkEdge("e1", "c", "f", "implements"), mkEdge("e2", "l", "f", "related_to")],
      ["o1"],
    );
    const rows = await readProjectRelations(kv as never, "p1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "implements", target: "src/retry.ts", weight: 0.85, backing: 1 });
    // The name is the stored (normalised) node name, whatever the delta spelled.
    const stored = await kv.list<GraphNode>(KV.graphNodes);
    expect(rows[0].source).toBe(stored.find((n) => n.id === rows[0].edgeId || n.type === "concept" && n.name.toLowerCase().includes("retry"))!.name);
  });

  it("updates the row when the same typed edge is merged again with more evidence", async () => {
    const kv = mockKV();
    const nodes = [mkNode("c", "retry policy"), mkNode("f", "src/retry.ts", "file")];
    await persistGraphDelta(kv as never, nodes, [mkEdge("e1", "c", "f", "implements")], ["o1"]);
    await persistGraphDelta(kv as never, nodes, [mkEdge("e1b", "c", "f", "implements", { sourceObservationIds: ["o2"] })], ["o2"]);
    const rows = await readProjectRelations(kv as never, "p1");
    expect(rows).toHaveLength(1);
    expect(rows[0].backing).toBe(2);
  });
});
