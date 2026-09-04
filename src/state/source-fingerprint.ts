import type { CompressedObservation, GraphSource } from "../types.js";
import { fingerprintId } from "./schema.js";

function observationValue(observation: CompressedObservation): unknown {
  return {
    id: observation.id,
    sessionId: observation.sessionId,
    timestamp: observation.timestamp,
    type: observation.type,
    title: observation.title,
    subtitle: observation.subtitle,
    facts: observation.facts,
    narrative: observation.narrative,
    concepts: observation.concepts,
    files: observation.files,
    importance: observation.importance,
    agentId: observation.agentId,
    projectId: observation.projectId,
    visibility: observation.visibility,
  };
}

export function summarySourceFingerprint(
  observations: CompressedObservation[],
): string {
  const stable = [...observations]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(observationValue);
  return fingerprintId("summary", JSON.stringify(stable));
}

export function graphSourceFingerprint(source: GraphSource): string {
  return fingerprintId(
    "graph",
    JSON.stringify({
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      sessionId: source.sessionId,
      projectId: source.projectId,
      actorAgentId: source.actorAgentId,
      visibility: source.visibility,
      observationType: source.observationType,
      title: source.title,
      narrative: source.narrative,
      concepts: source.concepts,
      files: source.files,
      timestamp: source.timestamp,
    }),
  );
}
