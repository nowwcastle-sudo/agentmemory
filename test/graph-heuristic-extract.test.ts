import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { extractGraphHeuristics } from "../src/functions/graph.js";
import type { CompressedObservation } from "../src/types.js";

function obs(
  id: string,
  files: string[],
  concepts: string[],
): CompressedObservation {
  return {
    id,
    sessionId: "ses_1",
    timestamp: new Date().toISOString(),
    type: "file_edit",
    title: `obs ${id}`,
    facts: [],
    narrative: "",
    concepts,
    files,
    importance: 0.5,
  };
}

describe("extractGraphHeuristics", () => {
  it("builds file and concept nodes from structured fields", () => {
    const { nodes } = extractGraphHeuristics([
      obs("o1", ["src/auth.ts"], ["authentication", "jwt"]),
    ]);
    const byType = new Map(nodes.map((n) => [`${n.type}:${n.name}`, n]));
    expect(byType.has("file:src/auth.ts")).toBe(true);
    expect(byType.has("concept:authentication")).toBe(true);
    expect(byType.has("concept:jwt")).toBe(true);
  });

  // Measured on the live store 2026-09-10: related_to was 73% of live edges, and
  // a quarter of those were concept-concept or file-file links whose only basis
  // was being adjacent in an observation's list. Adjacency in a list is not a
  // relationship. Co-occurrence of a concept with a file in one observation is
  // a weak but real signal, so that stays.
  it("links each concept to each file as related_to, and nothing else", () => {
    const { nodes, edges } = extractGraphHeuristics([
      obs("o1", ["a.ts", "b.ts"], ["caching", "jwt"]),
    ]);
    expect(edges.every((e) => e.type === "related_to")).toBe(true);
    const names = new Map(nodes.map((n) => [n.id, n.name]));
    const pairs = edges.map(
      (e) => `${names.get(e.sourceNodeId)}|${names.get(e.targetNodeId)}`,
    );
    expect(pairs.sort()).toEqual(
      ["caching|a.ts", "caching|b.ts", "jwt|a.ts", "jwt|b.ts"].sort(),
    );
    expect(pairs).not.toContain("a.ts|b.ts");
    expect(pairs).not.toContain("caching|jwt");
  });

  it("merges repeated entities across observations instead of duplicating", () => {
    const { nodes } = extractGraphHeuristics([
      obs("o1", ["src/auth.ts"], []),
      obs("o2", ["src/auth.ts"], []),
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].sourceObservationIds).toEqual(["o1", "o2"]);
  });

  it("dedupes case-insensitively and skips blank names", () => {
    const { nodes } = extractGraphHeuristics([
      obs("o1", [], ["JWT", "jwt", "  "]),
    ]);
    expect(nodes).toHaveLength(1);
  });

  it("caps edges per observation", () => {
    const many = obs(
      "o1",
      Array.from({ length: 10 }, (_, i) => `f${i}.ts`),
      Array.from({ length: 10 }, (_, i) => `c${i}`),
    );
    const { edges } = extractGraphHeuristics([many]);
    expect(edges.length).toBeLessThanOrEqual(12);
  });

  it("never emits self edges or duplicate pairs", () => {
    const { edges } = extractGraphHeuristics([
      obs("o1", ["a.ts"], ["a"]),
      obs("o2", ["a.ts"], ["a"]),
    ]);
    const seen = new Set<string>();
    for (const e of edges) {
      expect(e.sourceNodeId).not.toBe(e.targetNodeId);
      const key = [e.sourceNodeId, e.targetNodeId].sort().join("|");
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

// The structural pass must run keyless on the observation hot path. Session
// terminal work requests semantic mode separately after a summary succeeds.
describe("keyless graph extraction wiring", () => {
  it("observation projection requests structural graph mode without a flag gate", () => {
    const projection = readFileSync(
      "src/functions/observation-projection.ts",
      "utf-8",
    );
    expect(projection).toMatch(
      /mode:\s*"structural"[\s\S]*?await projectGraphSourcesCore\(request\)/,
    );
    expect(projection).not.toContain("isGraphExtractionEnabled");
  });

  it("graph functions register unconditionally so the trigger always resolves", () => {
    const index = readFileSync("src/index.ts", "utf-8");
    const reg = index.search(/registerGraphFunction\(\s*sdk,\s*kv,\s*provider,/);
    expect(reg).toBeGreaterThan(-1);
    const before = index.slice(Math.max(0, reg - 200), reg);
    expect(before).not.toContain("isGraphExtractionEnabled()");
  });

  it("mem::graph-extract gates the LLM pass, not the heuristic pass", () => {
    const graph = readFileSync("src/functions/graph.ts", "utf-8");
    expect(graph).toMatch(/extractGraphHeuristics\(data\.observations\)/);
    expect(graph).toMatch(/providerAvailable = !provider\.name\.includes\("noop"\)/);
    expect(graph).toMatch(
      /mode !== "structural"[\s\S]*?isGraphExtractionEnabled\(\)[\s\S]*?providerAvailable/,
    );
  });
});
