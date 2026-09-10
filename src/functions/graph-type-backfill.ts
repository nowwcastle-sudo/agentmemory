import type { ISdk } from "../iii-compat.js";
import type { StateKV } from "../state/kv.js";
import { KV, generateId } from "../state/schema.js";
import type {
  CompressedObservation,
  GraphEdge,
  GraphNode,
  MemoryProvider,
} from "../types.js";
import { EDGE_TYPES, validateGraphDelta } from "./graph-schema.js";
import { parseAttrs, persistGraphDelta } from "./graph.js";
import { logger } from "../logger.js";

// Turns well-evidenced related_to edges into typed relations.
//
// On the live store 2026-09-10, 73% of live edges were related_to -- the
// heuristic extractor's concept x file co-occurrence at weight 0.4. Retrieval
// scores a path by weight alone, so each of those is worth a third of a typed
// edge, and the ontology view shows no relation at all. Most have one backing
// observation and are not worth a model call; 12,410 have ten or more. Those
// carry enough evidence for the model to name the relation, from the same
// closed vocabulary the extractor uses, or to say "none".
//
// Each call handles one batch so a resumable driver can pace it against a
// slow provider (the free tier answers in ~20 s). The driver passes back the
// edge ids it has already attempted; the function never re-asks about them.

export interface TypingCandidate {
  edge: GraphEdge;
  source: GraphNode;
  target: GraphNode;
}

export interface TypingSelection {
  minBacking?: number;
  maxPairs?: number;
}

const isLive = (n: GraphNode | undefined): n is GraphNode =>
  !!n && !n.stale && !n.mergedInto;

// The heuristic extractor makes a file node out of anything in an
// observation's `files` list, and some of those are words ("memory", "user").
// A real file has a path separator or an extension; typing a relation to a
// word is never right, so those pairs are not candidates.
const looksLikeFile = (name: string): boolean => /[\\/]/.test(name) || /\.[A-Za-z0-9]+$/.test(name);

/**
 * Live concept-file related_to edges with at least `minBacking` observations
 * behind them, most evidence first. Superseded edges and edges touching a
 * stale node are never candidates.
 */
export function selectTypingCandidates(
  nodes: GraphNode[],
  edges: GraphEdge[],
  { minBacking = 10, maxPairs = 20 }: TypingSelection = {},
): TypingCandidate[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: TypingCandidate[] = [];
  for (const edge of edges) {
    if (edge.type !== "related_to" || edge.stale || edge.supersededBy) continue;
    if ((edge.sourceObservationIds ?? []).length < minBacking) continue;
    const source = byId.get(edge.sourceNodeId);
    const target = byId.get(edge.targetNodeId);
    if (!isLive(source) || !isLive(target)) continue;
    if (source.type !== "concept" || target.type !== "file") continue;
    if (!looksLikeFile(target.name)) continue;
    out.push({ edge, source, target });
  }
  out.sort(
    (a, b) =>
      b.edge.sourceObservationIds.length - a.edge.sourceObservationIds.length ||
      a.edge.id.localeCompare(b.edge.id),
  );
  return out.slice(0, maxPairs);
}

const TYPING_TYPES = [...EDGE_TYPES].filter((t) => t !== "related_to");

