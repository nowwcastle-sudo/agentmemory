import { describe, it, expect, beforeEach } from "vitest";
import { GraphRetrieval } from "../src/functions/graph-retrieval.js";
import type { GraphNode, GraphEdge } from "../src/types.js";

function mockKV(
  nodes: GraphNode[] = [],
  edges: GraphEdge[] = [],
) {
  const store = new Map<string, Map<string, unknown>>();
  const nodesMap = new Map<string, unknown>();
  for (const n of nodes) nodesMap.set(n.id, n);
  store.set("mem:graph:nodes", nodesMap);

  const edgesMap = new Map<string, unknown>();
  for (const e of edges) edgesMap.set(e.id, e);
  store.set("mem:graph:edges", edgesMap);

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
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function makeNode(
  id: string,
  name: string,
  type: GraphNode["type"] = "concept",
  obsIds: string[] = ["obs_1"],
): GraphNode {
  return {
    id,
    type,
    name,
    properties: {},
    sourceObservationIds: obsIds,
    createdAt: new Date().toISOString(),
  };
}

function makeEdge(
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  type: GraphEdge["type"] = "related_to",
  weight = 0.8,
): GraphEdge {
  return {
    id,
    type,
    sourceNodeId,
    targetNodeId,
    weight,
    sourceObservationIds: ["obs_1"],
    createdAt: new Date().toISOString(),
    tcommit: new Date().toISOString(),
    isLatest: true,
  };
}

describe("GraphRetrieval", () => {
  it("finds entities by name", async () => {
    const nodes = [
      makeNode("n1", "React", "library", ["obs_1"]),
      makeNode("n2", "Vue", "library", ["obs_2"]),
    ];
    const kv = mockKV(nodes, []);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["React"]);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].obsId).toBe("obs_1");
  });

  it("finds entities by partial name match", async () => {
    const nodes = [makeNode("n1", "auth-middleware", "function", ["obs_1"])];
    const kv = mockKV(nodes, []);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["auth"]);
    expect(results.length).toBeGreaterThan(0);
  });

  it("traverses graph edges to find related observations", async () => {
    const nodes = [
      makeNode("n1", "React", "library", ["obs_1"]),
      makeNode("n2", "Component", "concept", ["obs_2"]),
    ];
    const edges = [makeEdge("e1", "n1", "n2", "uses")];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["React"], 2);
    const obsIds = results.map((r) => r.obsId);
    expect(obsIds).toContain("obs_1");
    expect(obsIds).toContain("obs_2");
  });

  it("returns empty for no matches", async () => {
    const kv = mockKV([], []);
    const retrieval = new GraphRetrieval(kv as never);
    const results = await retrieval.searchByEntities(["nonexistent"]);
    expect(results).toEqual([]);
  });

  it("expands from existing chunks", async () => {
    const nodes = [
      makeNode("n1", "auth.ts", "file", ["obs_1"]),
      makeNode("n2", "jwt", "concept", ["obs_2"]),
    ];
    const edges = [makeEdge("e1", "n1", "n2", "uses")];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.expandFromChunks(["obs_1"]);
    const obsIds = results.map((r) => r.obsId);
    expect(obsIds).toContain("obs_2");
  });

  it("does not duplicate already-seen observations in expansion", async () => {
    const nodes = [makeNode("n1", "file.ts", "file", ["obs_1", "obs_2"])];
    const kv = mockKV(nodes, []);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.expandFromChunks(["obs_1"]);
    const obsIds = results.map((r) => r.obsId);
    expect(obsIds).not.toContain("obs_1");
  });

  it("performs temporal query - current state", async () => {
    const nodes = [makeNode("n1", "Alice", "person", ["obs_1"])];
    const edges = [
      makeEdge("e1", "n1", "n1", "located_in" as any, 0.9),
      {
        ...makeEdge("e2", "n1", "n1", "located_in" as any, 0.9),
        tvalid: "2024-06-01",
        isLatest: true,
      },
    ];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const result = await retrieval.temporalQuery("Alice");
    expect(result.entity).toBeDefined();
    expect(result.entity!.name).toBe("Alice");
    expect(result.currentState.length).toBeGreaterThan(0);
  });

  it("returns null entity for unknown name", async () => {
    const kv = mockKV([], []);
    const retrieval = new GraphRetrieval(kv as never);
    const result = await retrieval.temporalQuery("Unknown");
    expect(result.entity).toBeNull();
  });

  it("scores closer paths higher", async () => {
    const nodes = [
      makeNode("n1", "React", "library", ["obs_1"]),
      makeNode("n2", "Hook", "concept", ["obs_2"]),
      makeNode("n3", "State", "concept", ["obs_3"]),
    ];
    const edges = [
      makeEdge("e1", "n1", "n2", "uses", 0.9),
      makeEdge("e2", "n2", "n3", "related_to", 0.8),
    ];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["React"], 3);
    const directScore = results.find((r) => r.obsId === "obs_1")?.score ?? 0;
    const indirectScore = results.find((r) => r.obsId === "obs_3")?.score ?? 0;
    expect(directScore).toBeGreaterThan(indirectScore);
  });

  // Dijkstra path selection (#328). The BFS implementation this
  // replaced visited a node via its first-discovered path regardless
  // of edge weight. Dijkstra picks the highest-weight (lowest
  // 1/weight cost) path, so a one-hop weak edge no longer beats a
  // two-hop chain of strong edges to the same node.
  it("picks the weight-optimal path under Dijkstra, not the edge-count-shortest one (#328)", async () => {
    const nodes = [
      makeNode("n1", "Start", "concept", ["obs_start"]),
      makeNode("n2", "Mid", "concept", ["obs_mid"]),
      makeNode("n3", "End", "concept", ["obs_end"]),
    ];
    const edges = [
      // Direct n1 → n3 path with a weak edge. BFS would prefer this.
      makeEdge("e_direct", "n1", "n3", "related_to", 0.15),
      // Two-hop chain n1 → n2 → n3 with strong edges. Total cost
      // (1/0.9) + (1/0.9) ≈ 2.22, vs direct 1/0.15 ≈ 6.67.
      // Dijkstra picks the chain.
      makeEdge("e_strong_a", "n1", "n2", "related_to", 0.9),
      makeEdge("e_strong_b", "n2", "n3", "related_to", 0.9),
    ];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["Start"], 3);
    const endResult = results.find((r) => r.obsId === "obs_end");
    expect(endResult).toBeDefined();
    // Path is [Start → Mid → End] (length 3) — Dijkstra picked the
    // chain of two strong edges over the direct weak one.
    expect(endResult!.pathLength).toBe(3);
    expect(endResult!.graphContext).toContain("Mid");
  });

  it("handles disconnected nodes without crashing", async () => {
    const nodes = [
      makeNode("n1", "A", "concept", ["obs_a"]),
      makeNode("n2", "B", "concept", ["obs_b"]),
      // n3 is unreachable from the matched node.
      makeNode("n3", "Lonely", "concept", ["obs_lonely"]),
    ];
    const edges = [makeEdge("e1", "n1", "n2", "related_to", 0.7)];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["A"], 5);
    expect(results.find((r) => r.obsId === "obs_a")).toBeDefined();
    expect(results.find((r) => r.obsId === "obs_b")).toBeDefined();
    expect(results.find((r) => r.obsId === "obs_lonely")).toBeUndefined();
  });

  it("clamps near-zero edge weights without dividing by zero", async () => {
    const nodes = [
      makeNode("n1", "Anchor", "concept", ["obs_anchor"]),
      makeNode("n2", "Weak", "concept", ["obs_weak"]),
    ];
    // weight: 0 is malformed but we shouldn't crash on it; the clamp
    // floor at 0.01 means traversal completes with a very high cost
    // rather than throwing or producing Infinity.
    const edges = [makeEdge("e1", "n1", "n2", "related_to", 0)];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["Anchor"], 2);
    const weak = results.find((r) => r.obsId === "obs_weak");
    expect(weak).toBeDefined();
    expect(Number.isFinite(weak!.score)).toBe(true);
  });

  it("scores startNode observations at 1.0 via the fallback path, not 0.5 via the path-scoring loop (#328 review)", async () => {
    // Regression for a bug surfaced by inline review on #463: if the
    // traversal includes a length-1 path for the startNode itself,
    // the generic path-scoring loop in searchByEntities computes
    // avgWeight=0.5 (empty edgeWeights → fallback) and pathLength=1,
    // yielding score=0.5, then marks the obs as visited. The
    // dedicated score=1.0 fallback loop for startNode obs is then
    // skipped via the visitedObs guard — dead code.
    const nodes = [
      makeNode("n1", "React", "library", ["obs_root"]),
      makeNode("n2", "Hook", "concept", ["obs_neighbor"]),
    ];
    const edges = [makeEdge("e1", "n1", "n2", "uses", 0.8)];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["React"], 2);
    const root = results.find((r) => r.obsId === "obs_root");
    expect(root).toBeDefined();
    expect(root!.score).toBe(1.0);
    expect(root!.pathLength).toBe(0);
  });

  it("respects maxDepth bound (Dijkstra stops at edge-count depth)", async () => {
    // Chain n1 -> n2 -> n3 -> n4. With maxDepth=2 we should reach n3
    // but not n4 — edge-count semantics preserved from the old BFS.
    const nodes = [
      makeNode("n1", "Start", "concept", ["obs_1"]),
      makeNode("n2", "Hop1", "concept", ["obs_2"]),
      makeNode("n3", "Hop2", "concept", ["obs_3"]),
      makeNode("n4", "Hop3", "concept", ["obs_4"]),
    ];
    const edges = [
      makeEdge("e1", "n1", "n2", "related_to", 0.8),
      makeEdge("e2", "n2", "n3", "related_to", 0.8),
      makeEdge("e3", "n3", "n4", "related_to", 0.8),
    ];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["Start"], 2);
    expect(results.find((r) => r.obsId === "obs_3")).toBeDefined();
    expect(results.find((r) => r.obsId === "obs_4")).toBeUndefined();
  });
});

