import { describe, it, expect } from "vitest";
import { NODE_TYPES, EDGE_TYPES, canonicalGraphName, canonicalGraphKey, graphScopeKey } from "../src/functions/graph-schema.js";

describe("graph-schema vocabulary", () => {
  it("closed node vocabulary = 13 existing + task, feature", () => {
    expect(NODE_TYPES.size).toBe(15);
    for (const t of ["file","function","concept","error","decision","pattern","library","person","project","preference","location","organization","event","task","feature"]) expect(NODE_TYPES.has(t as never)).toBe(true);
    expect(NODE_TYPES.has("command" as never)).toBe(false);
    expect(NODE_TYPES.has("metric" as never)).toBe(false);
  });
  it("closed edge vocabulary = 16 existing + 7 admitted", () => {
    expect(EDGE_TYPES.size).toBe(23);
    for (const t of ["implements","part_of","contains","documents","defines","validates","tests"]) expect(EDGE_TYPES.has(t as never)).toBe(true);
    expect(EDGE_TYPES.has("includes" as never)).toBe(false);
    expect(EDGE_TYPES.has("covers" as never)).toBe(false);
  });
});

describe("canonicalGraphName (v2)", () => {
  it("unifies case, whitespace, underscores and hyphens", () => {
    expect(canonicalGraphName("concept", "Session-Initialization")).toBe("session initialization");
    expect(canonicalGraphName("concept", "session   initialization")).toBe("session initialization");
    expect(canonicalGraphName("concept", "spaced_repetition")).toBe("spaced repetition");
    expect(canonicalGraphName("concept", "load\u2010bearing logic")).toBe("load bearing logic");
  });
  it("does NOT strip plurals and does NOT touch dots, colons or slashes", () => {
    expect(canonicalGraphName("concept", "hermes-agent skills")).toBe("hermes agent skills");
    expect(canonicalGraphName("concept", "node:test")).toBe("node:test");
    expect(canonicalGraphName("concept", "node --test")).toBe("node test");
    expect(canonicalGraphName("concept", "Node.js fs/promises")).toBe("node.js fs/promises");
    expect(canonicalGraphName("concept", "Node.js fs promises")).toBe("node.js fs promises");
    expect(canonicalGraphName("concept", "git log -S")).toBe("git log s");
    expect(canonicalGraphName("concept", "git log")).toBe("git log");
    expect(canonicalGraphName("concept", "mcp_servers")).toBe("mcp servers");
    expect(canonicalGraphName("concept", "MCP server")).toBe("mcp server");
  });
  it("applies NFKC", () => {
    expect(canonicalGraphName("concept", "ｆｉｌｅ　search")).toBe("file search");
  });
  it("file type: unifies backslashes to slash and lowercases, keeps everything else", () => {
    expect(canonicalGraphName("file", "C:\\\\Users\\\\x\\\\Docs\\\\notes.md")).toBe("c:/users/x/docs/notes.md");
    expect(canonicalGraphName("file", "C:\\Users\\x\\Docs\\notes.md")).toBe("c:/users/x/docs/notes.md");
    expect(canonicalGraphName("file", "scripts/validate-codex-enrichment.mjs")).toBe("scripts/validate-codex-enrichment.mjs");
    expect(canonicalGraphName("file", "docs/some_file-name.md")).toBe("docs/some_file-name.md");
  });
  it("returns empty string for blank or separator-only names", () => {
    expect(canonicalGraphName("concept", "   ")).toBe("");
    expect(canonicalGraphName("concept", "---")).toBe("");
  });
});

describe("canonicalGraphKey", () => {
  it("prefixes the scope exactly like graph.ts did (project|visibility|owner)", () => {
    expect(canonicalGraphKey("concept", "Discord Bot", { projectId: "p1", visibility: "project" })).toBe("p1|project||concept|discord bot");
    expect(canonicalGraphKey("concept", "x", { visibility: "agent_private", actorAgentId: "ag" })).toBe("__global__|agent_private|ag|concept|x");
    expect(canonicalGraphKey("file", "A.md")).toBe("file|a.md");
  });
  it("different scopes never collide", () => {
    expect(canonicalGraphKey("concept", "x", { projectId: "p1" })).not.toBe(canonicalGraphKey("concept", "x", { projectId: "p2" }));
  });
  it("graphScopeKey is empty for an unscoped node", () => {
    expect(graphScopeKey({})).toBe("");
  });
});