export const GRAPH_TYPING_SYSTEM = `You classify the relationship between a concept and a file in a codebase, given evidence from the coding sessions where they appeared together.

For each numbered pair, output exactly one line:
<pair i="N" type="${TYPING_TYPES.join("|")}|none" weight="0.1-1.0"/>

What the types mean (concept -> file):
- implements: the file is where the concept is realised in code
- defines: the file declares the concept (schema, type, config, constant)
- documents: the file explains, describes or records the concept (docs, notes, references)
- tests: the file tests the concept
- validates: the file checks or verifies the concept
- uses: the concept's code or process runs, reads or relies on the file
- depends_on: the concept cannot work without the file
- modifies: work on the concept changed this file
- imports: the concept's module imports the file
- located_in: the concept lives at that path
- contains / part_of: structural containment
- causes, caused_by, fixes, blocked_by: ONLY for errors and failures. A component that writes a log, a PID file or a report does not "cause" it -- that is "uses" or none.
- works_at, prefers, rejected, avoids, optimizes_for, succeeded_by: almost never right for a concept -> file pair; prefer none.

Rules:
- Only these types are valid; anything else is discarded.
- Choose "none" when the evidence does not support a specific relationship, or when the file is not a real source, config, doc or data file. "none" is a good answer.
- Weight is how strongly the evidence supports the relationship; below 0.6 means you are guessing -- answer none instead.
- Wrap the lines in <pairs></pairs> and output nothing else.`;

export function buildTypingPrompt(
  candidates: TypingCandidate[],
  evidence: Map<string, string[]>,
): string {
  const items = candidates.map((c, i) => {
    const titles = evidence.get(c.edge.id) ?? [];
    const lines = titles.length
      ? titles.map((t) => `  - ${t}`).join("\n")
      : "  - (no titles available)";
    return `[${i + 1}] ${c.source.type} "${c.source.name}" -> ${c.target.type} "${c.target.name}"\n  seen together in ${c.edge.sourceObservationIds.length} observations, for example:\n${lines}`;
  });
  return `Classify these pairs. Answer "none" where unsure.\n\n${items.join("\n\n")}`;
}

/**
 * Which observation titles to show for a pair: the ones that mention the
 * file's basename or the concept first, generic session titles last. A
 * narrative that mentions the file is quoted alongside its title. The first
 * trial showed the model three generic "Discord session" titles for a
 * gateway/PID-file pair and it guessed `causes`.
 */
export function pickEvidence(
  observations: Array<{ title: string; narrative?: string }>,
  conceptName: string,
  fileName: string,
  limit = EVIDENCE_TITLES_PER_PAIR,
): string[] {
  const base = fileName.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const concept = conceptName.toLowerCase();
  const scored = observations.map((o, i) => {
    const title = o.title ?? "";
    const narrative = o.narrative ?? "";
    const text = `${title} ${narrative}`.toLowerCase();
    const mentionsFile = base.length > 0 && text.includes(base);
    const mentionsConcept = concept.length > 0 && text.includes(concept);
    const score = (mentionsFile ? 2 : 0) + (mentionsConcept ? 1 : 0);
    const line =
      mentionsFile && narrative && !title.toLowerCase().includes(base)
        ? `${title} -- ${narrative.slice(0, 160)}`
        : title;
    return { score, i, line };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, limit).map((s) => s.line);
}

export interface TypingParse {
  typed: Array<{ candidate: TypingCandidate; type: GraphEdge["type"]; weight: number }>;
  none: string[];
  rejected: Array<{ edgeId: string; reason: string }>;
}

/**
 * Reads the model's <pair/> lines back against the candidates it was shown.
 * The schema's own validator decides target-type rules, so this cannot accept
 * something the extractor would have refused.
 */
export function parseTypingResponse(
  xml: string,
  candidates: TypingCandidate[],
  { minWeight = 0.6 }: { minWeight?: number } = {},
): TypingParse {
  const out: TypingParse = { typed: [], none: [], rejected: [] };
  const pairRegex = /<pair\b([^>]*?)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = pairRegex.exec(xml)) !== null) {
    const attrs = parseAttrs(m[1]);
    const index = Number.parseInt(attrs["i"] ?? "", 10);
    const candidate = Number.isFinite(index) ? candidates[index - 1] : undefined;
    if (!candidate) continue;
    const type = (attrs["type"] ?? "").trim();
    if (type === "none") {
      out.none.push(candidate.edge.id);
      continue;
    }
    if (!EDGE_TYPES.has(type as GraphEdge["type"]) || type === "related_to") {
      out.rejected.push({ edgeId: candidate.edge.id, reason: "unknown_edge_type" });
      continue;
    }
    const parsedWeight = Number.parseFloat(attrs["weight"] ?? "");
    const weight = Math.max(0, Math.min(1, Number.isFinite(parsedWeight) ? parsedWeight : 0.5));
    // The model's confidence is the only calibration we have. A guess written
    // at weight 0.4 would still outrank nothing, but it would be wrong data in
    // a graph retrieval walks by weight; keep the related_to instead.
    if (weight < minWeight) {
      out.none.push(candidate.edge.id);
      continue;
    }
    const probe: GraphEdge = {
      ...candidate.edge,
      id: `probe:${candidate.edge.id}`,
      type: type as GraphEdge["type"],
      weight,
    };
    const { rejected } = validateGraphDelta(
      { nodes: [], edges: [probe] },
      {
        mode: "extract",
        knownNodes: new Map([
          [candidate.source.id, candidate.source.type],
          [candidate.target.id, candidate.target.type],
        ]),
      },
    );
    if (rejected.length > 0) {
      out.rejected.push({ edgeId: candidate.edge.id, reason: rejected[0].reason });
      continue;
    }
    out.typed.push({ candidate, type: probe.type, weight });
  }
  return out;
}

