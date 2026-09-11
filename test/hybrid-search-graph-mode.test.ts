import { describe, expect, it } from "vitest";
import {
  HybridSearch,
  graphLegModeFromEnv,
  graphMinQueryTokensFromEnv,
  queryTokenCount,
} from "../src/state/hybrid-search.js";
import { SearchIndex } from "../src/state/search-index.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { KV } from "../src/state/schema.js";
import type {
  CompressedObservation,
  EmbeddingProvider,
  GraphNode,
  GraphEdge,
} from "../src/types.js";

/**
 * Three A/Bs on the live corpus (2026-09-09, cycles C and H) turned the graph
 * leg off for the same reason each time: entity search on a common lowercase
 * word ("fingerprint") reaches a homonym cluster and displaces rows the vector
 * leg had right. The expand mode keeps only the part of the leg that starts
 * from what the vector leg already found, and stays out of short queries,
 * where the vector hits are the whole answer.
 */
const observation: CompressedObservation = {
  id: "obs_1",
  sessionId: "ses_1",
  timestamp: "2026-09-04T00:00:00.000Z",
  type: "file_edit",
  title: "Auth middleware",
  subtitle: "JWT",
  facts: ["token check"],
  narrative: "Auth middleware validates JWT tokens",
  concepts: ["authentication"],
  files: ["src/auth.ts"],
  importance: 7,
};

const node = (id: string, name: string): GraphNode => ({
  id,
  type: "concept",
  name,
  properties: {},
  sourceObservationIds: ["obs_1"],
  createdAt: "2026-09-04T00:00:00.000Z",
});

function kvWith(nodes: GraphNode[], edges: GraphEdge[], scopesListed: string[]) {
  return {
    get: async <T,>(scope: string, key: string): Promise<T | null> =>
      scope.startsWith("mem:observations:") && key === "obs_1"
        ? (observation as unknown as T)
        : null,
    set: async <T,>(_s: string, _k: string, d: T) => d,
    delete: async () => {},
    list: async <T,>(scope: string): Promise<T[]> => {
      scopesListed.push(scope);
      if (scope === KV.graphNodes) return nodes as unknown as T[];
      if (scope === KV.graphEdges) return edges as unknown as T[];
      return [] as T[];
    },
  };
}

function withVector() {
  const vector = new VectorIndex();
  vector.add("obs_1", "ses_1", new Float32Array([1, 0, 0]));
  const embedding: EmbeddingProvider = {
    name: "stub",
    dimensions: 3,
    embed: async () => new Float32Array([1, 0, 0]),
    embedBatch: async (texts: string[]) =>
      texts.map(() => new Float32Array([1, 0, 0])),
  };
  return { vector, embedding };
}

function expandSearch(scopesListed: string[], seen: Array<{ entities: boolean; vectorHits: boolean }>, minTokens = 3) {
  const bm25 = new SearchIndex();
  bm25.add(observation);
  const { vector, embedding } = withVector();
  return new HybridSearch(
    bm25,
    vector,
    embedding,
    kvWith([node("n1", "Auth")], [], scopesListed) as never,
    0.4,
    0.6,
    0.3,
    false,
    (entities, vectorHits) => seen.push({ entities, vectorHits }),
    "expand",
    minTokens,
  );
}

describe("HybridSearch graph leg in expand mode", () => {
  it("never opens the entity gate, even for a query that names a graph node", async () => {
    // In entities mode this query opens the entity gate (hybrid-search-graph-gates).
    const scopesListed: string[] = [];
    const seen: Array<{ entities: boolean; vectorHits: boolean }> = [];
    const search = expandSearch(scopesListed, seen);

    await search.search("auth middleware tokens", 10);

    expect(seen).toEqual([{ entities: false, vectorHits: true }]);
    // Expansion from the vector hits still reads the graph.
    expect(scopesListed).toContain(KV.graphNodes);
  });

  it("stays out of the graph entirely for a query shorter than the token gate", async () => {
    const scopesListed: string[] = [];
    const seen: Array<{ entities: boolean; vectorHits: boolean }> = [];
    const search = expandSearch(scopesListed, seen);

    await search.search("auth middleware", 10);

    expect(seen).toEqual([{ entities: false, vectorHits: false }]);
    expect(scopesListed).not.toContain(KV.graphNodes);
    expect(scopesListed).not.toContain(KV.graphEdges);
  });

  it("ignores entity hints from query expansion in expand mode", async () => {
    const scopesListed: string[] = [];
    const seen: Array<{ entities: boolean; vectorHits: boolean }> = [];
    const search = expandSearch(scopesListed, seen);

    await search.searchWithExpansion("auth middleware tokens", 10, {
      original: "auth middleware tokens",
      reformulations: ["Auth token validation"],
      temporalConcretizations: [],
      entityExtractions: ["Auth"],
    });

    expect(seen.every((gate) => gate.entities === false)).toBe(true);
  });

  it("counts query tokens across scripts", () => {
    expect(queryTokenCount("auth middleware")).toBe(2);
    expect(queryTokenCount("auth middleware tokens")).toBe(3);
    expect(queryTokenCount("워커 재기동 원인")).toBe(3);
    expect(queryTokenCount("src/auth.ts JWT")).toBe(2);
    expect(queryTokenCount("   ")).toBe(0);
  });

  it("reads the mode and the token gate from the environment with safe defaults", () => {
    expect(graphLegModeFromEnv({})).toBe("entities");
    expect(graphLegModeFromEnv({ AGENTMEMORY_GRAPH_MODE: "expand" })).toBe("expand");
    expect(graphLegModeFromEnv({ AGENTMEMORY_GRAPH_MODE: " Expand " })).toBe("expand");
    expect(graphLegModeFromEnv({ AGENTMEMORY_GRAPH_MODE: "banana" })).toBe("entities");
    expect(graphMinQueryTokensFromEnv({})).toBe(3);
    expect(graphMinQueryTokensFromEnv({ AGENTMEMORY_GRAPH_MIN_QUERY_TOKENS: "5" })).toBe(5);
    expect(graphMinQueryTokensFromEnv({ AGENTMEMORY_GRAPH_MIN_QUERY_TOKENS: "0" })).toBe(0);
    expect(graphMinQueryTokensFromEnv({ AGENTMEMORY_GRAPH_MIN_QUERY_TOKENS: "-2" })).toBe(3);
    expect(graphMinQueryTokensFromEnv({ AGENTMEMORY_GRAPH_MIN_QUERY_TOKENS: "many" })).toBe(3);
  });
});
