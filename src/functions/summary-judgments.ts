import type { ISdk } from "../iii-compat.js";
import type { StateKV } from "../state/kv.js";
import { KV, generateId } from "../state/schema.js";
import type {
  GraphEdge,
  GraphNode,
  GraphSourceLocator,
  MemoryProvider,
  Session,
  SessionSummary,
} from "../types.js";
import { isGraphExtractionEnabled } from "../config.js";
import { logger } from "../logger.js";
import { NODE_TYPES } from "./graph-schema.js";
import { normalizeGraphName, parseAttrs, persistGraphDelta } from "./graph.js";
import {
  JUDGMENT_EDGE_TYPES,
  JUDGMENT_EXTRACTION_SYSTEM,
  buildJudgmentExtractionPrompt,
} from "../prompts/judgment-extraction.js";
import { ProjectionCoordinator } from "./projection-coordinator.js";

// Judgment relations from a session summary's keyDecisions, added beside
// the generic extraction the summary already goes through. Every edge
// carries SUMMARY_JUDGMENT_TAG, so the lot can be found -- and taken out
// again if the before/after measurement shows no gain.
export const SUMMARY_JUDGMENT_TAG = "summary-judgment-v2";

const JUDGMENT = new Set<string>(JUDGMENT_EDGE_TYPES);
const JUDGMENT_WEIGHT = 0.8;

export interface JudgmentAssertion {
  type: string;
  source: string;
  target: string;
  decision: number;
}

const words = (s: string): string[] =>
  s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
const plain = (s: string): string => words(s).join(" ");

// Most of a name's words must occur in the decision text: catches invented
// and respelled names.
function grounded(name: string, decision: string): boolean {
  const w = words(name);
  if (w.length === 0) return false;
  const text = plain(decision);
  return w.filter((x) => text.includes(x)).length / w.length >= 0.6;
}

// A word mixing Hangul and Latin letters is a respelling ("멀티테enant"), and
// passed the grounding ratio in the spike because its other words matched.
const hasMixedScriptWord = (name: string): boolean =>
  name.split(/\s+/).some((w) => /\p{Script=Hangul}/u.test(w) && /[A-Za-z]/.test(w));

// An option label from one project's ledger means nothing as a node name:
// "AC2", "AK1", or "option B".
const hasOptionLabel = (name: string): boolean =>
  /\b[A-Z]{1,3}\d{1,2}\b/.test(name) || /\boption\s+[A-Z0-9]\b/i.test(name);

/** Why a parsed relation is not kept, or null when it is. */
export function judgmentRejectReason(r: JudgmentAssertion, decision: string): string | null {
  if (!JUDGMENT.has(r.type)) return "type";
  if (!r.source || !r.target || plain(r.source) === plain(r.target)) return "self";
  const s = plain(r.source);
  const t = plain(r.target);
  if (t.length >= 4 && s.includes(t)) return "tautology";
  if (hasOptionLabel(r.source) || hasOptionLabel(r.target)) return "option-label";
  if (hasMixedScriptWord(r.source) || hasMixedScriptWord(r.target)) return "mixed-script";
  if (!grounded(r.target, decision)) return "ungrounded-target";
  // The source of these two is not a topic but a thing from the text.
  if ((r.type === "succeeded_by" || r.type === "blocked_by") && !grounded(r.source, decision)) {
    return "ungrounded-source";
  }
  return null;
}

function parseJudgmentXml(xml: string): { types: Map<string, string>; relations: JudgmentAssertion[] } {
  const types = new Map<string, string>();
  for (const m of xml.matchAll(/<entity\b([^>]*?)\/?>/g)) {
    const a = parseAttrs(m[1]);
    if (a["name"] && a["type"]) types.set(normalizeGraphName(a["name"]), a["type"]);
  }
  const relations: JudgmentAssertion[] = [];
  for (const m of xml.matchAll(/<relationship\b([^>]*?)\/?>/g)) {
    const a = parseAttrs(m[1]);
    const decision = Number(a["decision"]);
    if (!a["type"] || !a["source"] || !a["target"] || !Number.isInteger(decision)) continue;
    relations.push({
      type: a["type"],
      source: normalizeGraphName(a["source"]),
      target: normalizeGraphName(a["target"]),
      decision,
    });
  }
  return { types, relations };
}

