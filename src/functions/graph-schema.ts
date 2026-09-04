// graph-schema.ts — closed vocabulary, canonical identity and delta validation for the
// knowledge graph. Pure functions only: no I/O, no clock, inputs never mutated.
import type { GraphEdge, GraphNode, GraphNodeType, GraphEdgeType, GraphVisibility } from "../types.js";

export const NODE_TYPES: ReadonlySet<GraphNodeType> = new Set<GraphNodeType>([
  "file", "function", "concept", "error", "decision", "pattern", "library", "person",
  "project", "preference", "location", "organization", "event", "task", "feature",
]);

export const EDGE_TYPES: ReadonlySet<GraphEdgeType> = new Set<GraphEdgeType>([
  "uses", "imports", "modifies", "causes", "fixes", "depends_on", "related_to", "works_at",
  "prefers", "blocked_by", "caused_by", "optimizes_for", "rejected", "avoids", "located_in",
  "succeeded_by", "implements", "part_of", "contains", "documents", "defines", "validates", "tests",
]);

export interface GraphScope {
  projectId?: string;
  visibility?: GraphVisibility;
  actorAgentId?: string;
}

// Moved verbatim from graph.ts so the identity key has exactly one definition.
export function graphScopeKey(scope: GraphScope): string {
  if (!scope.projectId && !scope.visibility && !scope.actorAgentId) return "";
  const visibility = scope.visibility ?? "project";
  const owner = visibility === "agent_private" ? scope.actorAgentId ?? "" : "";
  return `${scope.projectId ?? "__global__"}|${visibility}|${owner}`;
}

// Whitespace, underscores and hyphens (ASCII, U+2010, U+2011) are spelling variants of the
// same name. Dots, colons and slashes are NOT ("node:test" vs "node --test" differ). No
// plural stripping. Files keep everything except backslash runs → "/" and case.
const SEPARATORS = /[\s_\-‐‑]+/g;

export function canonicalGraphName(type: string, name: string): string {
  const base = String(name ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
  if (!base) return "";
  if (type === "file") return base.replace(/\\+/g, "/");
  return base.replace(SEPARATORS, " ").trim();
}

export function canonicalGraphKey(type: string, name: string, scope: GraphScope = {}): string {
  const prefix = graphScopeKey(scope);
  const identity = `${type}|${canonicalGraphName(type, name)}`;
  return prefix ? `${prefix}|${identity}` : identity;
}

export type RejectReason =
  | "unknown_node_type" | "unknown_edge_type" | "empty_canonical_name" | "invalid_target_type"
  | "self_reference" | "dangling_endpoint" | "missing_source_ref";

export interface RejectedAssertion {
  id: string;
  kind: "node" | "edge";
  reason: RejectReason;
  record: GraphNode | GraphEdge;
  capturedAt: string;
}

export interface GraphDelta { nodes: GraphNode[]; edges: GraphEdge[] }

// Relationship target constraints. "fixes" may point at the error it fixed as well as code.
const TARGET_RULES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["modifies", new Set(["file", "function"])],
  ["imports", new Set(["file", "function"])],
  ["fixes", new Set(["error", "file", "function"])],
]);

// Splits a delta into what the store accepts and what it rejects (with a reason and the
// verbatim record). Rules, in order: node type in vocabulary; canonical name non-empty;
// [extract mode] decision nodes carry provenance; edge type in vocabulary; no self
// reference; both endpoints accepted or known; [extract mode] target-type constraints.
// "import" mode (graphify) skips the provenance and target-type rules because those
// records carry provenance in properties and relate documents rather than code.
export function validateGraphDelta(
  delta: GraphDelta,
  ctx: { knownNodes?: ReadonlyMap<string, GraphNodeType>; now?: string; mode?: "extract" | "import" } = {},
): { accepted: GraphDelta; rejected: RejectedAssertion[] } {
  const capturedAt = ctx.now ?? new Date().toISOString();
  const importMode = ctx.mode === "import";
  const rejected: RejectedAssertion[] = [];
  const reject = (kind: "node" | "edge", reason: RejectReason, record: GraphNode | GraphEdge): void => {
    rejected.push({ id: `rej:${kind}:${record.id}`, kind, reason, record, capturedAt });
  };

  const acceptedNodes: GraphNode[] = [];
  const typeOf = new Map<string, GraphNodeType>(ctx.knownNodes ?? []);
  for (const node of delta.nodes) {
    if (!node || !NODE_TYPES.has(node.type)) { reject("node", "unknown_node_type", node); continue; }
    if (!canonicalGraphName(node.type, node.name)) { reject("node", "empty_canonical_name", node); continue; }
    if (!importMode && node.type === "decision" && (node.sourceObservationIds?.length ?? 0) === 0 && (node.sourceRefs?.length ?? 0) === 0) {
      reject("node", "missing_source_ref", node); continue;
    }
    acceptedNodes.push(node);
    typeOf.set(node.id, node.type);
  }

  const acceptedEdges: GraphEdge[] = [];
  for (const edge of delta.edges) {
    if (!edge || !EDGE_TYPES.has(edge.type)) { reject("edge", "unknown_edge_type", edge); continue; }
    if (edge.sourceNodeId === edge.targetNodeId) { reject("edge", "self_reference", edge); continue; }
    const targetType = typeOf.get(edge.targetNodeId);
    if (!typeOf.has(edge.sourceNodeId) || targetType === undefined) { reject("edge", "dangling_endpoint", edge); continue; }
    const allowed = TARGET_RULES.get(edge.type);
    if (!importMode && allowed && !allowed.has(targetType)) { reject("edge", "invalid_target_type", edge); continue; }
    acceptedEdges.push(edge);
  }
  return { accepted: { nodes: acceptedNodes, edges: acceptedEdges }, rejected };
}