const EVIDENCE_TITLES_PER_PAIR = 3;
// How many backing observations to read before choosing the best few. Pairs
// with a hundred backing observations are the interesting ones, and the
// first three refs are whatever happened to be extracted first.
const EVIDENCE_CANDIDATES_PER_PAIR = 12;

async function evidenceFor(
  kv: StateKV,
  candidates: TypingCandidate[],
): Promise<Map<string, string[]>> {
  const evidence = new Map<string, string[]>();
  for (const c of candidates) {
    const observations: Array<{ title: string; narrative?: string }> = [];
    for (const ref of c.edge.sourceRefs ?? []) {
      if (observations.length >= EVIDENCE_CANDIDATES_PER_PAIR) break;
      if (ref.sourceKind !== "observation" || !ref.sessionId) continue;
      const observation = await kv
        .get<CompressedObservation>(KV.observations(ref.sessionId), ref.sourceId)
        .catch(() => null);
      if (observation?.title) observations.push({ title: observation.title, narrative: observation.narrative });
    }
    evidence.set(c.edge.id, pickEvidence(observations, c.source.name, c.target.name));
  }
  return evidence;
}

export interface TypeBackfillRequest {
  minBacking?: number;
  batchSize?: number;
  maxBatches?: number;
  skipEdgeIds?: string[];
  dryRun?: boolean;
}

export interface TypeBackfillResult {
  success: boolean;
  candidates: number;
  asked: number;
  typed: number;
  none: number;
  rejected: number;
  attemptedEdgeIds: string[];
  dryRun: boolean;
  error?: string;
}