/** Parse, filter and shape one summary's extraction into a graph delta. */
export function buildSummaryJudgmentDelta(
  summary: SessionSummary,
  session: Session,
  xml: string,
  now = new Date().toISOString(),
): { nodes: GraphNode[]; edges: GraphEdge[]; dropped: Record<string, number> } {
  const projectId = session.project || summary.project;
  const sourceRef: GraphSourceLocator = {
    sourceKind: "summary",
    sourceId: summary.sessionId,
    sessionId: summary.sessionId,
    ...(projectId ? { projectId } : {}),
  };
  const { types, relations } = parseJudgmentXml(xml);
  const nodes = new Map<string, GraphNode>();
  const node = (name: string): GraphNode => {
    const key = name.toLocaleLowerCase("en-US");
    const existing = nodes.get(key);
    if (existing) return existing;
    const declared = types.get(name);
    const created: GraphNode = {
      id: generateId("gn"),
      type: declared && NODE_TYPES.has(declared as GraphNode["type"]) ? (declared as GraphNode["type"]) : "concept",
      name,
      properties: {},
      sourceObservationIds: [summary.sessionId],
      sourceRefs: [sourceRef],
      ...(projectId ? { projectId } : {}),
      visibility: "project",
      createdAt: now,
    };
    nodes.set(key, created);
    return created;
  };

  const edges: GraphEdge[] = [];
  const dropped: Record<string, number> = {};
  for (const r of relations) {
    const decision = summary.keyDecisions[r.decision - 1];
    const why = decision === undefined ? "no-decision" : judgmentRejectReason(r, decision);
    if (why) {
      dropped[why] = (dropped[why] ?? 0) + 1;
      continue;
    }
    edges.push({
      id: generateId("ge"),
      type: r.type as GraphEdge["type"],
      sourceNodeId: node(r.source).id,
      targetNodeId: node(r.target).id,
      weight: JUDGMENT_WEIGHT,
      sourceObservationIds: [summary.sessionId],
      sourceRefs: [sourceRef],
      ...(projectId ? { projectId } : {}),
      visibility: "project",
      createdAt: now,
      context: { reasoning: SUMMARY_JUDGMENT_TAG, evidence: [decision!] },
    });
  }
  return { nodes: [...nodes.values()], edges, dropped };
}

export type SummaryJudgmentResult = {
  success: boolean;
  edgesAdded?: number;
  nodesAdded?: number;
  dropped?: Record<string, number>;
  /** How much the model returned, so a zero can be told from a refusal. */
  responseChars?: number;
  skipped?: string;
  error?: string;
};
export type SummaryJudgmentCore = (data: { sessionId: string }) => Promise<SummaryJudgmentResult>;

export function registerSummaryJudgmentFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
  coordinator = new ProjectionCoordinator(),
): SummaryJudgmentCore {
  const core: SummaryJudgmentCore = async ({ sessionId }) => {
    if (!isGraphExtractionEnabled()) return { success: true, skipped: "graph_extraction_disabled" };
    if (provider.name.includes("noop")) return { success: true, skipped: "no_provider" };
    const summary = await kv.get<SessionSummary>(KV.summaries, sessionId);
    if (!summary) return { success: false, error: "summary missing" };
    if ((summary.keyDecisions ?? []).length === 0) return { success: true, edgesAdded: 0 };
    const session = await kv.get<Session>(KV.sessions, sessionId);
    if (!session) return { success: false, error: "session missing" };

    let xml: string;
    try {
      xml = await provider.compress(
        JUDGMENT_EXTRACTION_SYSTEM,
        buildJudgmentExtractionPrompt(summary.title, summary.keyDecisions),
      );
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
    const { nodes, edges, dropped } = buildSummaryJudgmentDelta(summary, session, xml);
    const responseChars = xml.length;
    if (edges.length === 0) return { success: true, edgesAdded: 0, dropped, responseChars };
    const { newNodeCount, newEdgeCount } = await persistGraphDelta(kv, nodes, edges, [sessionId]);
    logger.info("Summary judgments extracted", { sessionId, edges: edges.length, newEdges: newEdgeCount, dropped });
    return { success: true, edgesAdded: newEdgeCount, nodesAdded: newNodeCount, dropped, responseChars };
  };

  // One summary per call, admitted by the coordinator like any graph stage,
  // so a backfill loop never runs two LLM extractions at once.
  sdk.registerFunction("mem::summary-judgments", async (data: { sessionId?: string }) => {
    if (typeof data?.sessionId !== "string" || !data.sessionId) {
      return { success: false, error: "sessionId is required" };
    }
    const sessionId = data.sessionId;
    const run = await coordinator.run({ stage: "graph", sourceId: `judgments:${sessionId}` }, () => core({ sessionId }));
    return run.accepted ? run.value : { success: false, deferred: true, error: run.error };
  });
  return core;
}
