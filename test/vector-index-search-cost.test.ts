import { describe, it, expect, vi } from "vitest";
import { VectorIndex } from "../src/state/vector-index.js";

/**
 * A brute-force pass over ~96k vectors built a result object for every
 * candidate and re-summed each stored vector's norm, about 2.4 s of main
 * thread per search on 2026-09-24. Scores and order must stay exactly what
 * the plain cosine loop produces.
 */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

function vec(next: () => number, dim = 16): Float32Array {
  return Float32Array.from({ length: dim }, next);
}

function referenceCosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function build(count: number) {
  const next = rng(7);
  const index = new VectorIndex();
  const stored: Array<[string, Float32Array, string]> = [];
  for (let i = 0; i < count; i++) {
    const embedding = i === 3 ? new Float32Array(16) : vec(next);
    const projectId = i % 3 === 0 ? "p1" : "p2";
    index.add(`obs_${i}`, `ses_${i % 5}`, embedding, { projectId });
    stored.push([`obs_${i}`, embedding, projectId]);
  }
  return { index, stored, query: vec(next) };
}

describe("VectorIndex search cost", () => {
  it("builds result objects only for vectors that reach the top", () => {
    const { index, query } = build(1000);
    const locate = vi.spyOn(VectorIndex.prototype as never, "entryLocator" as never);
    try {
      expect(index.search(query, 5)).toHaveLength(5);
      expect(locate.mock.calls.length).toBeLessThan(200);
    } finally {
      locate.mockRestore();
    }
  });

  it("returns exactly the scores and order of the plain cosine loop", () => {
    const { index, stored, query } = build(400);
    for (const scope of [undefined, { projectId: "p1" }] as const) {
      const expected = stored
        .filter(([, , p]) => !scope || p === scope.projectId)
        .map(([id, e]) => ({ id, score: referenceCosine(query, e) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 12);
      const got = index.search(query, 12, scope).map((r) => ({ id: r.obsId, score: r.score }));
      expect(got.map((g) => g.score)).toEqual(expected.map((e) => e.score));
      expect(new Set(got.map((g) => g.id))).toEqual(new Set(expected.map((e) => e.id)));
    }
  });

  it("recomputes the norm when a vector is replaced", () => {
    const index = new VectorIndex();
    const q = Float32Array.from([1, 0]);
    index.add("a", "s", Float32Array.from([1, 0]));
    expect(index.search(q, 1)[0].score).toBeCloseTo(1);
    index.add("a", "s", Float32Array.from([1, 1]));
    expect(index.search(q, 1)[0].score).toBeCloseTo(Math.SQRT1_2);
  });
});