export function registerGraphTypeBackfill(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction(
    "mem::graph-type-backfill",
    async (data: TypeBackfillRequest = {}): Promise<TypeBackfillResult> => {
      const minBacking = data.minBacking ?? 10;
      const batchSize = Math.max(1, data.batchSize ?? 20);
      const maxBatches = Math.max(1, data.maxBatches ?? 1);
      const skip = new Set(data.skipEdgeIds ?? []);
      const dryRun = data.dryRun === true;

      // A maintenance pass, so the whole-scope read is deliberate here -- the
      // same read the retrieval index makes, and the reason it is not run
      // from the request path.
      const nodes = await kv.list<GraphNode>(KV.graphNodes);
      const edges = await kv.list<GraphEdge>(KV.graphEdges);
      const candidates = selectTypingCandidates(nodes, edges, {
        minBacking,
        maxPairs: batchSize * maxBatches + skip.size,
      })
        .filter((c) => !skip.has(c.edge.id))
        .slice(0, batchSize * maxBatches);

      const result: TypeBackfillResult = {
        success: true,
        candidates: candidates.length,
        asked: 0,
        typed: 0,
        none: 0,
        rejected: 0,
        attemptedEdgeIds: [],
        dryRun,
      };
      if (dryRun || candidates.length === 0) return result;

      for (let start = 0; start < candidates.length; start += batchSize) {
        const batch = candidates.slice(start, start + batchSize);
        const evidence = await evidenceFor(kv, batch);
        const prompt = buildTypingPrompt(batch, evidence);
        let response: string;
        try {
          response = await provider.compress(GRAPH_TYPING_SYSTEM, prompt);
        } catch (err) {
          result.success = false;
          result.error = err instanceof Error ? err.message : String(err);
          logger.error("graph-type-backfill provider call failed", { error: result.error });
          return result;
        }
        result.asked += batch.length;
        result.attemptedEdgeIds.push(...batch.map((c) => c.edge.id));

        const parsed = parseTypingResponse(response, batch);
        result.none += parsed.none.length;
        result.rejected += parsed.rejected.length;

        const now = new Date().toISOString();
        for (const t of parsed.typed) {
          const old = t.candidate.edge;
          const typed: GraphEdge = {
            id: generateId("ge"),
            type: t.type,
            sourceNodeId: old.sourceNodeId,
            targetNodeId: old.targetNodeId,
            weight: t.weight,
            sourceObservationIds: [...old.sourceObservationIds],
            ...(old.sourceRefs ? { sourceRefs: old.sourceRefs } : {}),
            ...(old.projectId ? { projectId: old.projectId } : {}),
            ...(old.actorAgentId ? { actorAgentId: old.actorAgentId } : {}),
            ...(old.visibility ? { visibility: old.visibility } : {}),
            createdAt: now,
            context: { reasoning: `typed from related_to ${old.id} by graph-type-backfill` },
          };
          // Through the persist seam so the edge-key index, degree bookkeeping
          // and snapshot stay right. The endpoints ride along and merge into
          // their existing rows by name.
          await persistGraphDelta(
            kv,
            [t.candidate.source, t.candidate.target],
            [typed],
            typed.sourceObservationIds,
          );
          // persist merges into an existing edge of the same key if there is
          // one; point the supersession at whichever id ended up in the store.
          const finalId =
            (await kv.get<string>(
              KV.graphEdgeKey,
              `${typed.sourceNodeId}|${typed.targetNodeId}|${typed.type}`,
            )) ?? typed.id;
          // If persist merged into a row that had been reverted earlier (stale),
          // that row is the one retrieval will look at -- bring it back to life
          // with this decision's weight. Otherwise the pair ends up with no live
          // edge at all, which is what happened to 34 pairs on 2026-09-10.
          if (finalId !== typed.id) {
            const merged = await kv.get<GraphEdge>(KV.graphEdges, finalId);
            if (merged && (merged.stale || merged.isLatest === false)) {
              const { tvalidEnd: _end, supersededBy: _by, ...rest } = merged;
              await kv.set(KV.graphEdges, finalId, {
                ...rest,
                weight: t.weight,
                stale: false,
                isLatest: true,
                context: typed.context,
              });
            }
          }
          // Same shape the temporal graph uses when a newer edge replaces an
          // older one, plus `stale` so retrieval and the snapshot stop walking
          // the related_to.
          const superseded: GraphEdge = {
            ...old,
            isLatest: false,
            tvalidEnd: old.tvalidEnd || now,
            supersededBy: finalId,
            stale: true,
          };
          await kv.set(KV.graphEdges, old.id, superseded);
          await kv.set(KV.graphEdgeHistory, old.id, superseded);
          result.typed += 1;
        }
      }
      logger.info("graph-type-backfill batch complete", {
        candidates: result.candidates,
        asked: result.asked,
        typed: result.typed,
        none: result.none,
        rejected: result.rejected,
      });
      return result;
    },
  );
}
