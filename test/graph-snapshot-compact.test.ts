import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { persistGraphDelta, registerGraphFunction } from "../src/functions/graph.js";
import { recountGraphStats } from "../src/functions/graph-stats-recount.js";
import { ProjectionCoordinator } from "../src/functions/projection-coordinator.js";
import { KV } from "../src/state/schema.js";
import type { GraphEdge, GraphNode, GraphQueryResult, GraphSnapshot } from "../src/types.js";

/**
 * Every graph delta reads the snapshot and writes it back whole. Its topNodes
 * carried each hub node's full sourceObservationIds, so on 2026-09-24 the
 * snapshot was 6.6 MB and the worker spent ~95% of its time moving it over
 * the engine socket. The snapshot keeps rankings and counts only; the query
 * that serves it reads the full rows back, so callers see the same records.
 */

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T,>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T,>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T,>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      functions.set(typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id, handler);
    },
    registerTrigger: () => {},
    trigger: async (id: string, payload?: unknown) => {
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

const manyObs = Array.from({ length: 300 }, (_, i) => `obs_${i}`);

const mkNode = (id: string, name: string, obs: string[]): GraphNode => ({
  id,
  type: "file",
  name,
  properties: { path: name },
  sourceObservationIds: obs,
  sourceRefs: obs.map((o) => ({ sourceKind: "observation", sourceId: o })) as never,
  createdAt: "2026-09-24T00:00:00.000Z",
});

const mkEdge = (id: string, source: string, target: string, obs: string[]): GraphEdge => ({
  id,
  type: "uses",
  sourceNodeId: source,
  targetNodeId: target,
  weight: 0.9,
  sourceObservationIds: obs,
  createdAt: "2026-09-24T00:00:00.000Z",
});

const storedSnapshot = (kv: ReturnType<typeof mockKV>) =>
  kv.get<GraphSnapshot>(KV.graphSnapshot, "current");

describe("graph snapshot stays compact", () => {
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    kv = mockKV();
  });

  it("stores top nodes and edges without observation lists", async () => {
    await persistGraphDelta(
      kv as never,
      [mkNode("a", "src/a.ts", manyObs), mkNode("b", "src/b.ts", manyObs)],
      [mkEdge("e1", "a", "b", manyObs)],
      ["obs_new"],
    );

    const snap = await storedSnapshot(kv);
    expect(snap?.topNodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(snap?.topEdges.map((e) => e.id)).toEqual(["e1"]);
    for (const row of [...snap!.topNodes, ...snap!.topEdges]) {
      expect(row.sourceObservationIds).toEqual([]);
      expect(row.sourceRefs).toBeUndefined();
    }
    // The full rows are untouched.
    expect((await kv.get<GraphNode>(KV.graphNodes, "a"))?.sourceObservationIds).toHaveLength(300);
  });

  it("compacts an existing oversized snapshot on the next delta", async () => {
    await kv.set(KV.graphSnapshot, "current", {
      version: 1,
      topNodes: [mkNode("old", "src/old.ts", manyObs)],
      topEdges: [],
      topDegrees: { old: 9 },
      stats: { totalNodes: 1, totalEdges: 0, nodesByType: { file: 1 }, edgesByType: {} },
      updatedAt: "2026-09-23T00:00:00.000Z",
      dirty: false,
    } satisfies GraphSnapshot);

    await persistGraphDelta(kv as never, [mkNode("n", "src/n.ts", ["obs_1"])], [], ["obs_1"]);

    const snap = await storedSnapshot(kv);
    expect(snap?.topNodes.map((n) => n.id)).toContain("old");
    expect(snap?.topNodes.every((n) => n.sourceObservationIds.length === 0)).toBe(true);
  });

  it("keeps compaction when stats are recounted", async () => {
    await kv.set(KV.graphNodes, "old", mkNode("old", "src/old.ts", manyObs));
    await kv.set(KV.graphSnapshot, "current", {
      version: 1,
      topNodes: [mkNode("old", "src/old.ts", manyObs)],
      topEdges: [],
      topDegrees: { old: 0 },
      stats: { totalNodes: 1, totalEdges: 0, nodesByType: { file: 1 }, edgesByType: {} },
      updatedAt: "2026-09-23T00:00:00.000Z",
      dirty: false,
    } satisfies GraphSnapshot);

    await recountGraphStats(kv as never);

    const snap = await storedSnapshot(kv);
    expect(snap?.topNodes[0]?.sourceObservationIds).toEqual([]);
  });

  it("serves the full rows from the snapshot query path", async () => {
    const sdk = mockSdk();
    registerGraphFunction(sdk as never, kv as never, {} as never, new ProjectionCoordinator());
    await persistGraphDelta(
      kv as never,
      [mkNode("a", "src/a.ts", manyObs), mkNode("b", "src/b.ts", manyObs)],
      [mkEdge("e1", "a", "b", manyObs)],
      ["obs_new"],
    );

    const result = (await sdk.trigger("mem::graph-query", {})) as GraphQueryResult;

    expect(result.fromSnapshot).toBe(true);
    const a = result.nodes.find((n) => n.id === "a");
    expect(a?.sourceObservationIds).toHaveLength(300);
    expect(a?.sourceRefs).toHaveLength(300);
    expect(result.edges.find((e) => e.id === "e1")?.sourceObservationIds).toHaveLength(300);
  });
});
