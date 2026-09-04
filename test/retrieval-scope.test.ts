import { describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/config.js", () => ({
  getAgentId: () => undefined,
  isAgentScopeIsolated: () => false,
  getFollowupWindowSeconds: () => 300,
}));

import { registerSmartSearchFunction } from "../src/functions/smart-search.js";
import { registerRememberFunction } from "../src/functions/remember.js";
import { getSearchIndex } from "../src/functions/search.js";
import {
  extractGraphHeuristics,
  persistGraphDelta,
  registerGraphFunction,
} from "../src/functions/graph.js";
import { HybridSearch } from "../src/state/hybrid-search.js";
import { SearchIndex } from "../src/state/search-index.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { KV } from "../src/state/schema.js";
import type {
  CompressedObservation,
  GraphNode,
  HybridSearchResult,
  Memory,
} from "../src/types.js";

type Scope = {
  projectId?: string;
  actorAgentId?: string;
  wildcardAgent?: boolean;
};

function makeObservation(
  id: string,
  projectId: string,
  actorAgentId: string,
  visibility: "project" | "agent_private" = "project",
  title = "scope needle",
): CompressedObservation {
  return {
    id,
    sessionId: `session-${id}`,
    timestamp: "2026-08-28T00:00:00.000Z",
    type: "decision",
    title,
    facts: [title],
    narrative: title,
    concepts: ["scope"],
    files: [],
    importance: 7,
    projectId,
    agentId: actorAgentId,
    visibility,
  } as CompressedObservation;
}

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOptions: string | { id: string }, fn: Function) => {
      const id = typeof idOrOptions === "string" ? idOrOptions : idOrOptions.id;
      functions.set(id, fn);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function registered: ${id}`);
      return fn(payload);
    },
  };
}

describe("retrieval scope invariants", () => {
  it("BM25 filters project and privacy before the rank window", () => {
    const index = new SearchIndex();
    for (let i = 0; i < 40; i++) {
      index.add(
        makeObservation(
          `foreign-${i}`,
          "project-foreign",
          "agent-foreign",
          "project",
          "needle needle needle needle",
        ),
      );
    }
    index.add(
      makeObservation(
        "valid-shared",
        "project-local",
        "agent-a",
        "project",
        "needle",
      ),
    );
    index.add(
      makeObservation(
        "private-a",
        "project-local",
        "agent-a",
        "agent_private",
        "needle needle needle needle needle",
      ),
    );

    const agentB = (index.search as unknown as (
      query: string,
      limit: number,
      scope: Scope,
    ) => Array<{ obsId: string }>)
      ("needle", 1, {
        projectId: "project-local",
        actorAgentId: "agent-b",
      });
    expect(agentB.map((result) => result.obsId)).toEqual(["valid-shared"]);

    const agentA = (index.search as unknown as (
      query: string,
      limit: number,
      scope: Scope,
    ) => Array<{ obsId: string }>)
      ("needle", 2, {
        projectId: "project-local",
        actorAgentId: "agent-a",
      });
    expect(agentA.map((result) => result.obsId)).toContain("private-a");
  });

  it("vector search excludes a closer foreign/private vector before limit", () => {
    const index = new VectorIndex();
    const add = index.add as unknown as (
      id: string,
      sessionId: string,
      embedding: Float32Array,
      metadata: Record<string, unknown>,
    ) => void;
    add.call(index, "foreign", "session-foreign", new Float32Array([1, 0]), {
      projectId: "project-foreign",
      actorAgentId: "agent-x",
      visibility: "project",
    });
    add.call(index, "private", "session-private", new Float32Array([0.99, 0.01]), {
      projectId: "project-local",
      actorAgentId: "agent-a",
      visibility: "agent_private",
    });
    add.call(index, "valid", "session-valid", new Float32Array([0.8, 0.6]), {
      projectId: "project-local",
      actorAgentId: "agent-a",
      visibility: "project",
    });

    const results = (index.search as unknown as (
      query: Float32Array,
      limit: number,
      scope: Scope,
    ) => Array<{ obsId: string }>)
      (new Float32Array([1, 0]), 1, {
        projectId: "project-local",
        actorAgentId: "agent-b",
      });
    expect(results.map((result) => result.obsId)).toEqual(["valid"]);
  });

  it("preserves retrieval scope metadata across BM25 and vector restarts", () => {
    const shared = makeObservation(
      "restart-shared",
      "project-local",
      "agent-a",
    );
    const foreign = makeObservation(
      "restart-foreign",
      "project-foreign",
      "agent-a",
      "project",
      "needle needle needle",
    );
    const bm25 = new SearchIndex();
    bm25.add(shared);
    bm25.add(foreign);
    const restoredBm25 = SearchIndex.deserialize(bm25.serialize());
    expect(
      restoredBm25
        .search("needle", 1, {
          projectId: "project-local",
          actorAgentId: "agent-b",
        })
        .map((result) => result.obsId),
    ).toEqual(["restart-shared"]);

    const vector = new VectorIndex();
    vector.add("restart-shared", shared.sessionId, new Float32Array([0.8, 0.6]), {
      sourceKind: "observation",
      projectId: shared.projectId,
      actorAgentId: shared.agentId,
      visibility: shared.visibility,
    });
    vector.add("restart-foreign", foreign.sessionId, new Float32Array([1, 0]), {
      sourceKind: "observation",
      projectId: foreign.projectId,
      actorAgentId: foreign.agentId,
      visibility: foreign.visibility,
    });
    const restoredVector = VectorIndex.deserialize(vector.serialize());
    expect(
      restoredVector
        .search(new Float32Array([1, 0]), 1, {
          projectId: "project-local",
          actorAgentId: "agent-b",
        })
        .map((result) => result.obsId),
    ).toEqual(["restart-shared"]);
  });

  it("hydrates graph-only observation and memory locators inside scope", async () => {
    const kv = mockKV();
    const observation = makeObservation(
      "obs-graph",
      "project-local",
      "agent-a",
      "project",
      "AuthToken observation",
    );
    const memory: Memory = {
      id: "mem-graph",
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
      type: "architecture",
      title: "AuthToken memory",
      content: "AuthToken memory content",
      concepts: ["AuthToken"],
      files: [],
      sessionIds: [],
      strength: 8,
      version: 1,
      isLatest: true,
      project: "project-local",
      agentId: "agent-a",
      visibility: "project",
    } as Memory;
    await kv.set(KV.observations(observation.sessionId), observation.id, observation);
    await kv.set(KV.memories, memory.id, memory);
    const foreignObservation = makeObservation(
      "obs-foreign",
      "project-foreign",
      "agent-a",
      "project",
      "AuthToken foreign",
    );
    const privateObservation = makeObservation(
      "obs-private",
      "project-local",
      "agent-a",
      "agent_private",
      "AuthToken private",
    );
    await kv.set(
      KV.observations(foreignObservation.sessionId),
      foreignObservation.id,
      foreignObservation,
    );
    await kv.set(
      KV.observations(privateObservation.sessionId),
      privateObservation.id,
      privateObservation,
    );

    const node = {
      id: "node-auth-token",
      type: "concept",
      name: "AuthToken",
      properties: {},
      sourceObservationIds: [],
      sourceRefs: [
        {
          sourceKind: "observation",
          sourceId: observation.id,
          sessionId: observation.sessionId,
          projectId: "project-local",
          actorAgentId: "agent-a",
          visibility: "project",
        },
        {
          sourceKind: "memory",
          sourceId: memory.id,
          projectId: "project-local",
          actorAgentId: "agent-a",
          visibility: "project",
        },
      ],
      projectId: "project-local",
      visibility: "project",
      createdAt: "2026-08-28T00:00:00.000Z",
    } as GraphNode;
    await kv.set(KV.graphNodes, node.id, node);
    for (const scopedObservation of [foreignObservation, privateObservation]) {
      const scopedNode = {
        ...node,
        id: `node-${scopedObservation.id}`,
        sourceRefs: [
          {
            sourceKind: "observation",
            sourceId: scopedObservation.id,
            sessionId: scopedObservation.sessionId,
            projectId: scopedObservation.projectId,
            actorAgentId: scopedObservation.agentId,
            visibility: scopedObservation.visibility,
          },
        ],
        projectId: scopedObservation.projectId,
        actorAgentId:
          scopedObservation.visibility === "agent_private"
            ? scopedObservation.agentId
            : undefined,
        visibility: scopedObservation.visibility,
      } as GraphNode;
      await kv.set(KV.graphNodes, scopedNode.id, scopedNode);
    }

    const hybrid = new HybridSearch(
      new SearchIndex(),
      null,
      null,
      kv as never,
    );
    const results = await (hybrid.search as unknown as (
      query: string,
      limit: number,
      scope: Scope,
    ) => Promise<HybridSearchResult[]>)
      ("AuthToken", 10, {
        projectId: "project-local",
        actorAgentId: "agent-b",
      });

    expect(results.map((result) => result.observation.id).sort()).toEqual([
      "mem-graph",
      "obs-graph",
    ]);
  });

  it("smart-search forwards project and actor scope to the ranker", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const seenScopes: unknown[] = [];
    const searchFn = async (
      _query: string,
      _limit: number,
      scope?: Scope,
    ): Promise<HybridSearchResult[]> => {
      seenScopes.push(scope);
      return [];
    };
    registerSmartSearchFunction(sdk as never, kv as never, searchFn as never);

    await sdk.trigger("mem::smart-search", {
      query: "needle",
      project: "project-local",
      agentId: "agent-b",
    });

    expect(seenScopes).toEqual([
      {
        projectId: "project-local",
        actorAgentId: "agent-b",
        wildcardAgent: false,
      },
    ]);
  });

  it("expands a graph-discovered memory from the memory store", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const memoryRecord: Memory = {
      id: "mem-expand",
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
      type: "architecture",
      title: "Expandable graph memory",
      content: "Full graph memory content",
      concepts: ["graph"],
      files: [],
      sessionIds: [],
      strength: 8,
      version: 1,
      isLatest: true,
      project: "project-local",
      agentId: "agent-a",
      visibility: "project",
    };
    await kv.set(KV.memories, memoryRecord.id, memoryRecord);
    registerSmartSearchFunction(
      sdk as never,
      kv as never,
      (async () => []) as never,
    );

    const result = (await sdk.trigger("mem::smart-search", {
      expandIds: [memoryRecord.id],
      project: "project-local",
      agentId: "agent-b",
    })) as {
      mode: string;
      results: Array<{ observation: CompressedObservation }>;
    };
    expect(result.mode).toBe("expanded");
    expect(result.results.map((entry) => entry.observation.id)).toEqual([
      memoryRecord.id,
    ]);
  });

  it("graph identity merges shared agents but partitions projects and private owners", async () => {
    const kv = mockKV();
    const observations = [
      makeObservation("shared-a", "project-local", "agent-a"),
      makeObservation("shared-b", "project-local", "agent-b"),
      makeObservation("foreign", "project-foreign", "agent-a"),
      makeObservation(
        "private-a",
        "project-local",
        "agent-a",
        "agent_private",
      ),
      makeObservation(
        "private-b",
        "project-local",
        "agent-b",
        "agent_private",
      ),
    ].map((observation) => ({
      ...observation,
      concepts: ["AuthToken"],
      files: [],
    }));

    for (const observation of observations) {
      const delta = extractGraphHeuristics([observation]);
      await persistGraphDelta(
        kv as never,
        delta.nodes,
        delta.edges,
        [observation.id],
      );
    }

    const nodes = await kv.list<GraphNode>(KV.graphNodes);
    expect(nodes).toHaveLength(4);
    const shared = nodes.find(
      (node) =>
        node.projectId === "project-local" &&
        node.visibility === "project",
    );
    expect(shared?.sourceObservationIds.sort()).toEqual([
      "shared-a",
      "shared-b",
    ]);
  });

  it("scopes direct graph queries and refuses foreign/private nodes", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerGraphFunction(
      sdk as never,
      kv as never,
      { name: "noop", compress: vi.fn(), summarize: vi.fn() } as never,
    );
    const observations = [
      makeObservation("graph-shared", "project-local", "agent-a"),
      makeObservation("graph-foreign", "project-foreign", "agent-a"),
      makeObservation(
        "graph-private",
        "project-local",
        "agent-a",
        "agent_private",
      ),
    ].map((observation) => ({ ...observation, concepts: ["AuthToken"] }));
    for (const observation of observations) {
      const delta = extractGraphHeuristics([observation]);
      await persistGraphDelta(
        kv as never,
        delta.nodes,
        delta.edges,
        [observation.id],
      );
    }

    const byName = (await sdk.trigger("mem::graph-query", {
      query: "AuthToken",
      project: "project-local",
      agentId: "agent-b",
    })) as { nodes: GraphNode[] };
    expect(byName.nodes.map((node) => node.sourceObservationIds)).toEqual([
      ["graph-shared"],
    ]);

    const scopedPage = (await sdk.trigger("mem::graph-query", {
      project: "project-local",
      agentId: "agent-b",
    })) as { nodes: GraphNode[] };
    expect(scopedPage.nodes.map((node) => node.sourceObservationIds)).toEqual([
      ["graph-shared"],
    ]);
  });

  it("remember defaults to project-shared and requires an owner for agent_private", async () => {
    getSearchIndex().clear();
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    const shared = (await sdk.trigger("mem::remember", {
      content: "shared project decision",
      project: "project-local",
      agentId: "agent-a",
    })) as { success: boolean; memory: Memory };
    expect(shared.success).toBe(true);
    expect(shared.memory.visibility).toBe("project");

    const missingOwner = (await sdk.trigger("mem::remember", {
      content: "private without owner",
      project: "project-local",
      visibility: "agent_private",
    })) as { success: boolean; error: string };
    expect(missingOwner).toEqual({
      success: false,
      error: "agent_private visibility requires agentId",
    });

    const privateMemory = (await sdk.trigger("mem::remember", {
      content: "private owned decision",
      project: "project-local",
      agentId: "agent-a",
      visibility: "agent_private",
    })) as { success: boolean; memory: Memory };
    expect(privateMemory.success).toBe(true);
    expect(privateMemory.memory.visibility).toBe("agent_private");
    expect(privateMemory.memory.agentId).toBe("agent-a");
  });
});