describe("GraphRetrieval multi start-node characterisation", () => {
  // Locks behaviour the existing suite never exercised: every other
  // searchByEntities test resolves to exactly ONE matching start node, so
  // nothing pinned what happens when several start nodes race for the same
  // source. `visitedSources` is shared across start nodes and the first one
  // to reach a source keeps its score, so start-node iteration order is
  // load-bearing — including the surprising part below, where only the FIRST
  // start node scores its own observation at 1.0 because the others are
  // claimed by its traversal before their self-scoring pass runs.
  //
  // Any change that reuses or reorders traversal state must leave these exact
  // numbers untouched. The hub discount is not such a change -- it rewrites the
  // score formula on purpose -- so the two path scores below carry its factor
  // explicitly. Every structural assertion (which sources appear, path lengths,
  // the 1.0 self-score, obs_b above obs_c) is unchanged.
  it("lets the first start node's traversal claim the other start nodes' own sources", async () => {
    const nodes = [
      makeNode("n1", "Auth", "concept", ["obs_a"]),
      makeNode("n2", "AuthService", "concept", ["obs_b"]),
      makeNode("n3", "AuthToken", "concept", ["obs_c"]),
      makeNode("n4", "Shared", "concept", ["obs_shared"]),
    ];
    const edges = [
      makeEdge("e1", "n1", "n4", "related_to", 0.9),
      makeEdge("e2", "n2", "n4", "related_to", 0.5),
      makeEdge("e3", "n3", "n4", "related_to", 0.2),
    ];
    const retrieval = new GraphRetrieval(mockKV(nodes, edges) as never);

    const results = await retrieval.searchByEntities(["Auth"], 2, 20);

    const byObs = new Map(results.map((r) => [r.obsId, r]));
    expect([...byObs.keys()].sort()).toEqual([
      "obs_a",
      "obs_b",
      "obs_c",
      "obs_shared",
    ]);

    // n1 is first in list order: only it scores its own observation at 1.0.
    expect(byObs.get("obs_a")!.score).toBe(1);
    expect(byObs.get("obs_a")!.pathLength).toBe(0);
    expect(byObs.get("obs_a")!.graphContext).toBe("[concept] Auth");

    // The shared node is reached from n1 over the strongest edge (0.9).
    expect(byObs.get("obs_shared")!.score).toBeCloseTo(0.45, 10);
    expect(byObs.get("obs_shared")!.pathLength).toBe(2);

    // n2 and n3 never reach their own self-scoring pass: n1's traversal got
    // there first, so they carry path scores, not 1.0. Both route through
    // "Shared" (degree 3), so both take the same 1 / (1 + ln 3) discount --
    // which is why their ratio, and the ordering it decides, is untouched.
    const sharedDiscount = 1 / (1 + Math.log(3));
    expect(byObs.get("obs_b")!.score).toBeCloseTo(
      0.2333333333333333 * sharedDiscount,
      10,
    );
    expect(byObs.get("obs_b")!.pathLength).toBe(3);
    expect(byObs.get("obs_c")!.score).toBeCloseTo(
      0.18333333333333335 * sharedDiscount,
      10,
    );
    expect(byObs.get("obs_c")!.pathLength).toBe(3);
    expect(byObs.get("obs_b")!.score).toBeGreaterThan(byObs.get("obs_c")!.score);
  });
});

