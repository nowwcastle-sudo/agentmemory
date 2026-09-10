import { describe, it, expect } from "vitest";
import { GraphRetrieval } from "../src/functions/graph-retrieval.js";
import { KV } from "../src/state/schema.js";
import type { GraphNode, GraphEdge } from "../src/types.js";
import { mockKV } from "./helpers/mocks.js";

// With the graph leg on, every search listed mem:graph:nodes (80 MB) and
// mem:graph:edges (64 MB) through the engine, which keeps ~2.5x of what it
// carries. The retrieval keeps the live graph in process and learns about
// writes from the KV itself, so the scopes cross the engine once per process,
// not once per search.

function makeNode(id: string, name: string, obsIds: string[]): GraphNode {
  return {
    id,
    type: "concept",
    name,
    properties: {},
    sourceObservationIds: obsIds,
    createdAt: "2026-09-11T00:00:00.000Z",
  };
}

function makeEdge(id: string, sourceNodeId: string, targetNodeId: string): GraphEdge {
  return {
    id,
    type: "related_to",
    sourceNodeId,
    targetNodeId,
    weight: 0.8,
    sourceObservationIds: ["obs_1"],
    createdAt: "2026-09-11T00:00:00.000Z",
    tcommit: "2026-09-11T00:00:00.000Z",
    isLatest: true,
  };
}

function countingKV() {
  const kv = mockKV();
  const lists = { nodes: 0, edges: 0 };
  const list = kv.list.bind(kv);
  kv.list = (async <T,>(scope: string): Promise<T[]> => {
    if (scope === KV.graphNodes) lists.nodes += 1;
    if (scope === KV.graphEdges) lists.edges += 1;
    return list<T>(scope);
  }) as typeof kv.list;
  return { kv, lists };
}

async function seedReactGraph(kv: ReturnType<typeof mockKV>): Promise<void> {
  await kv.set(KV.graphNodes, "n1", makeNode("n1", "React", ["obs_1"]));
  await kv.set(KV.graphNodes, "n2", makeNode("n2", "Component", ["obs_2"]));
  await kv.set(KV.graphEdges, "e1", makeEdge("e1", "n1", "n2"));
}

const obsIdsOf = (results: Array<{ obsId: string }>) => results.map((r) => r.obsId).sort();

describe("GraphRetrieval live-graph cache", () => {
  it("lists each graph scope once across repeated searches", async () => {
    const { kv, lists } = countingKV();
    await seedReactGraph(kv);
    const retrieval = new GraphRetrieval(kv as never);

    const first = await retrieval.searchByEntities(["React"], 2);
    const second = await retrieval.searchByEntities(["React"], 2);
    const expanded = await retrieval.expandFromChunks(["obs_1"]);

    expect(obsIdsOf(first)).toEqual(["obs_1", "obs_2"]);
    expect(obsIdsOf(second)).toEqual(obsIdsOf(first));
    expect(obsIdsOf(expanded)).toEqual(["obs_2"]);
    expect(lists).toEqual({ nodes: 1, edges: 1 });
  });

  it("sees a row written through the KV without listing again", async () => {
    const { kv, lists } = countingKV();
    await seedReactGraph(kv);
    const retrieval = new GraphRetrieval(kv as never);
    await retrieval.searchByEntities(["React"], 2);

    await kv.set(KV.graphNodes, "n3", makeNode("n3", "Hooks", ["obs_3"]));
    await kv.set(KV.graphEdges, "e2", makeEdge("e2", "n2", "n3"));

    const results = await retrieval.searchByEntities(["React"], 2);
    expect(obsIdsOf(results)).toEqual(["obs_1", "obs_2", "obs_3"]);
    expect(lists).toEqual({ nodes: 1, edges: 1 });
  });

  it("forgets a row deleted through the KV without listing again", async () => {
    const { kv, lists } = countingKV();
    await seedReactGraph(kv);
    const retrieval = new GraphRetrieval(kv as never);
    await retrieval.searchByEntities(["React"], 2);

    await kv.delete(KV.graphEdges, "e1");

    const results = await retrieval.searchByEntities(["React"], 2);
    expect(obsIdsOf(results)).toEqual(["obs_1"]);
    expect(lists).toEqual({ nodes: 1, edges: 1 });
  });

  it("drops a row that a partial update marked stale", async () => {
    const { kv } = countingKV();
    await seedReactGraph(kv);
    const retrieval = new GraphRetrieval(kv as never);
    await retrieval.searchByEntities(["React"], 2);

    await kv.update(KV.graphEdges, "e1", [{ path: "stale", value: true }]);

    const results = await retrieval.searchByEntities(["React"], 2);
    expect(obsIdsOf(results)).toEqual(["obs_1"]);
  });

  it("lists again once the safety-net TTL has passed", async () => {
    const { kv, lists } = countingKV();
    await seedReactGraph(kv);
    let clock = 1_000_000;
    const retrieval = new GraphRetrieval(kv as never, { ttlMs: 1_000, now: () => clock });

    await retrieval.searchByEntities(["React"], 2);
    clock += 999;
    await retrieval.searchByEntities(["React"], 2);
    expect(lists).toEqual({ nodes: 1, edges: 1 });

    clock += 2;
    await retrieval.searchByEntities(["React"], 2);
    expect(lists).toEqual({ nodes: 2, edges: 2 });
  });

  it("keeps one cache per KV, so another store's writes do not leak in", async () => {
    const a = countingKV();
    const b = countingKV();
    await a.kv.set(KV.graphNodes, "a1", makeNode("a1", "React", ["obs_a"]));
    await b.kv.set(KV.graphNodes, "b1", makeNode("b1", "React", ["obs_b"]));
    const retrievalA = new GraphRetrieval(a.kv as never);
    const retrievalB = new GraphRetrieval(b.kv as never);

    expect(obsIdsOf(await retrievalA.searchByEntities(["React"], 1))).toEqual(["obs_a"]);
    expect(obsIdsOf(await retrievalB.searchByEntities(["React"], 1))).toEqual(["obs_b"]);

    await b.kv.set(KV.graphNodes, "b2", makeNode("b2", "React Native", ["obs_b2"]));

    expect(obsIdsOf(await retrievalA.searchByEntities(["React"], 1))).toEqual(["obs_a"]);
    expect(obsIdsOf(await retrievalB.searchByEntities(["React"], 1))).toEqual(["obs_b", "obs_b2"]);
    expect(a.lists).toEqual({ nodes: 1, edges: 1 });
    expect(b.lists).toEqual({ nodes: 1, edges: 1 });
  });
});
