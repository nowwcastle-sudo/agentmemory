import type {
  GraphNode,
  GraphEdge,
  GraphSourceLocator,
  RetrievalScope,
} from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { onKvWrite, type KvWriteEvent } from "../state/kv-write-hooks.js";
import {
  locatorRetrievalMetadata,
  matchesRetrievalScope,
} from "../state/retrieval-scope.js";

export interface GraphRetrievalResult {
  obsId: string;
  sessionId: string;
  source: GraphSourceLocator;
  score: number;
  graphContext: string;
  pathLength: number;
}

function nodeSourceRefs(node: GraphNode): GraphSourceLocator[] {
  if (node.sourceRefs && node.sourceRefs.length > 0) return node.sourceRefs;
  return node.sourceObservationIds.map((sourceId) => ({
    sourceKind: sourceId.startsWith("mem_") ? "memory" : "observation",
    sourceId,
    ...(node.projectId ? { projectId: node.projectId } : {}),
    ...(node.actorAgentId ? { actorAgentId: node.actorAgentId } : {}),
    ...(node.visibility ? { visibility: node.visibility } : {}),
  }));
}

function nodeMatchesScope(node: GraphNode, scope?: RetrievalScope): boolean {
  if (!scope) return true;
  const refs = nodeSourceRefs(node);
  if (refs.length > 0) {
    return refs.some((ref) =>
      matchesRetrievalScope(locatorRetrievalMetadata(ref), scope),
    );
  }
  return matchesRetrievalScope(node, scope);
}

function edgeMatchesScope(edge: GraphEdge, scope?: RetrievalScope): boolean {
  if (!scope) return true;
  if (edge.sourceRefs && edge.sourceRefs.length > 0) {
    return edge.sourceRefs.some((ref) =>
      matchesRetrievalScope(locatorRetrievalMetadata(ref), scope),
    );
  }
  return matchesRetrievalScope(edge, scope);
}

/**
 * How much a path is discounted for the nodes it travels through.
 *
 * Every neighbour reached through the same node scores identically under
 * `avgWeight * (1 / pathLength)`, so a node the whole corpus touches hands the
 * ranking an arbitrary slice of its own fan-out. That is what the real-corpus
 * A/B measured: the one observation about a function lost its place to a grep
 * of the same file, both two hops behind a generic hub.
 *
 * A hop through a degree-2 node is evidence; a hop through a degree-400 node is
 * barely more than "these both exist in this corpus". Discounting by the log of
 * the degree says so without eliminating the hub route -- graph IDF. Endpoints
 * are exempt: the start node is what the query matched, and the destination is
 * the answer being scored, not a route through anything.
 */
function hubDiscount(
  path: Array<{ node: GraphNode; edge?: GraphEdge }>,
  adjacency: Map<string, Array<{ neighborId: string; edge: GraphEdge }>>,
): number {
  let discount = 1;
  for (const step of path.slice(1, -1)) {
    const degree = Math.max(1, adjacency.get(step.node.id)?.length ?? 1);
    discount /= 1 + Math.log(degree);
  }
  return discount;
}

function buildGraphContext(
  path: Array<{ node: GraphNode; edge?: GraphEdge }>,
): string {
  const parts: string[] = [];
  for (const step of path) {
    const props = Object.entries(step.node.properties)
      .slice(0, 3)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    let line = `[${step.node.type}] ${step.node.name}`;
    if (props) line += ` (${props})`;
    if (step.edge) {
      line += ` --${step.edge.type}-->`;
      if (step.edge.context?.reasoning) {
        line += ` [${step.edge.context.reasoning}]`;
      }
      if (step.edge.tvalid) {
        line += ` @${step.edge.tvalid}`;
      }
    }
    parts.push(line);
  }
  return parts.join(" ");
}

type TraversalIndex = {
  nodeIndex: Map<string, GraphNode>;
  adjacency: Map<string, Array<{ neighborId: string; edge: GraphEdge }>>;
};

