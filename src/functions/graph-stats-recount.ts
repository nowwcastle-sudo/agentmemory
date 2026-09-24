import type { ISdk } from "../iii-compat.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import type { GraphEdge, GraphNode, GraphSnapshot } from "../types.js";
import { EDGE_TYPES } from "./graph-schema.js";
import { belongsToCurrentGeneration, compactSnapshot, SNAPSHOT_KEY } from "./graph-generation.js";
import { logger } from "../logger.js";

// Recount the snapshot's stats from the rows that are actually there.
//
// The stats are incremental counters kept by the persist seam; every write
// that bypassed it (imports, reverts, repairs) left them behind, and the
// snapshot rebuild refuses corpora above 25,000 nodes, so on the live store
// they said 23,224 / 32,964 while the scopes held 38,262 / 61,754. This is
// one deliberate whole-scope read that counts what retrieval counts (no
// stale, no superseded, current generation, both endpoints live) and writes
// the totals back. It can also retire edges whose type is outside the
// closed vocabulary -- legacy rows the validator would refuse today.

export interface RecountResult {
  before: { totalNodes: number; totalEdges: number };
  after: { totalNodes: number; totalEdges: number };
  /** live edges whose type is not in EDGE_TYPES, by type */
  unknownTypes: Record<string, number>;
  /** unknown-typed edges marked stale by this call */
  staled: number;
  /** rows read from the scopes, live or not */
  rows: { nodes: number; edges: number };
}

export async function recountGraphStats(
  kv: StateKV,
  { staleUnknownTypes = false }: { staleUnknownTypes?: boolean } = {},
): Promise<RecountResult> {
  // Same lock as persist, so the counters are not rewritten under a delta.
  return withKeyedLock("graph-persist", async () => {
    const snapshot = await kv.get<GraphSnapshot>(KV.graphSnapshot, SNAPSHOT_KEY).catch(() => null);
    const nodes = await kv.list<GraphNode>(KV.graphNodes);
    const edges = await kv.list<GraphEdge>(KV.graphEdges);

    const liveNodeIds = new Set<string>();
    const nodesByType: Record<string, number> = {};
    for (const n of nodes) {
      if (!n || n.stale || !belongsToCurrentGeneration(n, snapshot)) continue;
      liveNodeIds.add(n.id);
      nodesByType[n.type] = (nodesByType[n.type] ?? 0) + 1;
    }

    const edgesByType: Record<string, number> = {};
    const unknownTypes: Record<string, number> = {};
    let staled = 0;
    let totalEdges = 0;
    for (const e of edges) {
      if (!e || e.stale || e.isLatest === false || e.supersededBy) continue;
      if (!belongsToCurrentGeneration(e, snapshot)) continue;
      if (!liveNodeIds.has(e.sourceNodeId) || !liveNodeIds.has(e.targetNodeId)) continue;
      if (!EDGE_TYPES.has(e.type)) {
        unknownTypes[e.type] = (unknownTypes[e.type] ?? 0) + 1;
        if (staleUnknownTypes) {
          await kv.set(KV.graphEdges, e.id, { ...e, stale: true });
          staled += 1;
          continue;
        }
      }
      edgesByType[e.type] = (edgesByType[e.type] ?? 0) + 1;
      totalEdges += 1;
    }

    const before = {
      totalNodes: snapshot?.stats.totalNodes ?? 0,
      totalEdges: snapshot?.stats.totalEdges ?? 0,
    };
    const after = { totalNodes: liveNodeIds.size, totalEdges };
    const base: GraphSnapshot = snapshot ?? {
      version: 1,
      topNodes: [],
      topEdges: [],
      topDegrees: {},
      stats: { totalNodes: 0, totalEdges: 0, nodesByType: {}, edgesByType: {} },
      updatedAt: "",
      dirty: false,
    };
    const next: GraphSnapshot = {
      ...base,
      stats: { ...base.stats, ...after, nodesByType, edgesByType },
      updatedAt: new Date().toISOString(),
      dirty: false,
    };
    await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, compactSnapshot(next));
    logger.info("Graph stats recounted", { before, after, unknownTypes, staled });
    return { before, after, unknownTypes, staled, rows: { nodes: nodes.length, edges: edges.length } };
  });
}

export function registerGraphStatsRecount(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::graph-stats-recount",
    async (data?: { staleUnknownTypes?: boolean }) => ({
      success: true,
      ...(await recountGraphStats(kv, { staleUnknownTypes: data?.staleUnknownTypes === true })),
    }),
  );
}
