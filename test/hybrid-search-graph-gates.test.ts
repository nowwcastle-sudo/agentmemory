import { describe, expect, it } from "vitest";
import { HybridSearch } from "../src/state/hybrid-search.js";
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
 * The graph leg has two independent gates and each one costs a full
 * enumeration of the graph scopes when it opens:
 *   - searchByEntities runs when extractEntitiesFromQuery yields anything,
 *     and that extractor is ASCII-only, so an all-Korean or all-lowercase
 *     query never opens it.
 *   - expandFromChunks runs when the vector leg returns hits, which on a
 *     populated vector index is nearly always.
 * Without counters there is no way to know how often either fires in real
 * traffic, and therefore no way to size any fix.
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

function kvWith(nodes: GraphNode[], edges: GraphEdge[]) {
  return {
    get: async <T,>(scope: string, key: string): Promise<T | null> =>
      scope.startsWith("mem:observations:") && key === "obs_1"
        ? (observation as unknown as T)
        : null,
    set: async <T,>(_s: string, _k: string, d: T) => d,
    delete: async () => {},
    list: async <T,>(scope: string): Promise<T[]> => {
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

describe("HybridSearch graph-leg gate instrumentation", () => {
  it("reports both gates opening for a capitalized query with vector hits", async () => {
    const bm25 = new SearchIndex();
    bm25.add(observation);
    const { vector, embedding } = withVector();
    const seen: Array<{ entities: boolean; vectorHits: boolean }> = [];

    const search = new HybridSearch(
      bm25,
      vector,
      embedding,
      kvWith([node("n1", "Auth")], []) as never,
      0.4,
      0.6,
      0.3,
      false,
      (entities, vectorHits) => seen.push({ entities, vectorHits }),
    );

    await search.search("Auth middleware", 10);

    expect(seen).toEqual([{ entities: true, vectorHits: true }]);
  });

  it("reports the entity gate closed for an all-lowercase query", async () => {
    const bm25 = new SearchIndex();
    bm25.add(observation);
    const { vector, embedding } = withVector();
    const seen: Array<{ entities: boolean; vectorHits: boolean }> = [];

    const search = new HybridSearch(
      bm25,
      vector,
      embedding,
      kvWith([node("n1", "Auth")], []) as never,
      0.4,
      0.6,
      0.3,
      false,
      (entities, vectorHits) => seen.push({ entities, vectorHits }),
    );

    await search.search("auth middleware", 10);

    expect(seen).toEqual([{ entities: false, vectorHits: true }]);
  });

  it("reports both gates closed when there is no vector index", async () => {
    const bm25 = new SearchIndex();
    bm25.add(observation);
    const seen: Array<{ entities: boolean; vectorHits: boolean }> = [];

    const search = new HybridSearch(
      bm25,
      null,
      null,
      kvWith([node("n1", "Auth")], []) as never,
      0.4,
      0.6,
      0.3,
      false,
      (entities, vectorHits) => seen.push({ entities, vectorHits }),
    );

    await search.search("auth middleware", 10);

    expect(seen).toEqual([{ entities: false, vectorHits: false }]);
  });
});
