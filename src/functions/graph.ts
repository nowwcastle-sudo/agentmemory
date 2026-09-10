import type { ISdk } from "../iii-compat.js";
import type {
  GraphNode,
  GraphEdge,
  GraphQueryResult,
  GraphSnapshot,
  CompressedObservation,
  GraphSourceLocator,
  GraphVisibility,
  RetrievalScope,
  MemoryProvider,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import {
  GRAPH_EXTRACTION_SYSTEM,
  buildGraphExtractionPrompt,
} from "../prompts/graph-extraction.js";
import { isGraphExtractionEnabled } from "../config.js";
import { recordAudit } from "./audit.js";
import { logger } from "../logger.js";
import { matchesRetrievalScope } from "../state/retrieval-scope.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import {
  canonicalGraphKey,
  graphScopeKey,
  validateGraphDelta,
  type RejectedAssertion,
} from "./graph-schema.js";
import { ProjectionCoordinator } from "./projection-coordinator.js";

export type GraphExtractRequest = {
  observations: CompressedObservation[];
  mode?: "configured" | "structural" | "semantic";
};

export type GraphExtractionResult = {
  success: boolean;
  nodesAdded?: number;
  edgesAdded?: number;
  structureFound?: boolean;
  semanticRequested?: boolean;
  semanticApplied?: boolean;
  rejectedCount?: number;
  error?: string;
};

export type GraphExtractCore = (
  data: GraphExtractRequest,
) => Promise<GraphExtractionResult>;

// #753: keep the response payload below the iii state channel ceiling.
// 500 nodes + their incident edges hold well under the limit on the
// reported 11k-node / 28k-edge corpus, and 5,000 is the upper bound a
// caller can request explicitly. Tuned conservatively because edges
// fan out faster than nodes.
const DEFAULT_GRAPH_QUERY_LIMIT = 500;
const MAX_GRAPH_QUERY_LIMIT = 5000;

// #814: the precomputed snapshot covers the top-degree subgraph used by
// the empty-body / nodeType-only branch — the path the viewer hits on
// tab load. Sized to match the default query limit so the snapshot can
// service a default-cap request without falling back to live
// enumeration. Aggregate stats (nodesByType / edgesByType) are computed
// fresh during rebuild and stored alongside.
const SNAPSHOT_TOP_NODES = DEFAULT_GRAPH_QUERY_LIMIT;
const SNAPSHOT_KEY = "current";

