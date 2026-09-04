import type {
  CompressedObservation,
  GraphSource,
  Lesson,
  Memory,
  Session,
  SessionSummary,
} from "../types.js";

export const GLOBAL_GRAPH_PROJECT_ID = "__global__";

// Wraps a Memory record in the CompressedObservation shape that
// SearchIndex / VectorIndex / enrichment paths consume. Memories share
// the same searchable fields as observations (title + content +
// concepts + files); type is normalized to "decision" so memories stay
// distinguishable in result metadata without colliding with observation
// enums (file_read, command_run, …). The synthetic sessionId
// ("memory" or memory.sessionIds[0]) is what enrich-side fallbacks key
// off of when looking up the source record in KV.memories.
export function memoryToObservation(memory: Memory): CompressedObservation {
  return {
    id: memory.id,
    sessionId: memory.sessionIds?.[0] ?? "memory",
    timestamp: memory.createdAt,
    type: "decision",
    title: memory.title,
    facts: [memory.content],
    narrative: memory.content,
    concepts: memory.concepts,
    files: memory.files,
    importance: memory.strength,
    // Carry the owning agent through so agent-scoped search filters see
    // memories, not just raw observations. Dropping it made every memory
    // invisible to any agentId-scoped query.
    ...(memory.agentId ? { agentId: memory.agentId } : {}),
    ...(memory.project ? { projectId: memory.project } : {}),
    ...(memory.projectName ? { projectName: memory.projectName } : {}),
    visibility: memory.visibility ?? "project",
    sourceKind: "memory",
  };
}

export function observationToGraphSource(
  observation: CompressedObservation,
  projectId: string,
): GraphSource {
  return {
    sourceKind: "observation",
    sourceId: observation.id,
    sessionId: observation.sessionId,
    projectId: observation.projectId ?? projectId,
    ...(observation.agentId
      ? { actorAgentId: observation.agentId }
      : {}),
    visibility: observation.visibility ?? "project",
    observationType: observation.type,
    title: observation.title,
    narrative: observation.narrative,
    concepts: observation.concepts,
    files: observation.files,
    timestamp: observation.timestamp,
  };
}

export function memoryToGraphSource(memory: Memory): GraphSource {
  return {
    sourceKind: "memory",
    sourceId: memory.id,
    ...(memory.sessionIds?.[0]
      ? { sessionId: memory.sessionIds[0] }
      : {}),
    projectId: memory.project ?? GLOBAL_GRAPH_PROJECT_ID,
    ...(memory.agentId ? { actorAgentId: memory.agentId } : {}),
    visibility: memory.visibility ?? "project",
    observationType: "decision",
    title: memory.title,
    narrative: memory.content,
    concepts: memory.concepts,
    files: memory.files,
    timestamp: memory.createdAt,
  };
}

export function summaryToGraphSource(
  summary: SessionSummary,
  session: Session,
): GraphSource {
  const decisions = summary.keyDecisions.length > 0
    ? `\nDecisions:\n${summary.keyDecisions.map((decision) => `- ${decision}`).join("\n")}`
    : "";
  return {
    sourceKind: "summary",
    sourceId: summary.sessionId,
    sessionId: summary.sessionId,
    projectId: session.project || summary.project || GLOBAL_GRAPH_PROJECT_ID,
    ...(session.agentId ? { actorAgentId: session.agentId } : {}),
    visibility: "project",
    observationType: "decision",
    title: summary.title,
    narrative: `${summary.narrative}${decisions}`,
    concepts: summary.concepts,
    files: summary.filesModified,
    timestamp: summary.createdAt,
  };
}

export function graphSourceToObservation(
  source: GraphSource,
): CompressedObservation {
  return {
    id: source.sourceId,
    sessionId: source.sessionId ?? source.sourceKind,
    timestamp: source.timestamp,
    type: source.observationType ??
      (source.sourceKind === "memory" || source.sourceKind === "summary"
        ? "decision"
        : "other"),
    title: source.title,
    facts: source.narrative ? [source.narrative] : [],
    narrative: source.narrative,
    concepts: source.concepts,
    files: source.files,
    importance:
      source.sourceKind === "memory" || source.sourceKind === "summary" ? 7 : 5,
    ...(source.actorAgentId ? { agentId: source.actorAgentId } : {}),
    projectId: source.projectId,
    visibility: source.visibility,
    sourceKind: source.sourceKind,
  };
}

// Same adapter for lessons, kept beside memoryToObservation so a new
// CompressedObservation field has one obvious place to be threaded
// through both record kinds.
export function lessonToObservation(l: Lesson): CompressedObservation {
  return {
    id: l.id,
    sessionId: "lesson",
    timestamp: l.createdAt,
    type: "decision",
    title: l.content.slice(0, 120),
    facts: [l.content],
    narrative: l.context || "",
    concepts: l.tags,
    files: [],
    importance: l.confidence,
  };
}