describe("GraphRetrieval scope boundary", () => {
  // The traversal index is built from the scope-filtered arrays. If it were
  // ever hoisted above that filter, an out-of-scope node would stay in the
  // adjacency and act as a bridge: a same-project node reachable ONLY through
  // another tenant's node would start showing up. Nothing else in the suite
  // passes a scope to the graph leg, so this is the only guard.
  it("does not reach a same-project node through an out-of-scope hop", async () => {
    const inA = (id: string, name: string, obs: string[]): GraphNode => ({
      ...makeNode(id, name, "concept", obs),
      projectId: "projA",
    });
    const nodes: GraphNode[] = [
      inA("a1", "Auth", ["obs_a1"]),
      { ...makeNode("b1", "Bridge", "concept", ["obs_b1"]), projectId: "projB" },
      inA("a2", "Downstream", ["obs_a2"]),
    ];
    const edges: GraphEdge[] = [
      { ...makeEdge("e1", "a1", "b1", "related_to", 0.9), projectId: "projA" },
      { ...makeEdge("e2", "b1", "a2", "related_to", 0.9), projectId: "projA" },
    ];
    const retrieval = new GraphRetrieval(mockKV(nodes, edges) as never);

    const results = await retrieval.searchByEntities(["Auth"], 3, 20, {
      projectId: "projA",
    });
    const obsIds = results.map((r) => r.obsId);

    // a1 matches the entity directly and is in scope.
    expect(obsIds).toContain("obs_a1");
    // The bridge belongs to another project and must never appear.
    expect(obsIds).not.toContain("obs_b1");
    // a2 is in scope and does NOT match the entity, so it can only arrive by
    // traversal — and the only route crosses the out-of-scope bridge.
    expect(obsIds).not.toContain("obs_a2");
  });
  // The A/B on the real corpus (records/core-recovery/verification/
  // graph-weight-decision-20260909.md) showed the graph leg displacing the one
  // observation about a function with a generic grep of the same file. The
  // mechanism is here: every neighbour reached through a hub gets the identical
  // `avgWeight * (1 / pathLength)`, so the sort keeps an arbitrary slice of the
  // hub's fan-out. A path through a node the whole corpus touches carries far
  // less evidence than one through a node two observations touch, and the score
  // has to say so.
  it("ranks a path through a low-degree node above one through a hub", async () => {
    const nodes: GraphNode[] = [makeNode("start", "Delta Persist", "concept", ["obs_start"])];
    const edges: GraphEdge[] = [
      makeEdge("e_hub", "start", "hub", "related_to", 0.4),
      makeEdge("e_specific", "start", "specific", "related_to", 0.4),
    ];
    // A hub every observation touches: one shared tool name, 50 files hanging
    // off it. Its leaves are two hops from the query entity.
    nodes.push(makeNode("hub", "Bash", "concept", ["obs_hub"]));
    for (let i = 0; i < 50; i++) {
      nodes.push(makeNode(`h${i}`, `hub-file-${i}`, "file", [`obs_hub_${i}`]));
      edges.push(makeEdge(`eh${i}`, "hub", `h${i}`, "related_to", 0.4));
    }
    // The specific neighbour, same distance and same edge weights, but it is
    // shared with exactly one other node.
    nodes.push(makeNode("specific", "persistGraphDeltaUnlocked", "function", ["obs_specific_mid"]));
    nodes.push(makeNode("leaf", "graph-delta-note", "file", ["obs_specific"]));
    edges.push(makeEdge("e_leaf", "specific", "leaf", "related_to", 0.4));

    const retrieval = new GraphRetrieval(mockKV(nodes, edges) as never);
    const results = await retrieval.searchByEntities(["Delta Persist"], 2, 100);
    const scoreOf = (obsId: string): number =>
      results.find((r) => r.obsId === obsId)?.score ?? -1;

    expect(scoreOf("obs_specific")).toBeGreaterThan(0);
    expect(scoreOf("obs_hub_0")).toBeGreaterThan(0);
    // Both sit at depth 2 behind identical edge weights; only the degree of the
    // node they travel through separates them.
    expect(scoreOf("obs_specific")).toBeGreaterThan(scoreOf("obs_hub_0"));

    // And the consequence that was actually observed: with a realistic cutoff
    // the hub's fan-out must not crowd the specific observation out.
    const cut = await retrieval.searchByEntities(["Delta Persist"], 2, 10);
    expect(cut.map((r) => r.obsId)).toContain("obs_specific");
  });

  // expandFromChunks scores `0.5 * (1 / (pathLength + 1))`, which ties for the
  // same reason; the vector leg feeds it, so it fans out from whatever the top
  // hits touch.
  it("applies the same hub discount when expanding from chunks", async () => {
    const nodes: GraphNode[] = [makeNode("seed", "Seed", "concept", ["obs_seed"])];
    const edges: GraphEdge[] = [];
    nodes.push(makeNode("hub2", "apply_patch", "concept", ["obs_seed"]));
    edges.push(makeEdge("es_hub", "seed", "hub2", "related_to", 0.4));
    for (let i = 0; i < 40; i++) {
      nodes.push(makeNode(`k${i}`, `k-file-${i}`, "file", [`obs_k_${i}`]));
      edges.push(makeEdge(`ek${i}`, "hub2", `k${i}`, "related_to", 0.4));
    }
    nodes.push(makeNode("narrow", "Narrow", "concept", ["obs_seed"]));
    edges.push(makeEdge("es_narrow", "seed", "narrow", "related_to", 0.4));
    nodes.push(makeNode("narrowLeaf", "narrow-leaf", "file", ["obs_narrow"]));
    edges.push(makeEdge("e_narrow_leaf", "narrow", "narrowLeaf", "related_to", 0.4));

    const retrieval = new GraphRetrieval(mockKV(nodes, edges) as never);
    const results = await retrieval.expandFromChunks(["obs_seed"], 2, 100);
    const scoreOf = (obsId: string): number =>
      results.find((r) => r.obsId === obsId)?.score ?? -1;

    expect(scoreOf("obs_narrow")).toBeGreaterThan(0);
    expect(scoreOf("obs_k_0")).toBeGreaterThan(0);
    expect(scoreOf("obs_narrow")).toBeGreaterThan(scoreOf("obs_k_0"));
  });
});