// `state::list` over a 75K-node scope can exceed the iii invocation
// timeout. The query handler races the enumeration against this budget
// and falls back to the snapshot (or a warning envelope) when the live
// path is too slow. 6000ms leaves headroom under the default 8s engine
// invocation deadline.
const LIVE_ENUMERATION_BUDGET_MS = 6000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label}: exceeded ${ms}ms budget`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

function emptySnapshot(): GraphSnapshot {
  return {
    version: 1,
    topNodes: [],
    topEdges: [],
    topDegrees: {},
    stats: {
      totalNodes: 0,
      totalEdges: 0,
      nodesByType: {},
      edgesByType: {},
    },
    updatedAt: new Date(0).toISOString(),
    dirty: true,
  };
}

function belongsToCurrentGeneration(
  record: GraphNode | GraphEdge,
  snapshot: GraphSnapshot | null,
): boolean {
  if (!snapshot) return true;
  if (snapshot.graphGeneration) {
    return record.graphGeneration === snapshot.graphGeneration;
  }
  if (snapshot.resetAt) return record.createdAt >= snapshot.resetAt;
  return true;
}

/**
 * A failed read is not an empty graph. `readSnapshot` collapses both into
 * `null`, which is fine for readers but not for writers: persisting a fresh
 * `emptySnapshot()` over a real one destroys the recorded totals and the
 * top-degree subgraph, leaving only a warn line. One
 * "Invocation timeout after 180000ms: state::get" did exactly that on
 * 2026-09-04, taking the recorded graph from 13,007 nodes to zero.
 */
type SnapshotRead =
  | { readable: true; snapshot: GraphSnapshot | null }
  | { readable: false };

async function readSnapshotResult(kv: StateKV): Promise<SnapshotRead> {
  try {
    const snap = await kv.get<GraphSnapshot>(KV.graphSnapshot, SNAPSHOT_KEY);
    return {
      readable: true,
      snapshot:
        snap && typeof snap === "object" && snap.version === 1 ? snap : null,
    };
  } catch (err) {
    logger.warn("Graph snapshot read failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { readable: false };
  }
}

async function readSnapshot(kv: StateKV): Promise<GraphSnapshot | null> {
  try {
    const snap = await kv.get<GraphSnapshot>(KV.graphSnapshot, SNAPSHOT_KEY);
    if (snap && typeof snap === "object" && snap.version === 1) {
      return snap;
    }
    return null;
  } catch (err) {
    logger.warn("Graph snapshot read failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function buildSnapshotFromArrays(
  nodes: GraphNode[],
  edges: GraphEdge[],
  base?: GraphSnapshot | null,
): GraphSnapshot {
  const liveNodes = nodes.filter(
    (node) => !node.stale && belongsToCurrentGeneration(node, base ?? null),
  );
  const liveNodeIds = new Set(liveNodes.map((node) => node.id));
  const liveEdges = edges.filter(
    (edge) =>
      !edge.stale &&
      belongsToCurrentGeneration(edge, base ?? null) &&
      liveNodeIds.has(edge.sourceNodeId) &&
      liveNodeIds.has(edge.targetNodeId),
  );
  // Build the global degree map once so we can both rank by it AND
  // snapshot the per-top-node values into topDegrees for synchronous
  // re-sort after incremental edge writes.
  const degree = new Map<string, number>();
  for (const e of liveEdges) {
    degree.set(e.sourceNodeId, (degree.get(e.sourceNodeId) ?? 0) + 1);
    degree.set(e.targetNodeId, (degree.get(e.targetNodeId) ?? 0) + 1);
  }
  const ranked = [...liveNodes]
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
    .slice(0, SNAPSHOT_TOP_NODES);
  const rankedIds = new Set(ranked.map((n) => n.id));
  const topEdges = liveEdges.filter(
    (e) => rankedIds.has(e.sourceNodeId) && rankedIds.has(e.targetNodeId),
  );
  const topDegrees: Record<string, number> = {};
  for (const n of ranked) {
    topDegrees[n.id] = degree.get(n.id) ?? 0;
  }
  const nodesByType: Record<string, number> = {};
  for (const n of liveNodes) {
    nodesByType[n.type] = (nodesByType[n.type] || 0) + 1;
  }
  const edgesByType: Record<string, number> = {};
  for (const e of liveEdges) {
    edgesByType[e.type] = (edgesByType[e.type] || 0) + 1;
  }
  return {
    version: 1,
    ...(base?.graphGeneration
      ? { graphGeneration: base.graphGeneration }
      : {}),
    ...(base?.resetAt ? { resetAt: base.resetAt } : {}),
    topNodes: ranked,
    topEdges,
    topDegrees,
    stats: {
      totalNodes: liveNodes.length,
      totalEdges: liveEdges.length,
      nodesByType,
      edgesByType,
      // The rejected counter is cumulative history, not derivable from the arrays.
      ...(base?.stats?.rejected !== undefined ? { rejected: base.stats.rejected } : {}),
    },
    updatedAt: new Date().toISOString(),
    dirty: false,
  };
}

function paginateFromSnapshot(
  snap: GraphSnapshot,
  filterType: string | undefined,
  limit: number,
  offset: number,
): GraphQueryResult {
  const filteredNodes = filterType
    ? snap.topNodes.filter((n) => n.type === filterType)
    : snap.topNodes;
  const total = filterType
    ? snap.stats.nodesByType[filterType] ?? 0
    : snap.stats.totalNodes;
  const pageNodes = filteredNodes.slice(offset, offset + limit);
  const pageIds = new Set(pageNodes.map((n) => n.id));
  const pageEdges = snap.topEdges.filter(
    (e) => pageIds.has(e.sourceNodeId) && pageIds.has(e.targetNodeId),
  );
  return {
    nodes: pageNodes,
    edges: pageEdges,
    depth: 0,
    totalNodes: total,
    totalEdges: snap.stats.totalEdges,
    truncated: total > pageNodes.length,
    limit,
    offset,
    fromSnapshot: true,
  };
}

// #814 v2: the rebuild path won't terminate on corpora large enough
// that kv.list returns a payload too big to JSON.parse without
// starving the iii heartbeat. We don't actually know the corpus size
// without enumerating, but we can refuse to start a rebuild if the
// snapshot's recorded `totalNodes` already exceeds this threshold —
// the rebuild path is unreliable above it, and an incremental
// extract-driven snapshot is the right approach for those corpora.
// Operators above the threshold should use mem::graph-reset and let
// future extracts rebuild incrementally.
const REBUILD_SAFE_NODE_CEILING = 25000;

export function normalizeGraphName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function nameIndexKey(
  type: string,
  name: string,
  scope: {
    projectId?: string;
    visibility?: GraphVisibility;
    actorAgentId?: string;
  } = {},
): string {
  // graph-schema owns identity: scope + type + canonical name (case, whitespace,
  // underscores and hyphens unified; dots/colons/slashes preserved).
  return canonicalGraphKey(type, name, scope);
}

function observationSourceRef(
  observation: CompressedObservation,
): GraphSourceLocator {
  return {
    sourceKind: observation.sourceKind ??
      (observation.id.startsWith("mem_") ? "memory" : "observation"),
    sourceId: observation.id,
    sessionId: observation.sessionId,
    ...(observation.projectId ? { projectId: observation.projectId } : {}),
    ...(observation.agentId
      ? { actorAgentId: observation.agentId }
      : {}),
    ...(observation.visibility
      ? { visibility: observation.visibility }
      : {}),
  };
}

function mergeSourceRefs(
  ...groups: Array<GraphSourceLocator[] | undefined>
): GraphSourceLocator[] | undefined {
  const merged = new Map<string, GraphSourceLocator>();
  for (const refs of groups) {
    for (const ref of refs ?? []) {
      const key = `${ref.sourceKind}:${ref.sourceId}:${ref.sessionId ?? ""}`;
      merged.set(key, ref);
    }
  }
  return merged.size > 0 ? Array.from(merged.values()) : undefined;
}

function edgeIndexKey(
  sourceNodeId: string,
  targetNodeId: string,
  type: string,
): string {
  return `${sourceNodeId}|${targetNodeId}|${type}`;
}

// Mutates `snap` to apply a +1 (or -1) degree delta for nodeId,
// maintaining the top-N ranking. Returns the new degree. Reads /
// writes the per-node degree counter via targeted kv.get/set so we
// never enumerate. Top-N membership flips when:
//   - node's new degree > current min in topNodes AND it's not in
//     topNodes (promote, evict tail if topNodes is full)
//   - node IS in topNodes and its position needs resorting (re-sort
//     topNodes in place)
async function applyDegreeDelta(
  kv: StateKV,
  snap: GraphSnapshot,
  nodeId: string,
  delta: number,
): Promise<number> {
  const prev = (await kv.get<number>(KV.graphNodeDegree, nodeId)) ?? 0;
  const next = Math.max(0, prev + delta);
  await kv.set(KV.graphNodeDegree, nodeId, next);

  const inTop = snap.topNodes.findIndex((n) => n.id === nodeId);
  if (inTop !== -1) {
    // Cache the new degree in topDegrees so the comparator runs
    // synchronously over numbers, not async kv.get calls. Re-sort
    // descending by degree.
    snap.topDegrees[nodeId] = next;
    snap.topNodes.sort(
      (a, b) =>
        (snap.topDegrees[b.id] ?? 0) - (snap.topDegrees[a.id] ?? 0),
    );
    return next;
  }

  if (snap.topNodes.length < SNAPSHOT_TOP_NODES) {
    // Capacity available — fetch + promote.
    const node = await kv.get<GraphNode>(KV.graphNodes, nodeId);
    if (node && !node.stale) {
      snap.topNodes.push(node);
      snap.topDegrees[node.id] = next;
      snap.topNodes.sort(
        (a, b) =>
          (snap.topDegrees[b.id] ?? 0) - (snap.topDegrees[a.id] ?? 0),
      );
    }
    return next;
  }

  // topNodes is full; the cutoff is the tail's cached degree.
  const tailEntry = snap.topNodes[snap.topNodes.length - 1];
  if (!tailEntry) return next;
  const tailDegree = snap.topDegrees[tailEntry.id] ?? 0;
  if (next > tailDegree) {
    const node = await kv.get<GraphNode>(KV.graphNodes, nodeId);
    if (node && !node.stale) {
      const evicted = snap.topNodes.pop();
      if (evicted) delete snap.topDegrees[evicted.id];
      snap.topNodes.push(node);
      snap.topDegrees[node.id] = next;
      snap.topNodes.sort(
        (a, b) =>
          (snap.topDegrees[b.id] ?? 0) - (snap.topDegrees[a.id] ?? 0),
      );
    }
  }
  return next;
}

function snapshotPushEdgeIfBothInTop(
  snap: GraphSnapshot,
  edge: GraphEdge,
): void {
  const topIds = new Set(snap.topNodes.map((n) => n.id));
  if (topIds.has(edge.sourceNodeId) && topIds.has(edge.targetNodeId)) {
    // Dedupe in case the same edge gets pushed twice.
    if (!snap.topEdges.find((e) => e.id === edge.id)) {
      snap.topEdges.push(edge);
    }
  }
}

function mergeNode(
  existing: GraphNode,
  incoming: GraphNode,
  obsIds: string[],
  capturedAt: string,
): GraphNode {
  const aliases = mergeAliases(existing, incoming);
  return {
    ...existing,
    sourceObservationIds: [
      ...new Set([
        ...existing.sourceObservationIds,
        ...incoming.sourceObservationIds,
        ...obsIds,
      ]),
    ],
    sourceRefs: mergeSourceRefs(existing.sourceRefs, incoming.sourceRefs),
    properties: { ...existing.properties, ...incoming.properties },
    updatedAt: capturedAt,
    ...(aliases ? { aliases } : {}),
  };
}

// A merged-in spelling variant is kept as an alias of the keeper (never the keeper's own name).
function mergeAliases(existing: GraphNode, incoming: GraphNode): string[] | undefined {
  const out = new Set<string>(existing.aliases ?? []);
  for (const a of incoming.aliases ?? []) out.add(a);
  if (incoming.name !== existing.name) out.add(incoming.name);
  out.delete(existing.name);
  return out.size > 0 ? Array.from(out) : undefined;
}

// Rejected assertions are kept verbatim up to this many (counter on the snapshot keeps
// counting past it) so a runaway extractor cannot grow the scope without bound.
const REJECTED_STORE_CAP = 5000;

// `alreadyCounted` = rejections of the current batch not yet folded into the snapshot counter,
// so one large delta cannot overshoot the cap.
async function storeRejected(kv: StateKV, snap: GraphSnapshot, r: RejectedAssertion, alreadyCounted = 0): Promise<void> {
  if ((snap.stats.rejected ?? 0) + alreadyCounted >= REJECTED_STORE_CAP) return;
  await kv.set(KV.graphRejected, r.id, r);
}

function mergeEdge(
  existing: GraphEdge,
  incoming: GraphEdge,
  obsIds: string[],
): GraphEdge {
  return {
    ...existing,
    sourceObservationIds: [
      ...new Set([...existing.sourceObservationIds, ...obsIds]),
    ],
    sourceRefs: mergeSourceRefs(existing.sourceRefs, incoming.sourceRefs),
  };
}

function resolvePagination(
  rawLimit: number | undefined,
  rawOffset: number | undefined,
): { limit: number; offset: number } {
  const requested = typeof rawLimit === "number" && Number.isFinite(rawLimit)
    ? Math.floor(rawLimit)
    : DEFAULT_GRAPH_QUERY_LIMIT;
  const limit = Math.max(1, Math.min(requested, MAX_GRAPH_QUERY_LIMIT));
  const offset = Math.max(
    0,
    typeof rawOffset === "number" && Number.isFinite(rawOffset)
      ? Math.floor(rawOffset)
      : 0,
  );
  return { limit, offset };
}

function paginate(
  nodes: GraphNode[],
  allEdges: GraphEdge[],
  depth: number,
  limit: number,
  offset: number,
): GraphQueryResult {
  const totalNodes = nodes.length;
  const pageNodes = nodes.slice(offset, offset + limit);
  const pageNodeIds = new Set(pageNodes.map((n) => n.id));
  // Edges restricted to the page so the response payload scales with
  // `limit`, not with the global edge count. An edge is included only
  // when BOTH endpoints land in the page — half-edges to nodes outside
  // the page would render as dangling links in the viewer.
  const pageEdges = allEdges.filter(
    (e) => pageNodeIds.has(e.sourceNodeId) && pageNodeIds.has(e.targetNodeId),
  );
  // Total edges (for the same node universe). Counted unbounded so the
  // viewer can show "showing X of Y" without re-querying.
  const universeIds = new Set(nodes.map((n) => n.id));
  const totalEdges = allEdges.reduce(
    (count, e) =>
      universeIds.has(e.sourceNodeId) && universeIds.has(e.targetNodeId)
        ? count + 1
        : count,
    0,
  );
  return {
    nodes: pageNodes,
    edges: pageEdges,
    depth,
    totalNodes,
    totalEdges,
    truncated: totalNodes > pageNodes.length,
    limit,
    offset,
  };
}

// Parse all key="value" pairs from a tag's attribute string, in any
// order. The previous parser hard-coded attribute order
// (type before name on <entity>, type/source/target/weight on
// <relationship>) and silently dropped nodes/edges when the upstream
// LLM emitted attributes in a different order — Codex in particular
// likes to lead with `name=` (#635).
export function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([A-Za-z_][\w:-]*)="([^"]*)"/g;
  let m;
  while ((m = attrRegex.exec(raw)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

function parseGraphXml(
  xml: string,
  observations: CompressedObservation[],
): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const now = new Date().toISOString();
  const observationIds = observations.map((observation) => observation.id);
  const sourceRefs = observations.map(observationSourceRef);
  const scope = sourceRefs[0];

  // Two passes because <entity> can be self-closing or have a body
  // (<property> children). The self-closing form needs `[^>]*[^/]` on
  // the attr group so the trailing `/` isn't swallowed into the match
  // (root cause of #494). The explicit-close form picks up the
  // property block.
  const entitySelfClose = /<entity\b([^>]*?)\/>/g;
  const entityWithBody = /<entity\b([^>]*[^/])>([\s\S]*?)<\/entity>/g;

  const addEntity = (rawAttrs: string, propsBlock = ""): void => {
    const attrs = parseAttrs(rawAttrs);
    const type = attrs["type"] as GraphNode["type"] | undefined;
    const name = attrs["name"];
    if (!type || !name) return;
    const properties: Record<string, string> = {};
    const propRegex = /<property\s+key="([^"]+)">([^<]*)<\/property>/g;
    let propMatch;
    while ((propMatch = propRegex.exec(propsBlock)) !== null) {
      properties[propMatch[1]] = propMatch[2];
    }
    nodes.push({
      id: generateId("gn"),
      type,
      name: normalizeGraphName(name),
      properties,
      sourceObservationIds: observationIds,
      sourceRefs,
      ...(scope?.projectId ? { projectId: scope.projectId } : {}),
      ...(scope?.actorAgentId && scope.visibility === "agent_private"
        ? { actorAgentId: scope.actorAgentId }
        : {}),
      ...(scope?.visibility ? { visibility: scope.visibility } : {}),
      createdAt: now,
    });
  };

  let match;
  while ((match = entitySelfClose.exec(xml)) !== null) {
    addEntity(match[1]);
  }
  while ((match = entityWithBody.exec(xml)) !== null) {
    addEntity(match[1], match[2]);
  }

  const relRegex = /<relationship\b([^>]*?)\/>/g;
  while ((match = relRegex.exec(xml)) !== null) {
    const attrs = parseAttrs(match[1]);
    const type = attrs["type"] as GraphEdge["type"] | undefined;
    const sourceName = attrs["source"];
    const targetName = attrs["target"];
    if (!type || !sourceName || !targetName) continue;
    const parsedWeight = parseFloat(attrs["weight"] ?? "");
    const weight = Number.isFinite(parsedWeight) ? parsedWeight : 0.5;

    const normalizedSource = normalizeGraphName(sourceName).toLocaleLowerCase("en-US");
    const normalizedTarget = normalizeGraphName(targetName).toLocaleLowerCase("en-US");
    const sourceNode = nodes.find(
      (n) => n.name.toLocaleLowerCase("en-US") === normalizedSource,
    );
    const targetNode = nodes.find(
      (n) => n.name.toLocaleLowerCase("en-US") === normalizedTarget,
    );
    if (!sourceNode || !targetNode) continue;
    edges.push({
      id: generateId("ge"),
      type,
      sourceNodeId: sourceNode.id,
      targetNodeId: targetNode.id,
      weight: Math.max(0, Math.min(1, weight)),
      sourceObservationIds: observationIds,
      sourceRefs,
      ...(scope?.projectId ? { projectId: scope.projectId } : {}),
      ...(scope?.actorAgentId && scope.visibility === "agent_private"
        ? { actorAgentId: scope.actorAgentId }
        : {}),
      ...(scope?.visibility ? { visibility: scope.visibility } : {}),
      createdAt: now,
    });
  }

  return { nodes, edges };
}

const HEURISTIC_EDGE_WEIGHT = 0.4;
const MAX_HEURISTIC_EDGES_PER_OBS = 12;

export function extractGraphHeuristics(
  observations: CompressedObservation[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const now = new Date().toISOString();
  const nodes: GraphNode[] = [];
  const nodeByKey = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeByPair = new Map<string, GraphEdge>();

  const nodeFor = (
    type: GraphNode["type"],
    name: string,
    observation: CompressedObservation,
  ): GraphNode | null => {
    const trimmed = normalizeGraphName(name);
    if (!trimmed) return null;
    const sourceRef = observationSourceRef(observation);
    const key = canonicalGraphKey(type, trimmed, sourceRef);
    let node = nodeByKey.get(key);
    if (!node) {
      node = {
        id: generateId("gn"),
        type,
        name: trimmed,
        properties: {},
        sourceObservationIds: [observation.id],
        sourceRefs: [sourceRef],
        ...(sourceRef.projectId ? { projectId: sourceRef.projectId } : {}),
        ...(sourceRef.actorAgentId && sourceRef.visibility === "agent_private"
          ? { actorAgentId: sourceRef.actorAgentId }
          : {}),
        ...(sourceRef.visibility
          ? { visibility: sourceRef.visibility }
          : {}),
        createdAt: now,
      };
      nodeByKey.set(key, node);
      nodes.push(node);
    } else if (!node.sourceObservationIds.includes(observation.id)) {
      node.sourceObservationIds.push(observation.id);
      node.sourceRefs = mergeSourceRefs(node.sourceRefs, [sourceRef]);
    }
    return node;
  };

  for (const obs of observations) {
    let budget = MAX_HEURISTIC_EDGES_PER_OBS;
    const link = (a: GraphNode | null, b: GraphNode | null): void => {
      if (!a || !b || a.id === b.id) return;
      const pair = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      const existing = edgeByPair.get(pair);
      if (existing) {
        if (!existing.sourceObservationIds.includes(obs.id)) {
          existing.sourceObservationIds.push(obs.id);
          existing.sourceRefs = mergeSourceRefs(existing.sourceRefs, [
            observationSourceRef(obs),
          ]);
        }
        return;
      }
      if (budget <= 0) return;
      budget -= 1;
      const edge: GraphEdge = {
        id: generateId("ge"),
        type: "related_to",
        sourceNodeId: a.id,
        targetNodeId: b.id,
        weight: HEURISTIC_EDGE_WEIGHT,
        sourceObservationIds: [obs.id],
        sourceRefs: [observationSourceRef(obs)],
        ...(obs.projectId ? { projectId: obs.projectId } : {}),
        ...(obs.agentId && obs.visibility === "agent_private"
          ? { actorAgentId: obs.agentId }
          : {}),
        ...(obs.visibility ? { visibility: obs.visibility } : {}),
        createdAt: now,
      };
      edgeByPair.set(pair, edge);
      edges.push(edge);
    };

    const fileNodes = (obs.files ?? []).map((f) =>
      nodeFor("file", f, obs),
    );
    const conceptNodes = (obs.concepts ?? []).map((c) =>
      nodeFor("concept", c, obs),
    );

    // Only concept x file co-occurrence. Linking adjacent concepts or adjacent
    // files to each other was dropped on 2026-09-10: adjacency in a list is
    // not a relationship, and on the live store those chains were a quarter of
    // all related_to edges (11k concept-concept, 1.4k file-file) with a median
    // of one backing observation.
    for (const concept of conceptNodes) {
      for (const file of fileNodes) link(concept, file);
    }
  }

  return { nodes, edges };
}

// Shared persistence for a batch of extracted/imported nodes and edges.
// Factored out of mem::graph-extract so structural importers (graphify)
// reuse the exact same name-index upsert, degree bookkeeping, and snapshot
// maintenance — which also makes re-imports idempotent: an existing
// (type, name) resolves through the name index and merges instead of
// duplicating.
//
// #814 v2: targeted name-index lookups replace the O(n) scan over
// `kv.list<GraphNode>(KV.graphNodes)`. At 75K nodes the list payload
// exceeds the iii heartbeat budget and the worker dies before merge can
// complete. Each name-index entry is a single small kv.get/set pair.
async function persistGraphDeltaUnlocked(
  kv: StateKV,
  nodes: GraphNode[],
  edges: GraphEdge[],
  obsIds: string[],
  rejectedCount = 0,
  // Taken from the caller so one delta reads the snapshot once: reading twice
  // lets the second read fail after rejected rows were already stored against
  // the first, and the cap counter then never catches up.
  presuppliedRead?: SnapshotRead,
): Promise<{ newNodeCount: number; newEdgeCount: number; rejectedCount: number }> {
  const snapshotRead = presuppliedRead ?? (await readSnapshotResult(kv));
  // When the read failed we still do the graph writes, but we must not persist
  // this scratch snapshot: it would replace the real one with empty counters.
  const snapshotWritable = snapshotRead.readable;
  const snap =
    (snapshotRead.readable ? snapshotRead.snapshot : null) ?? emptySnapshot();
  const capturedAt = new Date().toISOString();
  let newNodeCount = 0;
  let newEdgeCount = 0;
  let selfLoops = 0;
  // Merge-only batches mutate cached topNodes/topEdges entries without
  // changing the counts; track that separately so the snapshot still persists.
  let snapMutated = false;
  const newEdgesForTopCheck: GraphEdge[] = [];
  // When a freshly-minted node merges into an existing row via the name
  // index, edges in the same batch still reference the fresh id. Remap edge
  // endpoints to the persisted ids so edges never dangle and re-runs hit the
  // same edge-index key instead of duplicating.
  const idRemap = new Map<string, string>();

  for (const node of nodes) {
    const normalizedNode: GraphNode = {
      ...node,
      name: normalizeGraphName(node.name),
      ...(snap.graphGeneration
        ? { graphGeneration: snap.graphGeneration }
        : {}),
    };
    const indexKey = nameIndexKey(
      normalizedNode.type,
      normalizedNode.name,
      normalizedNode,
    );
    const existingId = await kv.get<string>(KV.graphNameIndex, indexKey);

    let existing: GraphNode | null = null;
    if (existingId) {
      existing = await kv.get<GraphNode>(KV.graphNodes, existingId);
      // #825 follow-up: name-index lookups can resolve into
      // pre-reset rows. Drop them so extract writes a fresh
      // node + index entry instead of silently reconnecting
      // to a legacy orphan (which would keep the snapshot at
      // 0 forever after a reset).
      if (existing && !belongsToCurrentGeneration(existing, snap)) {
        existing = null;
      }
    }

    if (existing) {
      idRemap.set(normalizedNode.id, existing.id);
      const merged = mergeNode(existing, normalizedNode, obsIds, capturedAt);
      await kv.set(KV.graphNodes, existing.id, merged);
      // Update topNodes entry if present so a stale clone isn't
      // returned from the snapshot fast path.
      const topIdx = snap.topNodes.findIndex((n) => n.id === existing!.id);
      if (topIdx !== -1) {
        snap.topNodes[topIdx] = merged;
        snapMutated = true;
      }
    } else {
      await kv.set(KV.graphNodes, normalizedNode.id, normalizedNode);
      await kv.set(KV.graphNameIndex, indexKey, normalizedNode.id);
      await kv.set(KV.graphNodeDegree, normalizedNode.id, 0);
      snap.stats.totalNodes += 1;
      snap.stats.nodesByType[normalizedNode.type] =
        (snap.stats.nodesByType[normalizedNode.type] ?? 0) + 1;
      newNodeCount += 1;
      if (snap.topNodes.length < SNAPSHOT_TOP_NODES) {
        // Degree 0 still beats an empty slot — sit at the tail
        // until edges arrive and promote.
        snap.topNodes.push(normalizedNode);
        snap.topDegrees[normalizedNode.id] = 0;
      }
    }
  }

  for (const rawEdge of edges) {
    const edge: GraphEdge = {
      ...rawEdge,
      sourceNodeId: idRemap.get(rawEdge.sourceNodeId) ?? rawEdge.sourceNodeId,
      targetNodeId: idRemap.get(rawEdge.targetNodeId) ?? rawEdge.targetNodeId,
      ...(snap.graphGeneration
        ? { graphGeneration: snap.graphGeneration }
        : {}),
    };
    if (edge.sourceNodeId === edge.targetNodeId) {
      // Two delta nodes merged into one existing node — the edge collapsed onto itself.
      await storeRejected(kv, snap, { id: `rej:edge:${edge.id}`, kind: "edge", reason: "self_reference", record: edge, capturedAt }, rejectedCount + selfLoops);
      selfLoops += 1;
      continue;
    }
    const eKey = edgeIndexKey(edge.sourceNodeId, edge.targetNodeId, edge.type);
    const existingId = await kv.get<string>(KV.graphEdgeKey, eKey);

    let existing: GraphEdge | null = null;
    if (existingId) {
      existing = await kv.get<GraphEdge>(KV.graphEdges, existingId);
      // Same #825 orphan check as the node path above.
      if (existing && !belongsToCurrentGeneration(existing, snap)) {
        existing = null;
      }
    }

    if (existing) {
      const merged = mergeEdge(existing, edge, obsIds);
      await kv.set(KV.graphEdges, existing.id, merged);
      // Replace cached topEdges entry too if present.
      const topIdx = snap.topEdges.findIndex((e) => e.id === existing!.id);
      if (topIdx !== -1) {
        snap.topEdges[topIdx] = merged;
        snapMutated = true;
      }
    } else {
      await kv.set(KV.graphEdges, edge.id, edge);
      await kv.set(KV.graphEdgeKey, eKey, edge.id);
      snap.stats.totalEdges += 1;
      snap.stats.edgesByType[edge.type] =
        (snap.stats.edgesByType[edge.type] ?? 0) + 1;
      newEdgeCount += 1;
      await applyDegreeDelta(kv, snap, edge.sourceNodeId, +1);
      await applyDegreeDelta(kv, snap, edge.targetNodeId, +1);
      newEdgesForTopCheck.push(edge);
    }
  }

  // Push newly-added edges into snapshot.topEdges if both
  // endpoints are in the top-N (post-degree-delta). Done after
  // all degree updates so the topIds set is stable.
  for (const edge of newEdgesForTopCheck) {
    snapshotPushEdgeIfBothInTop(snap, edge);
  }

  const totalRejected = rejectedCount + selfLoops;
  if (totalRejected > 0) {
    snap.stats.rejected = (snap.stats.rejected ?? 0) + totalRejected;
    snapMutated = true;
  }

  if (!snapshotWritable) {
    // The nodes and edges above are already stored; only the derived snapshot
    // is skipped, so it goes stale rather than empty. A later rebuild fixes it.
    logger.warn("Graph snapshot update skipped after a failed read", {
      newNodeCount,
      newEdgeCount,
    });
  } else if (newNodeCount > 0 || newEdgeCount > 0 || snapMutated) {
    snap.updatedAt = capturedAt;
    snap.dirty = false;
    await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, snap);
  }

  return { newNodeCount, newEdgeCount, rejectedCount: totalRejected };
}

// Single schema seam: heuristic, LLM and graphify-import deltas all enter here. Callers
// always put both endpoints of an edge in the same delta, so knownNodes stays empty.
export async function persistGraphDelta(
  kv: StateKV,
  nodes: GraphNode[],
  edges: GraphEdge[],
  obsIds: string[],
  options: { mode?: "extract" | "import" } = {},
): Promise<{ newNodeCount: number; newEdgeCount: number; rejectedCount: number }> {
  const { accepted, rejected } = validateGraphDelta({ nodes, edges }, { mode: options.mode ?? "extract" });
  return withKeyedLock("graph-persist", async () => {
    const snapshotRead = await readSnapshotResult(kv);
    if (rejected.length > 0) {
      if (snapshotRead.readable) {
        const snap = snapshotRead.snapshot ?? emptySnapshot();
        for (const [i, r] of rejected.entries()) await storeRejected(kv, snap, r, i);
        logger.info("Graph delta partially rejected", { rejected: rejected.length });
      } else {
        // Without the current count we cannot honour REJECTED_STORE_CAP, so
        // fail closed. The assertions are still reported in rejectedCount.
        logger.warn("Rejected assertions not stored after a failed snapshot read", {
          rejected: rejected.length,
        });
      }
    }
    return persistGraphDeltaUnlocked(
      kv,
      accepted.nodes,
      accepted.edges,
      obsIds,
      rejected.length,
      snapshotRead,
    );
  });
}

export function registerGraphFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
  coordinator = new ProjectionCoordinator(),
): GraphExtractCore {
  const core: GraphExtractCore = async (data) => {
      if (!data.observations || data.observations.length === 0) {
        return { success: false, error: "No observations provided" };
      }
      const mode = data.mode ?? "configured";
      if (!(["configured", "structural", "semantic"] as const).includes(mode)) {
        return { success: false, error: "invalid graph extraction mode" };
      }

      const obsIds = data.observations.map((o) => o.id);
      const scopePartitions = new Set(
        data.observations.map((observation) =>
          graphScopeKey(observationSourceRef(observation)),
        ),
      );
      if (scopePartitions.size > 1) {
        return {
          success: false,
          error: "observations must share one project and visibility scope",
        };
      }

      let nodes: GraphNode[] = [];
      let edges: GraphEdge[] = [];
      try {
        const heuristic = extractGraphHeuristics(data.observations);
        nodes = heuristic.nodes;
        edges = heuristic.edges;
      } catch (err) {
        logger.warn("heuristic graph extraction failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const providerAvailable = !provider.name.includes("noop");
      const semanticRequested =
        mode === "semantic" ||
        (mode === "configured" &&
          isGraphExtractionEnabled() &&
          providerAvailable);
      const llmEnabled =
        mode !== "structural" &&
        isGraphExtractionEnabled() &&
        providerAvailable;
      let semanticApplied = false;
      let llmError: string | undefined;
      if (mode === "semantic" && !llmEnabled) {
        llmError = "semantic_graph_unavailable";
      }
      if (llmEnabled) {
        const prompt = buildGraphExtractionPrompt(
          data.observations.map((o) => ({
            title: o.title,
            narrative: o.narrative,
            concepts: o.concepts,
            files: o.files,
            type: o.type,
          })),
        );
        try {
          const response = await provider.compress(
            GRAPH_EXTRACTION_SYSTEM,
            prompt,
          );
          const parsed = parseGraphXml(response, data.observations);
          nodes = nodes.concat(parsed.nodes);
          edges = edges.concat(parsed.edges);
          semanticApplied = true;
        } catch (err) {
          llmError = err instanceof Error ? err.message : String(err);
          logger.error("LLM graph extraction failed", { error: llmError });
        }
      }

      if (nodes.length === 0 && edges.length === 0) {
        const success = mode === "semantic" ? semanticApplied : !llmError;
        return {
          success,
          nodesAdded: 0,
          edgesAdded: 0,
          structureFound: false,
          semanticRequested,
          semanticApplied,
          ...(!success && llmError ? { error: llmError } : {}),
        };
      }

      try {
        const { newNodeCount, newEdgeCount, rejectedCount } = await persistGraphDelta(
          kv,
          nodes,
          edges,
          obsIds,
        );

        await recordAudit(kv, "observe", "mem::graph-extract", obsIds, {
          nodesExtracted: nodes.length,
          edgesExtracted: edges.length,
        });

        logger.info("Graph extraction complete", {
          nodes: nodes.length,
          edges: edges.length,
          newNodes: newNodeCount,
          newEdges: newEdgeCount,
          llm: llmEnabled && !llmError,
        });
        const success = mode === "semantic" ? semanticApplied : true;
        return {
          success,
          nodesAdded: newNodeCount,
          edgesAdded: newEdgeCount,
          rejectedCount,
          structureFound: true,
          semanticRequested,
          semanticApplied,
          ...(!success && llmError ? { error: llmError } : {}),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Graph extraction failed", { error: msg });
        return { success: false, error: msg };
      }
  };

  sdk.registerFunction("mem::graph-extract", async (data: GraphExtractRequest) => {
    const sourceId = Array.isArray(data?.observations)
      ? data.observations.map((observation) => observation.id).join(",")
      : "invalid-observations";
    const run = await coordinator.run(
      { stage: "graph", sourceId },
      () => core(data),
    );
    return run.accepted
      ? run.value
      : { success: false, deferred: true, error: run.error };
  });

  // #753: every branch now applies a default cap and reports the
  // unbounded `total*` counts. Before this change, an unfiltered POST
  // /graph/query body (`{}`) on a corpus with ~10k+ nodes serialized
  // to a payload large enough that the iii state response channel
  // rejected it with HTTP 500 "Invocation stopped", leaving the viewer
  // graph tab silently blank.
  sdk.registerFunction("mem::graph-query",
    async (data: {
      startNodeId?: string;
      nodeType?: string;
      maxDepth?: number;
      query?: string;
      limit?: number;
      offset?: number;
      project?: string;
      agentId?: string;
    }): Promise<GraphQueryResult> => {
      const maxDepth = Math.min(data.maxDepth || 3, 5);
      const { limit, offset } = resolvePagination(data.limit, data.offset);
      const projectId =
        typeof data.project === "string" && data.project.trim()
          ? data.project.trim()
          : undefined;
      const actorAgentId =
        typeof data.agentId === "string" && data.agentId.trim()
          ? data.agentId.trim()
          : undefined;
      const wildcardAgent = actorAgentId === "*";
      const retrievalScope: RetrievalScope | undefined =
        projectId || actorAgentId
          ? {
              ...(projectId ? { projectId } : {}),
              ...(actorAgentId && !wildcardAgent ? { actorAgentId } : {}),
              wildcardAgent,
            }
          : undefined;

      // #814 v2: the empty-body / nodeType-only path NEVER enumerates.
      // It reads the snapshot exclusively. The snapshot is updated
      // inline by graph-extract, so for newly-built corpora it's
      // always current. For legacy corpora missing a snapshot the
      // operator must run mem::graph-snapshot-rebuild (safe under
      // REBUILD_SAFE_NODE_CEILING) or mem::graph-reset to wipe and
      // rebuild incrementally from new observations.
      const noWalk = !data.query && !data.startNodeId && !retrievalScope;
      if (noWalk) {
        const snap = await readSnapshot(kv);
        if (snap && snap.stats.totalNodes > 0) {
          return paginateFromSnapshot(snap, data.nodeType, limit, offset);
        }
        return {
          nodes: [],
          edges: [],
          depth: 0,
          totalNodes: 0,
          totalEdges: 0,
          truncated: false,
          limit,
          offset,
          warning:
            "No graph snapshot available. Either no graph has been " +
            "extracted yet, or you are on a legacy corpus from a pre-#814 " +
            "agentmemory build. Run POST /agentmemory/graph/snapshot-rebuild " +
            "(safe up to ~25K nodes) or POST /agentmemory/graph/reset to " +
            "wipe and let future extracts repopulate.",
        };
      }

      // Query / startNodeId paths still need broader access. Race the
      // live enumeration against a wall-clock budget so a long
      // kv.list doesn't block the worker indefinitely. On timeout the
      // caller gets a snapshot-backed approximation instead of a 500.
      let allNodes: GraphNode[];
      let allEdges: GraphEdge[];
      const currentSnapshot = await readSnapshot(kv);
      try {
        const [rawNodes, rawEdges] = await withTimeout(
          Promise.all([
            kv.list<GraphNode>(KV.graphNodes),
            kv.list<GraphEdge>(KV.graphEdges),
          ]),
          LIVE_ENUMERATION_BUDGET_MS,
          "graph-query enumeration",
        );
        allNodes = rawNodes.filter(
          (node) =>
            !node.stale && belongsToCurrentGeneration(node, currentSnapshot),
        );
        const currentNodeIds = new Set(allNodes.map((node) => node.id));
        allEdges = rawEdges.filter(
          (edge) =>
            !edge.stale &&
            belongsToCurrentGeneration(edge, currentSnapshot) &&
            currentNodeIds.has(edge.sourceNodeId) &&
            currentNodeIds.has(edge.targetNodeId),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Graph query enumeration timed out, using snapshot", {
          error: msg,
        });
        if (retrievalScope) {
          return {
            nodes: [],
            edges: [],
            depth: 0,
            totalNodes: 0,
            totalEdges: 0,
            truncated: false,
            limit,
            offset,
            warning:
              "Scoped graph enumeration exceeded budget; refusing to return an unscoped snapshot.",
          };
        }
        const snap = await readSnapshot(kv);
        if (snap) {
          return {
            ...paginateFromSnapshot(snap, data.nodeType, limit, offset),
            warning:
              "Live graph enumeration exceeded budget. Query / " +
              "startNodeId paths degrade on >25K-node corpora until a " +
              "per-node edge index lands. Result reflects top-degree " +
              "snapshot, not the requested walk.",
          };
        }
        return {
          nodes: [],
          edges: [],
          depth: 0,
          totalNodes: 0,
          totalEdges: 0,
          truncated: false,
          limit,
          offset,
          warning:
            "Graph enumeration exceeded budget and no snapshot is available.",
        };
      }

      if (retrievalScope) {
        allNodes = allNodes.filter((node) =>
          matchesRetrievalScope(node, retrievalScope),
        );
        const nodeIds = new Set(allNodes.map((node) => node.id));
        allEdges = allEdges.filter(
          (edge) =>
            matchesRetrievalScope(edge, retrievalScope) &&
            nodeIds.has(edge.sourceNodeId) &&
            nodeIds.has(edge.targetNodeId),
        );
      }

      if (data.query) {
        const lower = data.query.toLowerCase();
        const matchingNodes = allNodes.filter(
          (n) =>
            n.name.toLowerCase().includes(lower) ||
            Object.values(n.properties).some(
              (v) => typeof v === "string" && v.toLowerCase().includes(lower),
            ),
        );
        return paginate(matchingNodes, allEdges, 0, limit, offset);
      }

      if (data.startNodeId) {
        const visited = new Set<string>();
        const visitedEdges = new Set<string>();
        const resultNodes: GraphNode[] = [];
        const resultEdges: GraphEdge[] = [];
        const queue: Array<{ nodeId: string; depth: number }> = [
          { nodeId: data.startNodeId, depth: 0 },
        ];

        while (queue.length > 0) {
          const { nodeId, depth } = queue.shift()!;
          if (visited.has(nodeId) || depth > maxDepth) continue;
          visited.add(nodeId);

          const node = allNodes.find((n) => n.id === nodeId);
          if (node) {
            if (!data.nodeType || node.type === data.nodeType) {
              resultNodes.push(node);
            }
          }

          const neighborEdges = allEdges.filter(
            (e) => e.sourceNodeId === nodeId || e.targetNodeId === nodeId,
          );
          for (const edge of neighborEdges) {
            if (!visitedEdges.has(edge.id)) {
              visitedEdges.add(edge.id);
              resultEdges.push(edge);
            }
            const nextId =
              edge.sourceNodeId === nodeId
                ? edge.targetNodeId
                : edge.sourceNodeId;
            if (!visited.has(nextId)) {
              queue.push({ nodeId: nextId, depth: depth + 1 });
            }
          }
        }

        return paginate(resultNodes, resultEdges, maxDepth, limit, offset);
      }

      const filteredNodes = data.nodeType
        ? allNodes.filter((node) => node.type === data.nodeType)
        : allNodes;
      return paginate(filteredNodes, allEdges, 0, limit, offset);
    },
  );

  // #814 v2: graph-stats reads the snapshot exclusively. The snapshot
  // is maintained inline by mem::graph-extract, so for any corpus built
  // on a post-#814 agentmemory the stats are always current without an
  // enumeration. Legacy corpora without a snapshot get an empty
  // envelope + a warning pointing at the snapshot-rebuild or graph-reset
  // endpoints — never a 500.
  sdk.registerFunction("mem::graph-stats", async () => {
    const snap = await readSnapshot(kv);
    if (snap) {
      return {
        ...snap.stats,
        fromSnapshot: true,
        updatedAt: snap.updatedAt,
        ...(snap.dirty
          ? {
              warning:
                "Snapshot is marked dirty (write was in-flight when read). " +
                "Counts are eventually consistent.",
            }
          : {}),
      };
    }
    return {
      totalNodes: 0,
      totalEdges: 0,
      nodesByType: {},
      edgesByType: {},
      fromSnapshot: false,
      warning:
        "No graph snapshot available. Run POST /agentmemory/graph/snapshot-rebuild " +
        "(safe up to ~25K nodes) or POST /agentmemory/graph/reset to wipe " +
        "and let future extracts repopulate.",
    };
  });

  // graph-schema: the rejected scope is bounded by REJECTED_STORE_CAP, so a full
  // kv.list here is safe (unlike graphNodes/graphEdges). byReason/byKind describe the
  // whole store; `total` describes the filtered slice, so the viewer can show both
  // "what got rejected overall" and "how many match the current filter".
  sdk.registerFunction(
    "mem::graph-rejected",
    async (data?: {
      limit?: number;
      offset?: number;
      kind?: "node" | "edge";
      reason?: string;
    }) => {
      const requested = Number(data?.limit);
      const limit = Number.isFinite(requested)
        ? Math.max(1, Math.min(1000, Math.floor(requested)))
        : 100;
      const rawOffset = Number(data?.offset);
      const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;

      let all: RejectedAssertion[] = [];
      try {
        all = (await kv.list<RejectedAssertion>(KV.graphRejected)) ?? [];
      } catch (err) {
        // Missing scope on a corpus that never rejected anything reads as empty,
        // not as a failure — the viewer tab must still render.
        logger.warn("Rejected assertion list failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        all = [];
      }

      const byReason: Record<string, number> = {};
      const byKind = { node: 0, edge: 0 };
      for (const r of all) {
        byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
        if (r.kind === "node") byKind.node++;
        else if (r.kind === "edge") byKind.edge++;
      }

      const filtered = all
        .filter((r) => (data?.kind ? r.kind === data.kind : true))
        .filter((r) => (data?.reason ? r.reason === data.reason : true))
        .sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));

      return {
        rejected: filtered.slice(offset, offset + limit),
        total: filtered.length,
        offset,
        limit,
        cap: REJECTED_STORE_CAP,
        byReason,
        byKind,
      };
    },
  );

  // #814 v2: explicit rebuild backfills the snapshot AND the name /
  // edge-key / degree indexes from existing graphNodes/graphEdges
  // scopes. This is the path operators run once after upgrading to a
  // post-#814 build to bring legacy corpora online. It enumerates via
  // kv.list — the same pair that breaks at 75K+ — so we refuse to
  // run on corpora large enough that the response payload would
  // block the worker heartbeat. Above the ceiling the only safe path
  // is mem::graph-reset followed by incremental re-extraction.
  sdk.registerFunction(
    "mem::graph-snapshot-rebuild",
    async (data?: { force?: boolean }) => {
      const started = Date.now();
      // #825: pre-flight refusal for legacy corpora. The old guard
      // checked node count AFTER kv.list, but the heartbeat dies at
      // ~0.35s on a 75K-node response — long before the wall-clock
      // budget can fire. We can't safely enumerate to discover size.
      //
      // Heuristic: if no snapshot exists, the corpus is either empty
      // or legacy. The empty case has nothing to rebuild; the legacy
      // case will crash. Refuse both unless `force: true` is passed
      // (operator opt-in to attempt rebuild on a corpus they know is
      // small enough — typically under 10K nodes on the default iii
      // state adapter).
      // Strict boolean check on force — accept only literal `true`,
      // never truthy strings/numbers, so a hand-crafted JSON payload
      // can't accidentally bypass the legacy-corpus safeguard.
      const forceRebuild = data?.force === true;
      let existingSnapshot: GraphSnapshot | null = null;
      try {
        existingSnapshot = await readSnapshot(kv);
        if (!existingSnapshot && !forceRebuild) {
          logger.warn("Graph snapshot rebuild refused: no prior snapshot", {
            hint: "legacy corpus or empty store",
          });
          return {
            success: false,
            legacyCorpus: true,
            error:
              "No prior snapshot found. Rebuild would call kv.list on " +
              "KV.graphNodes/Edges, which heartbeat-crashes the worker " +
              "on corpora past the iii state response budget (~25K nodes). " +
              "Either (a) call POST /agentmemory/graph/reset to drop into " +
              "incremental-only mode and rebuild from new extracts, or " +
              "(b) re-send with `force: true` if you're certain the " +
              "corpus is small.",
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Graph snapshot pre-flight read failed", { error: msg });
        // Fall through; the user passed force=true or the snapshot
        // read itself failed (separate problem).
      }

      try {
        const [nodes, edges] = await withTimeout(
          Promise.all([
            kv.list<GraphNode>(KV.graphNodes),
            kv.list<GraphEdge>(KV.graphEdges),
          ]),
          LIVE_ENUMERATION_BUDGET_MS,
          "graph-snapshot-rebuild enumeration",
        );

      if (nodes.length > REBUILD_SAFE_NODE_CEILING) {
        logger.warn("Graph snapshot rebuild aborted: corpus too large", {
          totalNodes: nodes.length,
          ceiling: REBUILD_SAFE_NODE_CEILING,
        });
        return {
          success: false,
          tooLarge: true,
          totalNodes: nodes.length,
          ceiling: REBUILD_SAFE_NODE_CEILING,
          error:
            `Corpus has ${nodes.length} graph nodes; safe-rebuild ceiling ` +
            `is ${REBUILD_SAFE_NODE_CEILING}. Run POST /agentmemory/graph/reset ` +
            `to wipe and let future extracts rebuild incrementally.`,
        };
      }

      // Backfill the targeted-lookup indexes so post-rebuild
      // graph-extract calls hit the O(1) path instead of falling
      // through to the (already-removed) full-scope scan. Batch
      // writes via Promise.all to avoid N sequential round-trips —
      // BATCH_SIZE bounds in-flight writes so we don't open thousands
      // of concurrent state channels on huge corpora.
      const liveNodes = nodes.filter(
        (node) =>
          !node.stale &&
          belongsToCurrentGeneration(node, existingSnapshot),
      );
      const liveNodeIds = new Set(liveNodes.map((node) => node.id));
      const liveEdges = edges.filter(
        (edge) =>
          !edge.stale &&
          belongsToCurrentGeneration(edge, existingSnapshot) &&
          liveNodeIds.has(edge.sourceNodeId) &&
          liveNodeIds.has(edge.targetNodeId),
      );
      const degree = new Map<string, number>();
      for (const e of liveEdges) {
        degree.set(e.sourceNodeId, (degree.get(e.sourceNodeId) ?? 0) + 1);
        degree.set(e.targetNodeId, (degree.get(e.targetNodeId) ?? 0) + 1);
      }
      const BATCH_SIZE = 100;
      for (let i = 0; i < liveNodes.length; i += BATCH_SIZE) {
        const batch = liveNodes.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.flatMap((n) => [
            kv.set(
              KV.graphNameIndex,
              nameIndexKey(n.type, n.name, n),
              n.id,
            ),
            kv.set(KV.graphNodeDegree, n.id, degree.get(n.id) ?? 0),
          ]),
        );
      }
      for (let i = 0; i < liveEdges.length; i += BATCH_SIZE) {
        const batch = liveEdges.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.map((e) =>
            kv.set(
              KV.graphEdgeKey,
              edgeIndexKey(e.sourceNodeId, e.targetNodeId, e.type),
              e.id,
            ),
          ),
        );
      }

      const snap = buildSnapshotFromArrays(nodes, edges, existingSnapshot);
      await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, snap);
      const tookMs = Date.now() - started;
      logger.info("Graph snapshot rebuilt", {
        totalNodes: snap.stats.totalNodes,
        totalEdges: snap.stats.totalEdges,
        topNodes: snap.topNodes.length,
        topEdges: snap.topEdges.length,
        tookMs,
      });
      return {
        success: true,
        ...snap.stats,
        topNodes: snap.topNodes.length,
        topEdges: snap.topEdges.length,
        updatedAt: snap.updatedAt,
        tookMs,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Graph snapshot rebuild failed", { error: msg });
      return { success: false, error: msg };
    }
  });

  // #814 v2 + #825: clean-restart escape hatch for corpora of any
  // size, including the legacy 75K+ case that crashes kv.list.
  //
  // Previous reset walked kv.list<GraphNode/Edge>(...) which is the
  // exact primitive that heartbeat-crashes the worker on the corpus
  // this reset was meant to recover (Allan's repro, 0.35s death).
  //
  // The new design is enumeration-free: write an empty snapshot and
  // return. The hot path (mem::graph-query empty-body, mem::graph-stats)
  // reads ONLY the snapshot post-#816, so a fresh empty snapshot
  // makes the graph behave as if it were empty for every read.
  //
  // Future extracts repopulate the snapshot + side-indexes
  // incrementally (graph-extract is O(1) per node post-#816 — it does
  // not consult the legacy rows).
  //
  // Trade-off: legacy rows in KV.graphNodes / KV.graphEdges remain on
  // disk as unreferenced orphans. They consume disk but are never
  // read by any post-#816 code path. Cleanup is deferred to a future
  // chunked-vacuum job; #816's broken vacuum-via-list strategy is
  // what we are leaving behind here.
  sdk.registerFunction("mem::graph-reset", async () => {
    const started = Date.now();
    // Stamp resetAt=now on the empty snapshot. Future
    // mem::graph-extract calls compare each name-index lookup's
    // existing node `createdAt` against this timestamp; anything
    // older counts as an orphan and is dropped from the merge path,
    // forcing extract to write a fresh row instead of reconnecting
    // to a pre-reset entry.
    const resetSnapshot: GraphSnapshot = {
      ...emptySnapshot(),
      graphGeneration: generateId("ggen"),
      resetAt: new Date().toISOString(),
    };
    await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, resetSnapshot);
    const counts: Record<string, number> = {
      [KV.graphSnapshot]: 1,
    };
    const tookMs = Date.now() - started;
    logger.info("Graph state reset", { counts, tookMs });
    return { success: true, cleared: counts, tookMs };
  });
  return core;
}
