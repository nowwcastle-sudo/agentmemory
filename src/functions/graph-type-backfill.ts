import type { ISdk } from "../iii-compat.js";
import type { StateKV } from "../state/kv.js";
import { KV, generateId } from "../state/schema.js";
import type {
  CompressedObservation,
  GraphEdge,
  GraphNode,
  MemoryProvider,
  ObservationProjection,
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
// A path whose last segment has no extension is a directory (trials 3 and 4
// typed "pytest uses .../discord-cs-quiz-core" through the separator rule);
// extension-less files (Makefile, LICENSE) are lost with them, on purpose.
const looksLikeFile = (name: string): boolean => {
  const last = name.split(/[\\/]/).pop() ?? "";
  return /\.[A-Za-z0-9]+$/.test(last);
};

// Trial 3 (2026-09-10): 8 of 24 wrong answers had a concept node that was a
// shell command ("git status", "commit range", "PowerShell command
// execution"). A command is an action, not a domain concept, and the file
// was listed by it, not used by it. The names below are never asked about.
const COMMAND_WORDS = new Set([
  "git", "npm", "npx", "node", "pwsh", "powershell", "bash", "sh", "cd", "ls",
  "cat", "grep", "curl", "wsl", "docker", "pip", "py", "python", "python3",
  "tee", "sed", "awk", "echo", "rm", "mkdir", "mv", "cp", "chmod", "ssh",
  "tar", "find", "head", "tail", "wc", "sort", "uniq", "kill", "taskkill",
  "sudo", "apt", "brew", "make", "cargo", "dotnet", "yarn", "pnpm", "start",
  "stop", "restart",
]);
const TOOL_NAMES = new Set([
  "bash", "read", "edit", "write", "grep", "glob", "powershell", "monitor",
  "agent", "skill", "todowrite", "webfetch", "websearch", "task",
  "notebookedit", "multiedit", "ls", "prompt_submit", "post_tool_use",
  "pre_tool_use", "session_start", "session_end", "stop", "subagent_stop",
  "user_prompt_submit", "post_tool_failure",
]);
const ACTION_TAILS = /\b(command|commands|execution|invocation|range|output|status|log|logs|run|call)$/;
const ACTION_HEADS = /^(run|ran|running|execute|executed|executing|inspect|inspecting|inspected|update|updated|updating|check|checked|checking|read|reading)\b/;

export function isTypeableConcept(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 3) return false;
  const lower = trimmed.toLowerCase();
  if (TOOL_NAMES.has(lower)) return false;
  if (looksLikeFile(trimmed)) return false;
  const words = lower.split(/\s+/);
  if (words.length > 6) return false;
  if (words.length > 1 && COMMAND_WORDS.has(words[0])) return false;
  if (/\s-{1,2}[a-z]/.test(lower)) return false;
  if (ACTION_TAILS.test(lower)) return false;
  if (ACTION_HEADS.test(lower)) return false;
  return true;
}

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
    if (!isTypeableConcept(source.name)) continue;
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
// Words that carry no concept on their own when matching evidence.
const CONCEPT_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "file",
  "files", "code", "issue", "issues", "session", "sessions", "work", "task",
  "tasks",
]);

// A concept's tokens that must all appear near the file mention: 4+ letters,
// compared by their first six characters so "automation" meets "automated".
function significantTokens(concept: string): string[] {
  const tokens = concept
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length >= 4 && !CONCEPT_STOP_WORDS.has(t))
    .map((t) => t.slice(0, 6));
  if (tokens.length > 0) return [...new Set(tokens)];
  const whole = concept.trim().toLowerCase();
  return whole.length >= 3 ? [whole] : [];
}

const RELATION_VERB =
  /\b(us(e|es|ed|ing)|import(s|ed|ing)?|requir(e|es|ed|ing)|call(s|ed|ing)?|invok(e|es|ed|ing)|defin(e|es|ed|ing)|declar(e|es|ed|ing)|implement(s|ed|ing|ation)?|extend(s|ed|ing)?|test(s|ed|ing)?|verif(y|ies|ied|ying)|validat(e|es|ed|ing|ion)|check(s|ed|ing)?|fix(es|ed|ing)?|resolv(e|es|ed|ing)|caus(e|es|ed|ing)|break(s|ing)?|broke|fail(s|ed|ing|ure)?|depend(s|ed|ing|ency)?|read(s|ing)?|writ(e|es|ing|ten)|wrote|load(s|ed|ing)?|sav(e|es|ed|ing)|pars(e|es|ed|ing)|generat(e|es|ed|ing)|configur(e|es|ed|ing)|document(s|ed|ing)?|describ(e|es|ed|ing)|explain(s|ed|ing)?|record(s|ed|ing)?|mov(e|es|ed|ing)|renam(e|es|ed|ing)|delet(e|es|ed|ing)|add(s|ed|ing)?|remov(e|es|ed|ing)|updat(e|es|ed|ing)|modif(y|ies|ied|ying)|refactor(s|ed|ing)?|register(s|ed|ing)?|expos(e|es|ed|ing)|handl(e|es|ed|ing)|schedul(e|es|ed|ing)|run(s|ning)?|ran|execut(e|es|ed|ing)|creat(e|es|ed|ing)|build(s|ing)?|built|patch(es|ed|ing)?|appl(y|ies|ied|ying)|instal(l|ls|led|ling)|wrap(s|ped|ping)?|emit(s|ted|ting)?|persist(s|ed|ing)?|stor(e|es|ed|ing)|automat(e|es|ed|ing|ion)|kill(s|ed|ing)?|relaunch(es|ed)?|restart(s|ed|ing)?|migrat(e|es|ed|ing))\b/i;

