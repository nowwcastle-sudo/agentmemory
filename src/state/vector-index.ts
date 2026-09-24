import type {
  GraphSourceKind,
  GraphSourceLocator,
  GraphVisibility,
  RetrievalMetadata,
  RetrievalScope,
} from "../types.js";
import { matchesRetrievalScope } from "./retrieval-scope.js";

// Pass byteOffset + byteLength explicitly so the round-trip survives
// Node's Buffer pool. Buffer.from(b64, "base64") returns a slice of a
// shared 8KB pool (poolSize), and `new Float32Array(buf.buffer)` ignores
// the slice metadata — it would mint a 2048-element view over the whole
// pool. Same risk on the encode side if the input Float32Array is itself
// a sliced view. Reported as a phantom "2048 dimensions on disk" crash
// in #455 / #469 / #584 / #587.
function float32ToBase64(arr: Float32Array): string {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString(
    "base64",
  );
}

function base64ToFloat32(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
}

function sumOfSquares(a: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
  return sum;
}

// Norms are summed in the same order as the dot product, so the score is the
// one a single cosine loop would give.
function cosineSimilarity(a: Float32Array, normA: number, b: Float32Array, normB: number): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export type VectorBinaryMeta = {
  sourceKind?: GraphSourceKind;
  projectId?: string;
  actorAgentId?: string;
  visibility?: GraphVisibility;
};
/** [obsId, sessionId, length, meta?] */
export type VectorBinaryEntry =
  | [string, string, number]
  | [string, string, number, VectorBinaryMeta];
export type VectorBinaryHeader = {
  v: 1;
  count: number;
  floats: number;
  entries: VectorBinaryEntry[];
};

type VectorEntry = {
  embedding: Float32Array;
  sessionId: string;
  sourceKind?: GraphSourceKind;
  projectId?: string;
  actorAgentId?: string;
  visibility?: GraphVisibility;
  // Sum of squares, filled by the first search; entries are replaced, never mutated.
  normSq?: number;
};

export class VectorIndex {
  private vectors: Map<string, VectorEntry> = new Map();

  add(
    obsId: string,
    sessionId: string,
    embedding: Float32Array,
    metadata: RetrievalMetadata = {},
  ): void {
    this.vectors.set(obsId, {
      embedding,
      sessionId,
      ...(metadata.sourceKind ? { sourceKind: metadata.sourceKind } : {}),
      ...(metadata.projectId ? { projectId: metadata.projectId } : {}),
      ...(metadata.actorAgentId
        ? { actorAgentId: metadata.actorAgentId }
        : {}),
      ...(metadata.visibility ? { visibility: metadata.visibility } : {}),
    });
  }

  remove(obsId: string): void {
    this.vectors.delete(obsId);
  }

