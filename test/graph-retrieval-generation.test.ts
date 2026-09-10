import { describe, it, expect } from "vitest";
import { GraphRetrieval } from "../src/functions/graph-retrieval.js";
import { KV } from "../src/state/schema.js";
import type { GraphNode, GraphEdge, GraphSnapshot } from "../src/types.js";
import { mockKV } from "./helpers/mocks.js";

// mem::graph-reset does not delete rows: it stamps a new graphGeneration and
// resetAt on the snapshot, and everything older is an orphan that persist no
// longer merges into. The snapshot export honours that; retrieval did not, and
// walked ~28k previous-generation edges on the live store. Retrieval now
// applies the same rule the snapshot does, from the snapshot it holds in its
// cache, and hears about a reset through the KV write hook.

function node(id: string, name: string, obs: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    type: "concept",
    name,
    properties: {},
    sourceObservationIds: [obs],
    createdAt: "2026-09-01T00:00:00.000Z",
    ...extra,
  };
}

function edge(id: string, a: string, b: string, extra: Partial<GraphEdge> = {}): GraphEdge {
  return {
    id,
    type: "related_to",
    sourceNodeId: a,
    targetNodeId: b,
    weight: 0.8,
    sourceObservationIds: ["obs_1"],
    createdAt: "2026-09-01T00:00:00.000Z",
    tcommit: "2026-09-01T00:00:00.000Z",
    isLatest: true,
    ...extra,
  };
}

function snapshot(extra: Partial<GraphSnapshot>): GraphSnapshot {
  return {
    version: 1,
    topNodes: [],
    topEdges: [],
    topDegrees: {},
    stats: { totalNodes: 0, totalEdges: 0, nodesByType: {}, edgesByType: {} },
    updatedAt: "2026-09-10T00:00:00.000Z",
    dirty: false,
    ...extra,
  };
}

const obsIdsOf = (results: Array<{ obsId: string }>) => results.map((r) => r.obsId).sort();

describe("GraphRetrieval generation filter", () => {
  it("hides rows from a previous generation when the snapshot names one", async () => {
    const kv = mockKV();
    await kv.set(KV.graphSnapshot, "current", snapshot({ graphGeneration: "ggen_2" }));
    await kv.set(KV.graphNodes, "n1", node("n1", "React", "obs_1", { graphGeneration: "ggen_2" }));
    await kv.set(KV.graphNodes, "n2", node("n2", "Component", "obs_2", { graphGeneration: "ggen_2" }));
    await kv.set(KV.graphNodes, "n_old", node("n_old", "React Router", "obs_old", { graphGeneration: "ggen_1" }));
    await kv.set(KV.graphEdges, "e1", edge("e1", "n1", "n2", { graphGeneration: "ggen_2" }));
    await kv.set(KV.graphEdges, "e_old", edge("e_old", "n1", "n_old", { graphGeneration: "ggen_1" }));
    const retrieval = new GraphRetrieval(kv as never);

    expect(obsIdsOf(await retrieval.searchByEntities(["React"], 2))).toEqual(["obs_1", "obs_2"]);
    expect(obsIdsOf(await retrieval.expandFromChunks(["obs_1"]))).toEqual(["obs_2"]);
  });

  it("falls back to resetAt when the snapshot has no generation", async () => {
    const kv = mockKV();
    await kv.set(KV.graphSnapshot, "current", snapshot({ resetAt: "2026-09-05T00:00:00.000Z" }));
    await kv.set(KV.graphNodes, "n1", node("n1", "React", "obs_1", { createdAt: "2026-09-06T00:00:00.000Z" }));
    await kv.set(KV.graphNodes, "n_old", node("n_old", "Redux", "obs_old", { createdAt: "2026-09-04T00:00:00.000Z" }));
    await kv.set(KV.graphEdges, "e_old", edge("e_old", "n1", "n_old", { createdAt: "2026-09-04T00:00:00.000Z" }));
    const retrieval = new GraphRetrieval(kv as never);

    expect(obsIdsOf(await retrieval.searchByEntities(["React"], 2))).toEqual(["obs_1"]);
    expect(obsIdsOf(await retrieval.searchByEntities(["Redux"], 2))).toEqual([]);
  });

  it("shows everything when there is no snapshot", async () => {
    const kv = mockKV();
    await kv.set(KV.graphNodes, "n1", node("n1", "React", "obs_1", { graphGeneration: "ggen_1" }));
    await kv.set(KV.graphNodes, "n2", node("n2", "Component", "obs_2"));
    await kv.set(KV.graphEdges, "e1", edge("e1", "n1", "n2"));
    const retrieval = new GraphRetrieval(kv as never);

    expect(obsIdsOf(await retrieval.searchByEntities(["React"], 2))).toEqual(["obs_1", "obs_2"]);
  });

  it("applies a reset written through the KV without listing the graph again", async () => {
    const kv = mockKV();
    const lists = { nodes: 0, edges: 0 };
    const list = kv.list.bind(kv);
    kv.list = (async <T,>(scope: string): Promise<T[]> => {
      if (scope === KV.graphNodes) lists.nodes += 1;
      if (scope === KV.graphEdges) lists.edges += 1;
      return list<T>(scope);
    }) as typeof kv.list;
    await kv.set(KV.graphSnapshot, "current", snapshot({ graphGeneration: "ggen_2" }));
    await kv.set(KV.graphNodes, "n1", node("n1", "React", "obs_1", { graphGeneration: "ggen_2" }));
    const retrieval = new GraphRetrieval(kv as never);
    expect(obsIdsOf(await retrieval.searchByEntities(["React"], 1))).toEqual(["obs_1"]);

    // mem::graph-reset: a fresh snapshot with a new generation, rows untouched.
    await kv.set(KV.graphSnapshot, "current", snapshot({ graphGeneration: "ggen_3", resetAt: "2026-09-11T00:00:00.000Z" }));
    expect(obsIdsOf(await retrieval.searchByEntities(["React"], 1))).toEqual([]);

    // Rows persisted under the new generation come back.
    await kv.set(KV.graphNodes, "n1b", node("n1b", "React", "obs_1b", { graphGeneration: "ggen_3" }));
    expect(obsIdsOf(await retrieval.searchByEntities(["React"], 1))).toEqual(["obs_1b"]);
    expect(lists).toEqual({ nodes: 1, edges: 1 });
  });
});
