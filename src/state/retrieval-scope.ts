import type {
  CompressedObservation,
  GraphSourceLocator,
  RetrievalMetadata,
  RetrievalScope,
} from "../types.js";

export function matchesRetrievalScope(
  metadata: RetrievalMetadata,
  scope?: RetrievalScope,
): boolean {
  if (!scope) return true;

  if (scope.projectId !== undefined) {
    if (!metadata.projectId || metadata.projectId !== scope.projectId) {
      return false;
    }
  }

  const visibility = metadata.visibility ?? "project";
  if (visibility !== "agent_private") return true;
  if (scope.wildcardAgent) return true;
  return Boolean(
    scope.actorAgentId &&
      metadata.actorAgentId &&
      scope.actorAgentId === metadata.actorAgentId,
  );
}

export function observationRetrievalMetadata(
  observation: CompressedObservation,
): RetrievalMetadata {
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

export function locatorRetrievalMetadata(
  locator: GraphSourceLocator,
): RetrievalMetadata {
  return {
    sourceKind: locator.sourceKind,
    sourceId: locator.sourceId,
    ...(locator.sessionId ? { sessionId: locator.sessionId } : {}),
    ...(locator.projectId ? { projectId: locator.projectId } : {}),
    ...(locator.actorAgentId
      ? { actorAgentId: locator.actorAgentId }
      : {}),
    ...(locator.visibility ? { visibility: locator.visibility } : {}),
  };
}