  search(
    query: Float32Array,
    limit = 20,
    scope?: RetrievalScope,
  ): Array<{
    obsId: string;
    sessionId: string;
    score: number;
    source: GraphSourceLocator;
  }> {
    const results: Array<{
      obsId: string;
      sessionId: string;
      score: number;
      source: GraphSourceLocator;
    }> = [];
    let minScore = -Infinity;
    const queryNormSq = sumOfSquares(query);
    const hit = (obsId: string, entry: VectorEntry, score: number) => ({
      obsId,
      sessionId: entry.sessionId,
      score,
      source: this.entryLocator(obsId, entry),
    });

    for (const [obsId, entry] of this.vectors) {
      if (!matchesRetrievalScope(entry, scope)) continue;
      entry.normSq ??= sumOfSquares(entry.embedding);
      const score = cosineSimilarity(query, queryNormSq, entry.embedding, entry.normSq);
      if (results.length < limit) {
        results.push(hit(obsId, entry, score));
        if (results.length === limit) {
          results.sort((a, b) => a.score - b.score);
          minScore = results[0].score;
        }
      } else if (score > minScore) {
        results[0] = hit(obsId, entry, score);
        results.sort((a, b) => a.score - b.score);
        minScore = results[0].score;
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  get size(): number {
    return this.vectors.size;
  }

  /**
   * The index as one JSON header plus one Float32 block, for a file on the
   * worker's disk. serialize() produces 145.9 MB of base64-in-JSON for the
   * live 64k vectors and takes seconds on the main thread; this is a header
   * of ids and metadata (a few MB) and a 99 MB memcpy. Vectors of differing
   * length are kept: each entry records its own length.
   */
  toBinary(): { header: VectorBinaryHeader; block: Float32Array } {
    let total = 0;
    for (const entry of this.vectors.values()) total += entry.embedding.length;
    const block = new Float32Array(total);
    const entries: VectorBinaryEntry[] = [];
    let offset = 0;
    for (const [obsId, entry] of this.vectors) {
      block.set(entry.embedding, offset);
      const meta: VectorBinaryMeta = {};
      if (entry.sourceKind) meta.sourceKind = entry.sourceKind;
      if (entry.projectId) meta.projectId = entry.projectId;
      if (entry.actorAgentId) meta.actorAgentId = entry.actorAgentId;
      if (entry.visibility) meta.visibility = entry.visibility;
      entries.push(
        Object.keys(meta).length > 0
          ? [obsId, entry.sessionId, entry.embedding.length, meta]
          : [obsId, entry.sessionId, entry.embedding.length],
      );
      offset += entry.embedding.length;
    }
    return { header: { v: 1, count: entries.length, floats: total, entries }, block };
  }

  /** Inverse of toBinary. Returns null when the header and block disagree. */
  static fromBinary(header: VectorBinaryHeader, block: Float32Array): VectorIndex | null {
    if (!header || header.v !== 1 || !Array.isArray(header.entries)) return null;
    let expected = 0;
    for (const entry of header.entries) {
      if (!Array.isArray(entry) || typeof entry[2] !== "number" || entry[2] < 0) return null;
      expected += entry[2];
    }
    if (expected !== block.length || header.entries.length !== header.count) return null;
    const idx = new VectorIndex();
    let offset = 0;
    for (const [obsId, sessionId, length, meta] of header.entries) {
      if (typeof obsId !== "string" || typeof sessionId !== "string") return null;
      idx.vectors.set(obsId, {
        embedding: block.subarray(offset, offset + length),
        sessionId,
        ...(meta?.sourceKind ? { sourceKind: meta.sourceKind } : {}),
        ...(meta?.projectId ? { projectId: meta.projectId } : {}),
        ...(meta?.actorAgentId ? { actorAgentId: meta.actorAgentId } : {}),
        ...(meta?.visibility ? { visibility: meta.visibility } : {}),
      });
      offset += length;
    }
    return idx;
  }

  // Walks every stored vector and returns the obsIds whose dimension
  // doesn't match `expected`, plus the set of distinct dimensions seen.
  // Used by the persistence-restore guard in src/index.ts to refuse
  // loading any index containing wrong-dimension vectors — including
  // legacy on-disk indexes written before the live-API dimension guard
  // existed (where a mid-session provider swap could mix dimensions
  // inside a single index). Empty `mismatches` plus a single-entry
  // `seenDimensions` matching `expected` is the only clean state.
  validateDimensions(
    expected: number,
  ): { mismatches: Array<{ obsId: string; dim: number }>; seenDimensions: Set<number> } {
    const mismatches: Array<{ obsId: string; dim: number }> = [];
    const seenDimensions = new Set<number>();
    for (const [obsId, entry] of this.vectors) {
      const dim = entry.embedding.length;
      seenDimensions.add(dim);
      if (dim !== expected) {
        mismatches.push({ obsId, dim });
      }
    }
    return { mismatches, seenDimensions };
  }

  clear(): void {
    this.vectors.clear();
  }

  restoreFrom(other: VectorIndex): void {
    const src = (other as any).vectors as Map<
      string,
      {
        embedding: Float32Array;
        sessionId: string;
        sourceKind?: GraphSourceKind;
        projectId?: string;
        actorAgentId?: string;
        visibility?: GraphVisibility;
      }
    >;
    this.vectors = new Map();
    for (const [obsId, entry] of src) {
      this.vectors.set(obsId, {
        embedding: new Float32Array(entry.embedding),
        sessionId: entry.sessionId,
        ...(entry.sourceKind ? { sourceKind: entry.sourceKind } : {}),
        ...(entry.projectId ? { projectId: entry.projectId } : {}),
        ...(entry.actorAgentId
          ? { actorAgentId: entry.actorAgentId }
          : {}),
        ...(entry.visibility ? { visibility: entry.visibility } : {}),
      });
    }
  }

  serialize(): string {
    const data: Array<[
      string,
      {
        embedding: string;
        sessionId: string;
        sourceKind?: GraphSourceKind;
        projectId?: string;
        actorAgentId?: string;
        visibility?: GraphVisibility;
      },
    ]> = [];
    for (const [obsId, entry] of this.vectors) {
      data.push([
        obsId,
        {
          embedding: float32ToBase64(entry.embedding),
          sessionId: entry.sessionId,
          ...(entry.sourceKind ? { sourceKind: entry.sourceKind } : {}),
          ...(entry.projectId ? { projectId: entry.projectId } : {}),
          ...(entry.actorAgentId
            ? { actorAgentId: entry.actorAgentId }
            : {}),
          ...(entry.visibility ? { visibility: entry.visibility } : {}),
        },
      ]);
    }
    return JSON.stringify(data);
  }

  static deserialize(json: string): VectorIndex {
    const idx = new VectorIndex();
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      return idx;
    }
    if (!Array.isArray(data)) return idx;
    for (const row of data) {
      try {
        if (!Array.isArray(row) || row.length < 2) continue;
        const [obsId, entry] = row;
        if (
          typeof obsId !== "string" ||
          typeof entry?.embedding !== "string" ||
          typeof entry?.sessionId !== "string"
        )
          continue;
        idx.vectors.set(obsId, {
          embedding: base64ToFloat32(entry.embedding),
          sessionId: entry.sessionId,
          ...(entry.sourceKind === "observation" || entry.sourceKind === "memory"
            ? { sourceKind: entry.sourceKind }
            : {}),
          ...(typeof entry.projectId === "string"
            ? { projectId: entry.projectId }
            : {}),
          ...(typeof entry.actorAgentId === "string"
            ? { actorAgentId: entry.actorAgentId }
            : {}),
          ...(entry.visibility === "project" ||
          entry.visibility === "agent_private"
            ? { visibility: entry.visibility }
            : {}),
        });
      } catch {
        continue;
      }
    }
    return idx;
  }

  private entryLocator(
    obsId: string,
    entry: {
      sessionId: string;
      sourceKind?: GraphSourceKind;
      projectId?: string;
      actorAgentId?: string;
      visibility?: GraphVisibility;
    },
  ): GraphSourceLocator {
    return {
      sourceKind: entry.sourceKind ??
        (obsId.startsWith("mem_") ? "memory" : "observation"),
      sourceId: obsId,
      sessionId: entry.sessionId,
      ...(entry.projectId ? { projectId: entry.projectId } : {}),
      ...(entry.actorAgentId
        ? { actorAgentId: entry.actorAgentId }
        : {}),
      ...(entry.visibility ? { visibility: entry.visibility } : {}),
    };
  }
}
