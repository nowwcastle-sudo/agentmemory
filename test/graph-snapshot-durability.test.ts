import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphNode, GraphSnapshot } from "../src/types.js";
import { KV } from "../src/state/schema.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * readSnapshot returns null both when no snapshot exists and when the read
 * throws, and persistGraphDeltaUnlocked does `?? emptySnapshot()`. So one
 * transient `state::get` failure makes the next graph write persist a fresh
 * empty snapshot over the real one: totals reset to zero and topNodes/topEdges
 * are wiped, with only a warn line left behind.
 *
 * That is what happened on 2026-09-04. A single
 * "Invocation timeout after 180000ms: state::get" (exactly one in the worker
 * logs) took the recorded graph from 13,007 nodes to 0, after which it counted
 * back up from live traffic.
 */
const SNAPSHOT_KEY = "current";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  let failSnapshotReads = false;
  const kv = {
    failSnapshotReads: (on: boolean) => {
      failSnapshotReads = on;
    },
    get: async <T,>(scope: string, key: string): Promise<T | null> => {
      if (failSnapshotReads && scope === KV.graphSnapshot) {
        throw new Error("Invocation timeout after 180000ms: state::get");
      }
      return (store.get(scope)?.get(key) as T) ?? null;
    },
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
  return kv;
}

const mkNode = (id: string, name: string): GraphNode => ({
  id,
  type: "concept",
  name,
  properties: {},
  sourceObservationIds: [id],
  projectId: "p1",
  visibility: "project",
  createdAt: "2026-09-04T00:00:00.000Z",
});

function establishedSnapshot(): GraphSnapshot {
  return {
    version: 1,
    topNodes: [mkNode("kept", "Established")],
    topEdges: [],
    topDegrees: { kept: 3 },
    stats: {
      totalNodes: 13_007,
      totalEdges: 25_372,
      nodesByType: { concept: 13_007 },
      edgesByType: { related_to: 25_372 },
    },
    updatedAt: "2026-09-04T02:40:00.000Z",
    dirty: false,
  } as GraphSnapshot;
}

describe("graph snapshot durability", () => {
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    kv = mockKV();
  });

  it("keeps the recorded totals when the snapshot read fails", async () => {
    const { persistGraphDelta } = await import("../src/functions/graph.js");
    await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, establishedSnapshot());

    kv.failSnapshotReads(true);
    await persistGraphDelta(kv as never, [mkNode("new1", "Fresh")], [], ["o1"]);
    kv.failSnapshotReads(false);

    const after = await kv.get<GraphSnapshot>(KV.graphSnapshot, SNAPSHOT_KEY);
    // A failed read is not an empty graph. The established totals must survive.
    expect(after?.stats.totalNodes).toBeGreaterThanOrEqual(13_007);
    expect(after?.topNodes.map((n) => n.id)).toContain("kept");

    // The write itself must still land: only the derived snapshot is skipped.
    expect(await kv.get(KV.graphNodes, "new1")).not.toBeNull();
  });

  it("still initialises a snapshot when none exists", async () => {
    const { persistGraphDelta } = await import("../src/functions/graph.js");

    await persistGraphDelta(kv as never, [mkNode("new1", "Fresh")], [], ["o1"]);

    const after = await kv.get<GraphSnapshot>(KV.graphSnapshot, SNAPSHOT_KEY);
    expect(after?.stats.totalNodes).toBe(1);
  });
});
