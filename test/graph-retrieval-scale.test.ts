import { describe, expect, it } from "vitest";
import { GraphRetrieval } from "../src/functions/graph-retrieval.js";
import { KV } from "../src/state/schema.js";
import type { GraphNode, GraphEdge } from "../src/types.js";

/**
 * Performance guard for the graph leg of hybrid search.
 * defect: one search runs one Dijkstra per matching start node, and each
 * traversal rebuilds the whole adjacency map, so cost is O(|matches| * (V+E)).
 *
 * Scaled to 4,000 nodes / 8,000 edges. Live corpus is 15,537 / 29,640.
 */
const NODES = 4_000;
const EDGES = 8_000;
const BUDGET_MS = 1_000;

function buildGraph() {
  const nodes: GraphNode[] = [];
  for (let i = 0; i < NODES; i += 1) {
    nodes.push({
      id: `n${i}`,
      type: "concept",
      // Every name contains "obs", so the entity "obs" matches every node and
      // matchingNodes === NODES. Nothing in the code caps that.
      name: `obs-topic-${i}`,
      properties: {},
      sourceObservationIds: [`o${i}`],
      createdAt: "2026-09-04T00:00:00.000Z",
    } as GraphNode);
  }
  const edges: GraphEdge[] = [];
  for (let i = 0; i < EDGES; i += 1) {
    edges.push({
      id: `e${i}`,
      type: "related_to",
      sourceNodeId: `n${i % NODES}`,
      targetNodeId: `n${(i * 7 + 1) % NODES}`,
      weight: 1,
      createdAt: "2026-09-04T00:00:00.000Z",
    } as GraphEdge);
  }
  return { nodes, edges };
}

function kvWith(nodes: GraphNode[], edges: GraphEdge[]) {
  return {
    list: async <T,>(scope: string): Promise<T[]> => {
      if (scope === KV.graphNodes) return nodes as unknown as T[];
      if (scope === KV.graphEdges) return edges as unknown as T[];
      return [] as T[];
    },
    get: async () => null,
    set: async <T,>(_s: string, _k: string, d: T) => d,
    delete: async () => {},
    update: async () => {},
  };
}

describe("S2 repro: graph retrieval cost per search", () => {
  it(`answers one entity search over ${NODES} nodes within ${BUDGET_MS}ms`, async () => {
    const { nodes, edges } = buildGraph();
    const retrieval = new GraphRetrieval(kvWith(nodes, edges) as never);

    const started = Date.now();
    const results = await retrieval.searchByEntities(["obs"], 2, 20);
    const elapsed = Date.now() - started;

    console.log(
      `matching start nodes = ${NODES}, elapsed = ${elapsed}ms, results = ${results.length}`,
    );
    expect(elapsed).toBeLessThan(BUDGET_MS);
    // Guard against passing fast because the traversal found nothing. The
    // top 20 are all score-1.0 self-hits (every node matches "obs"), so a
    // second query with a single match is what proves edges were walked.
    expect(results).toHaveLength(20);
    // "obs-topic-3999" self-matches and reverse-matches only -399, -39, -3,
    // so self-hits cannot fill all 20 slots and path results surface.
    const narrow = await retrieval.searchByEntities(["obs-topic-3999"], 2, 20);
    expect(narrow.some((r) => r.pathLength > 0)).toBe(true);
  }, 600_000);
});
