import type { GraphEdge, GraphNode, GraphSnapshot } from "../types.js";

// Which graph rows are alive, as the snapshot defines it.
//
// mem::graph-reset never deletes rows. It writes an empty snapshot carrying a
// new graphGeneration and resetAt, and from then on a row belongs to the graph
// only if it carries that generation (or, for stores that predate generation
// stamping, was created after the reset). persist, the snapshot export and
// retrieval must all agree on this one rule, so it lives here.

export const SNAPSHOT_KEY = "current";

// The snapshot holds rankings and counts; observation lists stay on the rows.
// Every graph delta reads and rewrites the snapshot whole, and hub nodes'
// lists made it 6.6 MB on 2026-09-24. Readers that return rows re-read them.
export function compactSnapshot(snap: GraphSnapshot): GraphSnapshot {
  return {
    ...snap,
    topNodes: snap.topNodes.map((n) => ({ ...n, sourceObservationIds: [], sourceRefs: undefined })),
    topEdges: snap.topEdges.map((e) => ({ ...e, sourceObservationIds: [], sourceRefs: undefined })),
  };
}

export function belongsToCurrentGeneration(
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