import { validateGraphDelta } from "../src/functions/graph-schema.js";
import type { GraphNode, GraphEdge } from "../src/types.js";

const N = (id: string, type: string, name: string, extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id, type: type as GraphNode["type"], name, properties: {}, sourceObservationIds: ["obs_1"], createdAt: "2026-09-03T00:00:00.000Z", ...extra });
const E = (id: string, type: string, s: string, t: string): GraphEdge =>
  ({ id, type: type as GraphEdge["type"], sourceNodeId: s, targetNodeId: t, weight: 0.5, sourceObservationIds: ["obs_1"], createdAt: "2026-09-03T00:00:00.000Z" });
const NOW = "2026-09-03T01:00:00.000Z";

describe("validateGraphDelta", () => {
  it("accepts an all-valid delta unchanged and in order", () => {
    const nodes = [N("a", "file", "src/a.ts"), N("b", "function", "main"), N("c", "concept", "x"), N("err", "error", "ENOENT")];
    const edges = [E("e1", "modifies", "b", "a"), E("e2", "related_to", "c", "b"), E("e3", "fixes", "b", "err")];
    const r = validateGraphDelta({ nodes, edges }, { now: NOW });
    expect(r.rejected).toEqual([]);
    expect(r.accepted.nodes.map((n) => n.id)).toEqual(["a", "b", "c", "err"]);
    expect(r.accepted.edges.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
  });
  it("rule 1: unknown node type is rejected with the record kept verbatim", () => {
    const bad = N("m", "metric", "p95");
    const r = validateGraphDelta({ nodes: [bad], edges: [] }, { now: NOW });
    expect(r.accepted.nodes).toEqual([]);
    expect(r.rejected).toEqual([{ id: "rej:node:m", kind: "node", reason: "unknown_node_type", record: bad, capturedAt: NOW }]);
  });
  it("rule 2: empty canonical name is rejected", () => {
    const r = validateGraphDelta({ nodes: [N("x", "concept", "---")], edges: [] }, { now: NOW });
    expect(r.rejected.map((x) => x.reason)).toEqual(["empty_canonical_name"]);
  });
  it("rule 3: unknown edge type is rejected", () => {
    const r = validateGraphDelta({ nodes: [N("a", "concept", "a"), N("b", "concept", "b")], edges: [E("e", "covers", "a", "b")] }, { now: NOW });
    expect(r.rejected.map((x) => [x.id, x.reason])).toEqual([["rej:edge:e", "unknown_edge_type"]]);
  });
  it("rule 4: self reference is rejected", () => {
    const r = validateGraphDelta({ nodes: [N("a", "concept", "a")], edges: [E("e", "related_to", "a", "a")] }, { now: NOW });
    expect(r.rejected.map((x) => x.reason)).toEqual(["self_reference"]);
  });
  it("rule 5: an edge touching a rejected or unknown node is rejected as dangling", () => {
    const nodes = [N("a", "concept", "a"), N("m", "metric", "p95")];
    const edges = [E("e1", "related_to", "a", "m"), E("e2", "related_to", "a", "ghost"), E("e3", "related_to", "a", "known"), E("e4", "related_to", "ghost", "a")];
    const r = validateGraphDelta({ nodes, edges }, { now: NOW, knownNodes: new Map([["known", "concept"]]) });
    expect(r.accepted.edges.map((e) => e.id)).toEqual(["e3"]);
    expect(r.rejected.map((x) => [x.id, x.reason])).toEqual([["rej:node:m", "unknown_node_type"], ["rej:edge:e1", "dangling_endpoint"], ["rej:edge:e2", "dangling_endpoint"], ["rej:edge:e4", "dangling_endpoint"]]);
  });
  it("rule 6: modifies/imports target file|function; fixes targets error|file|function", () => {
    const nodes = [N("f", "function", "run"), N("c", "concept", "idea"), N("file", "file", "a.ts"), N("err", "error", "E1")];
    const edges = [E("ok1", "modifies", "f", "file"), E("ok2", "fixes", "f", "err"), E("bad1", "modifies", "f", "c"), E("bad2", "fixes", "file", "c"), E("bad3", "imports", "c", "c2")];
    const r = validateGraphDelta({ nodes, edges }, { now: NOW, knownNodes: new Map([["c2", "concept"]]) });
    expect(r.accepted.edges.map((e) => e.id)).toEqual(["ok1", "ok2"]);
    expect(r.rejected.map((x) => [x.id, x.reason])).toEqual([["rej:edge:bad1", "invalid_target_type"], ["rej:edge:bad2", "invalid_target_type"], ["rej:edge:bad3", "invalid_target_type"]]);
  });
  it("rule 7: a decision node needs a source ref or observation id", () => {
    const orphan = N("d", "decision", "use native engine", { sourceObservationIds: [] });
    const sourced = N("d2", "decision", "x", { sourceObservationIds: [], sourceRefs: [{ sourceKind: "summary", sourceId: "s1" }] });
    const r = validateGraphDelta({ nodes: [orphan, sourced], edges: [] }, { now: NOW });
    expect(r.accepted.nodes.map((n) => n.id)).toEqual(["d2"]);
    expect(r.rejected.map((x) => x.reason)).toEqual(["missing_source_ref"]);
  });
  it("import mode skips rules 6 and 7 but keeps the vocabulary rules", () => {
    const nodes = [N("d", "decision", "rationale", { sourceObservationIds: [] }), N("doc", "concept", "paper A"), N("doc2", "concept", "paper B"), N("m", "metric", "p95")];
    const edges = [E("e1", "imports", "doc", "doc2"), E("e2", "covers", "doc", "doc2")];
    const r = validateGraphDelta({ nodes, edges }, { now: NOW, mode: "import" });
    expect(r.accepted.nodes.map((n) => n.id)).toEqual(["d", "doc", "doc2"]);
    expect(r.accepted.edges.map((e) => e.id)).toEqual(["e1"]);
    expect(r.rejected.map((x) => x.reason)).toEqual(["unknown_node_type", "unknown_edge_type"]);
  });
  it("does not mutate its inputs and is deterministic", () => {
    const nodes = [N("a", "concept", "a"), N("m", "metric", "p")];
    const edges = [E("e", "related_to", "a", "m")];
    const before = JSON.stringify({ nodes, edges });
    const r1 = validateGraphDelta({ nodes, edges }, { now: NOW });
    const r2 = validateGraphDelta({ nodes, edges }, { now: NOW });
    expect(JSON.stringify({ nodes, edges })).toBe(before);
    expect(r1).toEqual(r2);
  });
  it("empty delta → empty result; malformed records are rejected as unknown type", () => {
    expect(validateGraphDelta({ nodes: [], edges: [] }, { now: NOW })).toEqual({ accepted: { nodes: [], edges: [] }, rejected: [] });
    const r = validateGraphDelta({ nodes: [{ ...N("x", "concept", "a"), type: undefined as never }], edges: [] }, { now: NOW });
    expect(r.rejected.map((x) => x.reason)).toEqual(["unknown_node_type"]);
  });
});

import { GRAPH_EXTRACTION_SYSTEM } from "../src/prompts/graph-extraction.js";
describe("extraction prompt vocabulary", () => {
  it("lists every allowed node and edge type and states that others are discarded", () => {
    for (const t of NODE_TYPES) expect(GRAPH_EXTRACTION_SYSTEM).toContain(t);
    for (const t of EDGE_TYPES) expect(GRAPH_EXTRACTION_SYSTEM).toContain(t);
    expect(GRAPH_EXTRACTION_SYSTEM).toContain("Only these types are valid");
  });
});