const FILE_MENTION =
  /(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+|\b[A-Za-z0-9_-]+\.(?:ts|js|mjs|cjs|tsx|jsx|py|ps1|sh|md|json|yaml|yml|toml|txt|cmd|bat|rs|go|java|cs|html|css|sql|env)\b/g;
// An observation naming this many files is a list, not a relation.
const LIST_SHAPED_FILE_MENTIONS = 5;
const EVIDENCE_WINDOW = 120;

/**
 * Evidence as a gate, not a ranking (trial 3, 2026-09-10: titles that merely
 * mentioned the file typed "BOM documents Hermes_Gateway.cmd" at 0.9 from a
 * file-list observation). An observation counts only when the file's basename
 * and every significant token of the concept sit in one window that also
 * carries a relation verb, and only when the observation is not a file list.
 * A bare tool-name title ("Bash") is dropped; its narrative still counts.
 */
export interface EvidenceExplanation {
  /** observations read for the pair */
  read: number;
  /** of those, how many mention the file's basename at all */
  withFile: number;
  /** ... and carry every significant concept token near that mention */
  withConcept: number;
  /** ... and carry a relation verb near that mention */
  withVerb: number;
  /** observations naming five or more files (never evidence) */
  listShaped: number;
  /** observations that passed the whole gate */
  gated: number;
  snippets: string[];
  /** when nothing passed: the first two observation texts, so the reason can be read */
  samples?: string[];
}

/** The gate with its reasons, so a dry run can say why a pair is not asked. */
export function explainEvidence(
  observations: Array<{ title: string; narrative?: string }>,
  conceptName: string,
  fileName: string,
  limit = EVIDENCE_TITLES_PER_PAIR,
): EvidenceExplanation {
  const out: EvidenceExplanation = {
    read: observations.length,
    withFile: 0,
    withConcept: 0,
    withVerb: 0,
    listShaped: 0,
    gated: 0,
    snippets: [],
  };
  const base = fileName.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (!base) return out;
  const tokens = significantTokens(conceptName);
  if (tokens.length === 0) return out;
  for (const o of observations) {
    const rawTitle = (o.title ?? "").trim();
    const bareTitle = !rawTitle || TOOL_NAMES.has(rawTitle.toLowerCase());
    const title = bareTitle ? "" : rawTitle;
    const narrative = o.narrative ?? "";
    const text = title ? `${title}. ${narrative}` : narrative;
    const lower = text.toLowerCase();
    if (!lower.includes(base)) continue;
    out.withFile += 1;
    const mentions = new Set((text.match(FILE_MENTION) ?? []).map((m) => m.toLowerCase()));
    const listShaped = mentions.size >= LIST_SHAPED_FILE_MENTIONS;
    if (listShaped) out.listShaped += 1;
    let conceptOk = false;
    let verbOk = false;
    let snippet: string | null = null;
    for (let at = lower.indexOf(base); at >= 0; at = lower.indexOf(base, at + 1)) {
      const window = text.slice(
        Math.max(0, at - EVIDENCE_WINDOW),
        Math.min(text.length, at + base.length + EVIDENCE_WINDOW),
      );
      const windowLower = window.toLowerCase();
      const hasConcept = tokens.every((t) => windowLower.includes(t));
      const hasVerb = RELATION_VERB.test(window);
      if (hasConcept) conceptOk = true;
      if (hasVerb) verbOk = true;
      if (hasConcept && hasVerb && !snippet) snippet = window.trim();
    }
    if (conceptOk) out.withConcept += 1;
    if (verbOk) out.withVerb += 1;
    if (!snippet || listShaped) continue;
    out.gated += 1;
    if (out.snippets.length < limit) {
      out.snippets.push(!title || snippet.includes(title) ? snippet : `${title} -- ${snippet}`);
    }
  }
  if (out.gated === 0) {
    out.samples = observations
      .slice(0, 2)
      .map((o) => `${(o.title ?? "").trim()} | ${(o.narrative ?? "").slice(0, 200)}`);
  }
  return out;
}

export function pickEvidence(
  observations: Array<{ title: string; narrative?: string }>,
  conceptName: string,
  fileName: string,
  limit = EVIDENCE_TITLES_PER_PAIR,
): string[] {
  return explainEvidence(observations, conceptName, fileName, limit).snippets;
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
const EVIDENCE_CANDIDATES_PER_PAIR = 24;

async function evidenceFor(
  kv: StateKV,
  candidates: TypingCandidate[],
): Promise<Map<string, EvidenceExplanation>> {
  const evidence = new Map<string, EvidenceExplanation>();
  for (const c of candidates) {
    const observations: Array<{ title: string; narrative?: string }> = [];
    const seen = new Set<string>();
    const keep = (observation: CompressedObservation | null): void => {
      if (observation && (observation.title || observation.narrative)) {
        observations.push({ title: observation.title ?? "", narrative: observation.narrative });
      }
    };
    for (const ref of c.edge.sourceRefs ?? []) {
      if (observations.length >= EVIDENCE_CANDIDATES_PER_PAIR) break;
      if (ref.sourceKind !== "observation" || !ref.sessionId) continue;
      seen.add(ref.sourceId);
      keep(await kv.get<CompressedObservation>(KV.observations(ref.sessionId), ref.sourceId).catch(() => null));
    }
    // Live store 2026-09-11: pairs carried 100-298 backing ids but 1-7 refs,
    // so reading through refs alone showed the gate two observations in two
    // hundred. An id without a ref is resolved through its projection row,
    // which knows the session that holds the observation.
    for (const id of c.edge.sourceObservationIds ?? []) {
      if (observations.length >= EVIDENCE_CANDIDATES_PER_PAIR) break;
      if (seen.has(id)) continue;
      seen.add(id);
      const projection = await kv
        .get<ObservationProjection>(KV.observationProjections, id)
        .catch(() => null);
      if (!projection?.sessionId) continue;
      keep(await kv.get<CompressedObservation>(KV.observations(projection.sessionId), id).catch(() => null));
    }
    evidence.set(c.edge.id, explainEvidence(observations, c.source.name, c.target.name));
  }
  return evidence;
}

export interface TypeBackfillRequest {
  minBacking?: number;
  batchSize?: number;
  maxBatches?: number;
  skipEdgeIds?: string[];
  dryRun?: boolean;
  /** with dryRun: read each candidate's evidence and report why the gate passes or fails it */
  explain?: boolean;
}

export interface TypingExplanation extends EvidenceExplanation {
  edgeId: string;
  concept: string;
  file: string;
  backing: number;
  /** sourceRefs on the edge (the ids resolvable without a projection lookup) */
  refs: number;
}

export interface TypeBackfillResult {
  success: boolean;
  candidates: number;
  asked: number;
  typed: number;
  none: number;
  rejected: number;
  /** candidates never asked because no backing observation states a relation */
  skipped: number;
  attemptedEdgeIds: string[];
  dryRun: boolean;
  error?: string;
  explained?: TypingExplanation[];
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
        skipped: 0,
        attemptedEdgeIds: [],
        dryRun,
      };
      if (dryRun && data.explain === true) {
        // Read the evidence, ask nothing, write nothing: the gate's reasons
        // per pair are what decides whether the gate or the corpus is at fault.
        const evidence = await evidenceFor(kv, candidates);
        result.explained = candidates.map((c) => {
          const e = evidence.get(c.edge.id)!;
          return {
            edgeId: c.edge.id,
            concept: c.source.name,
            file: c.target.name,
            backing: c.edge.sourceObservationIds.length,
            refs: (c.edge.sourceRefs ?? []).length,
            ...e,
            snippets: e.snippets.slice(0, 1),
          };
        });
        return result;
      }
      if (dryRun || candidates.length === 0) return result;

      for (let start = 0; start < candidates.length; start += batchSize) {
        const batch = candidates.slice(start, start + batchSize);
        const evidence = await evidenceFor(kv, batch);
        // A pair with no gated evidence is not asked: the model would answer
        // from the names alone, which is what trials 1-3 measured at 40-70%.
        // It still counts as attempted so the driver never brings it back.
        const snippets = new Map(
          Array.from(evidence, ([id, e]) => [id, e.snippets] as [string, string[]]),
        );
        const asked = batch.filter((c) => (snippets.get(c.edge.id) ?? []).length > 0);
        const skipped = batch.filter((c) => !asked.includes(c));
        result.skipped += skipped.length;
        result.attemptedEdgeIds.push(...skipped.map((c) => c.edge.id));
        if (asked.length === 0) continue;
        const prompt = buildTypingPrompt(asked, snippets);
        let response: string;
        try {
          response = await provider.compress(GRAPH_TYPING_SYSTEM, prompt);
        } catch (err) {
          result.success = false;
          result.error = err instanceof Error ? err.message : String(err);
          logger.error("graph-type-backfill provider call failed", { error: result.error });
          return result;
        }
        result.asked += asked.length;
        result.attemptedEdgeIds.push(...asked.map((c) => c.edge.id));

        const parsed = parseTypingResponse(response, asked);
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
            context: {
              reasoning: `typed from related_to ${old.id} by graph-type-backfill`,
              evidence: snippets.get(old.id) ?? [],
            },
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