/**
 * The live graph held in process.
 *
 * Every search used to list mem:graph:nodes (80 MB) and mem:graph:edges
 * (64 MB) through the engine, which retains ~2.5x of what it carries. The
 * scopes are listed once per process instead; StateKV reports each later
 * set/update/delete through kv-write-hooks and the row is applied here, so
 * the copy stays exact for every writer in this process. Writes that land
 * while the first load is in flight are buffered and replayed over it.
 *
 * A safety-net TTL exists for writes from outside the process (maintenance
 * tools talking to the engine directly). It is off unless
 * AGENTMEMORY_GRAPH_CACHE_TTL_MS is set: a periodic full reload is the exact
 * engine growth this cache removes, and those tools are followed by a worker
 * restart anyway.
 */
interface LiveGraphCache {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  loadedAt: number;
}

function graphCacheTtlFromEnv(): number {
  const raw = process.env["AGENTMEMORY_GRAPH_CACHE_TTL_MS"];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.POSITIVE_INFINITY;
}

const hasId = (value: unknown): value is { id: string } =>
  !!value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string";

export class GraphRetrieval {
  private cache: LiveGraphCache | null = null;
  private loading: Promise<LiveGraphCache> | null = null;
  private pendingWrites: KvWriteEvent[] | null = null;
  private subscribed = false;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private kv: StateKV,
    options: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.ttlMs = options.ttlMs ?? graphCacheTtlFromEnv();
    this.now = options.now ?? Date.now;
  }

  /** Drop the held graph; the next search lists both scopes again. */
  invalidate(): void {
    this.cache = null;
  }

  private async liveGraph(): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const cache = await this.ensureCache();
    return {
      nodes: Array.from(cache.nodes.values()).filter((node) => !node.stale),
      edges: Array.from(cache.edges.values()).filter((edge) => !edge.stale),
    };
  }

  private async ensureCache(): Promise<LiveGraphCache> {
    if (this.cache && this.now() - this.cache.loadedAt <= this.ttlMs) return this.cache;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      if (!this.subscribed) {
        onKvWrite(this.kv, (event) => this.applyWrite(event));
        this.subscribed = true;
      }
      this.pendingWrites = [];
      // Sequential on purpose: two 60-80 MB messages in flight at once is a
      // larger peak in the engine than one after the other.
      const nodes = await this.kv.list<GraphNode>(KV.graphNodes);
      const edges = await this.kv.list<GraphEdge>(KV.graphEdges);
      const cache: LiveGraphCache = { nodes: new Map(), edges: new Map(), loadedAt: this.now() };
      for (const node of nodes) if (hasId(node)) cache.nodes.set(node.id, node);
      for (const edge of edges) if (hasId(edge)) cache.edges.set(edge.id, edge);
      this.cache = cache;
      const replay = this.pendingWrites;
      this.pendingWrites = null;
      for (const event of replay) this.applyWrite(event);
      return cache;
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private applyWrite(event: KvWriteEvent): void {
    if (event.scope !== KV.graphNodes && event.scope !== KV.graphEdges) return;
    if (this.pendingWrites) {
      this.pendingWrites.push(event);
      return;
    }
    if (!this.cache) return;
    const map: Map<string, unknown> =
      event.scope === KV.graphNodes ? this.cache.nodes : this.cache.edges;
    if (event.op === "delete") {
      map.delete(event.key);
      return;
    }
    if (hasId(event.value)) {
      map.set(event.key, event.value);
      return;
    }
    // A partial update without the merged row: the row is unknown now, so
    // the next search reloads rather than guesses.
    this.cache = null;
  }

  async searchByEntities(
    entityNames: string[],
    maxDepth = 2,
    maxResults = 20,
    scope?: RetrievalScope,
  ): Promise<GraphRetrievalResult[]> {
    const live = await this.liveGraph();
    const allNodes = live.nodes.filter((node) => nodeMatchesScope(node, scope));
    const nodeIds = new Set(allNodes.map((node) => node.id));
    const allEdges = live.edges.filter(
      (edge) =>
        edgeMatchesScope(edge, scope) &&
        nodeIds.has(edge.sourceNodeId) &&
        nodeIds.has(edge.targetNodeId),
    );

    const traversalIndex = this.buildTraversalIndex(allNodes, allEdges);

    const matchingNodes = allNodes.filter((n) => {
      const nameLower = n.name.toLowerCase();
      return entityNames.some(
        (e) =>
          nameLower.includes(e.toLowerCase()) ||
          e.toLowerCase().includes(nameLower),
      );
    });

    if (matchingNodes.length === 0) return [];

    const results: GraphRetrievalResult[] = [];
    const visitedSources = new Set<string>();

    for (const startNode of matchingNodes) {
      const paths = this.dijkstraTraversal(
        startNode,
        traversalIndex,
        maxDepth,
      );

      for (const path of paths) {
        const lastNode = path[path.length - 1].node;
        for (const source of nodeSourceRefs(lastNode)) {
          if (!matchesRetrievalScope(locatorRetrievalMetadata(source), scope)) {
            continue;
          }
          const sourceKey = `${source.sourceKind}:${source.sourceId}:${source.sessionId ?? ""}`;
          if (visitedSources.has(sourceKey)) continue;
          visitedSources.add(sourceKey);

          const pathLength = path.length;
          const edgeWeights = path
            .filter((s) => s.edge)
            .map((s) => s.edge!.weight);
          const avgWeight =
            edgeWeights.length > 0
              ? edgeWeights.reduce((a, b) => a + b, 0) / edgeWeights.length
              : 0.5;
          const score =
            avgWeight * (1 / pathLength) * hubDiscount(path, traversalIndex.adjacency);

          results.push({
            obsId: source.sourceId,
            sessionId: source.sessionId ?? "",
            source,
            score,
            graphContext: buildGraphContext(path),
            pathLength,
          });
        }
      }

      for (const source of nodeSourceRefs(startNode)) {
        if (!matchesRetrievalScope(locatorRetrievalMetadata(source), scope)) {
          continue;
        }
        const sourceKey = `${source.sourceKind}:${source.sourceId}:${source.sessionId ?? ""}`;
        if (visitedSources.has(sourceKey)) continue;
        visitedSources.add(sourceKey);
        results.push({
          obsId: source.sourceId,
          sessionId: source.sessionId ?? "",
          source,
          score: 1.0,
          graphContext: `[${startNode.type}] ${startNode.name}`,
          pathLength: 0,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  async expandFromChunks(
    obsIds: string[],
    maxDepth = 1,
    maxResults = 10,
    scope?: RetrievalScope,
  ): Promise<GraphRetrievalResult[]> {
    const live = await this.liveGraph();
    const allNodes = live.nodes.filter((node) => nodeMatchesScope(node, scope));
    const nodeIds = new Set(allNodes.map((node) => node.id));
    const allEdges = live.edges.filter(
      (edge) =>
        edgeMatchesScope(edge, scope) &&
        nodeIds.has(edge.sourceNodeId) &&
        nodeIds.has(edge.targetNodeId),
    );

    const traversalIndex = this.buildTraversalIndex(allNodes, allEdges);

    const linkedNodes = allNodes.filter((n) =>
      nodeSourceRefs(n).some((source) => obsIds.includes(source.sourceId)),
    );

    const results: GraphRetrievalResult[] = [];
    const visitedSources = new Set<string>(obsIds);

    for (const node of linkedNodes) {
      const paths = this.dijkstraTraversal(node, traversalIndex, maxDepth);
      for (const path of paths) {
        const lastNode = path[path.length - 1].node;
        for (const source of nodeSourceRefs(lastNode)) {
          if (!matchesRetrievalScope(locatorRetrievalMetadata(source), scope)) {
            continue;
          }
          if (visitedSources.has(source.sourceId)) continue;
          visitedSources.add(source.sourceId);

          const pathLength = path.length;
          const score =
            0.5 *
            (1 / (pathLength + 1)) *
            hubDiscount(path, traversalIndex.adjacency);

          results.push({
            obsId: source.sourceId,
            sessionId: source.sessionId ?? "",
            source,
            score,
            graphContext: buildGraphContext(path),
            pathLength,
          });
        }
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  async temporalQuery(
    entityName: string,
    asOf?: string,
    scope?: RetrievalScope,
  ): Promise<{
    entity: GraphNode | null;
    currentState: GraphEdge[];
    history: GraphEdge[];
  }> {
    const live = await this.liveGraph();
    const allNodes = live.nodes.filter((node) => nodeMatchesScope(node, scope));
    const nodeIds = new Set(allNodes.map((node) => node.id));
    const allEdges = live.edges.filter(
      (edge) =>
        edgeMatchesScope(edge, scope) &&
        nodeIds.has(edge.sourceNodeId) &&
        nodeIds.has(edge.targetNodeId),
    );

    const entity = allNodes.find(
      (n) => n.name.toLowerCase() === entityName.toLowerCase(),
    );
    if (!entity) return { entity: null, currentState: [], history: [] };

    const relatedEdges = allEdges.filter(
      (e) => e.sourceNodeId === entity.id || e.targetNodeId === entity.id,
    );

    if (!asOf) {
      const latestEdges = this.getLatestEdges(relatedEdges);
      const historicalEdges = relatedEdges.filter(
        (e) => !latestEdges.some((le) => le.id === e.id),
      );
      return { entity, currentState: latestEdges, history: historicalEdges };
    }

    const asOfDate = new Date(asOf).getTime();
    const validEdges = relatedEdges.filter((e) => {
      const commitDate = new Date(e.tcommit || e.createdAt).getTime();
      if (commitDate > asOfDate) return false;
      if (e.tvalid) {
        const validDate = new Date(e.tvalid).getTime();
        if (validDate > asOfDate) return false;
      }
      if (e.tvalidEnd) {
        const endDate = new Date(e.tvalidEnd).getTime();
        if (endDate < asOfDate) return false;
      }
      return true;
    });

    return {
      entity,
      currentState: this.getLatestEdges(validEdges),
      history: validEdges,
    };
  }

  private getLatestEdges(edges: GraphEdge[]): GraphEdge[] {
    const byKey = new Map<string, GraphEdge[]>();
    for (const e of edges) {
      const key = `${e.sourceNodeId}|${e.targetNodeId}|${e.type}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(e);
    }

    const latest: GraphEdge[] = [];
    for (const group of byKey.values()) {
      if (group.length === 0) continue;
      group.sort(
        (a, b) =>
          new Date(b.tcommit || b.createdAt).getTime() -
          new Date(a.tcommit || a.createdAt).getTime(),
      );
      const newest = group.find((e) => e.isLatest !== false) || group[0];
      latest.push(newest);
    }
    return latest;
  }

  // Weighted shortest-path traversal (#328). Replaces the prior BFS,
  // which fell back to edge-count order and ignored the 0.1-1.0 weight
  // attached to every graph edge. Dijkstra over `cost = 1/weight`
  // (cheaper edges = stronger relationships) returns the
  // highest-weighted path to each reachable node within maxDepth. Also
  // tightens the perf profile:
  //   - Adjacency built once in O(V+E) (previous BFS re-filtered
  //     allEdges per visited node, O(V·E) overall).
  //   - Min-heap dequeue is O(log V) per pop (previous queue.shift()
  //     was O(n) — the dominant cost on graphs above ~200 nodes per
  //     the contributor's benchmark in #328).
  /**
   * Node lookup + undirected adjacency for one traversal pass. Built once per
   * query from the already scope-filtered arrays and shared by every start
   * node. Rebuilding it inside dijkstraTraversal made one search cost
   * O(|matches| * (V+E)); on a 15.5k-node graph the worst case was ~93 s.
   */
  private buildTraversalIndex(
    allNodes: GraphNode[],
    allEdges: GraphEdge[],
  ): TraversalIndex {
    const nodeIndex = new Map<string, GraphNode>();
    for (const n of allNodes) nodeIndex.set(n.id, n);

    const adjacency = new Map<string, Array<{ neighborId: string; edge: GraphEdge }>>();
    for (const edge of allEdges) {
      const a = edge.sourceNodeId;
      const b = edge.targetNodeId;
      if (!adjacency.has(a)) adjacency.set(a, []);
      if (!adjacency.has(b)) adjacency.set(b, []);
      adjacency.get(a)!.push({ neighborId: b, edge });
      adjacency.get(b)!.push({ neighborId: a, edge });
    }
    return { nodeIndex, adjacency };
  }

  private dijkstraTraversal(
    startNode: GraphNode,
    index: TraversalIndex,
    maxDepth: number,
  ): Array<Array<{ node: GraphNode; edge?: GraphEdge }>> {
    const { nodeIndex, adjacency } = index;

    const dist = new Map<string, number>();
    const pathTo = new Map<string, Array<{ node: GraphNode; edge?: GraphEdge }>>();
    dist.set(startNode.id, 0);
    pathTo.set(startNode.id, [{ node: startNode }]);

    const heap = new MinHeap<{ nodeId: string; depth: number; cost: number }>(
      (a, b) => a.cost - b.cost,
    );
    heap.push({ nodeId: startNode.id, depth: 0, cost: 0 });

    while (heap.size() > 0) {
      const { nodeId, depth, cost } = heap.pop()!;
      // Skip stale heap entries (cost beaten by a later push).
      if (cost > (dist.get(nodeId) ?? Infinity)) continue;
      if (depth >= maxDepth) continue;

      const neighbors = adjacency.get(nodeId) ?? [];
      for (const { neighborId, edge } of neighbors) {
        const nextNode = nodeIndex.get(neighborId);
        if (!nextNode) continue;
        // Clamp weight to avoid division-by-zero on malformed edges;
        // 0.01 is below the documented 0.1 floor.
        const edgeCost = 1 / Math.max(edge.weight, 0.01);
        const newCost = cost + edgeCost;
        if (newCost < (dist.get(neighborId) ?? Infinity)) {
          dist.set(neighborId, newCost);
          pathTo.set(neighborId, [
            ...pathTo.get(nodeId)!,
            { node: nextNode, edge },
          ]);
          heap.push({ nodeId: neighborId, depth: depth + 1, cost: newCost });
        }
      }
    }

    // Drop the startNode's own entry before returning: callers
    // (searchByEntities, expandFromChunks) score start-node
    // observations via a dedicated fallback loop with score=1.0. If
    // we leave it in here, the start-path (length 1, no edges) goes
    // through the generic path-scoring loop first — pathLength=1 +
    // empty edgeWeights makes avgWeight fall to 0.5, the obs get
    // marked visited, and the score=1.0 fallback becomes dead code.
    pathTo.delete(startNode.id);
    return Array.from(pathTo.values());
  }
}

// Minimal binary min-heap. Pulled inline so graph-retrieval doesn't
// take a new dependency for the perf-critical inner loop of #328.
// Comparator returns negative when `a` should pop before `b`.
class MinHeap<T> {
  private heap: T[] = [];

  constructor(private compare: (a: T, b: T) => number) {}

  size(): number {
    return this.heap.length;
  }

  push(value: T): void {
    this.heap.push(value);
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): T | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(this.heap[i], this.heap[parent]) < 0) {
        [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]];
        i = parent;
      } else break;
    }
  }

  private sinkDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let smallest = i;
      if (left < n && this.compare(this.heap[left], this.heap[smallest]) < 0) {
        smallest = left;
      }
      if (right < n && this.compare(this.heap[right], this.heap[smallest]) < 0) {
        smallest = right;
      }
      if (smallest === i) break;
      [this.heap[i], this.heap[smallest]] = [this.heap[smallest], this.heap[i]];
      i = smallest;
    }
  }
}
