import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { Insight } from "../types.js";

// What the context path reads instead of the whole insight scope.
//
// `mem::context` lists every insight on every session, keeps five, and shows
// 240 characters of each. On the live store that is 1,505 rows and 23.8 MB
// crossing the engine socket for a few hundred bytes of output -- and 23.8 MB
// is past the engine's default 16 MiB frame ceiling, which is how one context
// call took the state worker's connection down permanently on 2026-09-10.
//
// The row carries exactly the fields the reader scores and renders on. Same
// shape as the #814 graph snapshot: a small derived value the hot path reads,
// a rebuild for first run and repair, and the full scope left as it is.

export const INSIGHT_PREVIEW_CHARS = 240;

// Measured on the live store: the cluster field was 94% of the index (11.0 of
// 11.7 MB) -- median 75 names per insight, p90 1,239, none duplicated. The
// reader only needs an overlap ratio against a project profile's top concepts,
// so the row keeps a bounded prefix and the true length: the ratio's
// denominator stays exact, its numerator is exact up to the cap.
// ponytail: names past the cap can't score a hit, so an insight whose only
// matching concepts sit beyond position 64 loses at most the 0.5x overlap
// boost. Raise the cap, or store the intersection with known profile
// concepts, if that ever shows up in a ranking.
export const INSIGHT_INDEX_CLUSTER_CAP = 64;

export interface InsightIndexRow {
  id: string;
  title: string;
  preview: string;
  confidence: number;
  project?: string;
  /** Lowercased, first INSIGHT_INDEX_CLUSTER_CAP names only. */
  sourceConceptCluster: string[];
  /** True length of the insight's cluster, the overlap denominator. */
  clusterSize: number;
  lastReinforcedAt?: string;
  updatedAt: string;
  deleted?: boolean;
}

export function toIndexRow(insight: Insight): InsightIndexRow {
  const cluster = (insight.sourceConceptCluster ?? []).map((c) => c.toLowerCase());
  return {
    id: insight.id,
    title: insight.title,
    // Collapsed to one line here so the reader renders the row verbatim; it
    // applies the same collapse at render time, which is idempotent.
    preview: insight.content
      .replace(/\s*\n+\s*/g, " ")
      .trim()
      .slice(0, INSIGHT_PREVIEW_CHARS),
    confidence: insight.confidence,
    project: insight.project,
    sourceConceptCluster: cluster.slice(0, INSIGHT_INDEX_CLUSTER_CAP),
    clusterSize: cluster.length,
    lastReinforcedAt: insight.lastReinforcedAt,
    updatedAt: insight.updatedAt,
    deleted: insight.deleted,
  };
}

/** Every write of an insight goes through here so the index cannot drift. */
export async function writeInsight(kv: StateKV, insight: Insight): Promise<void> {
  await kv.set(KV.insights, insight.id, insight);
  await kv.set(KV.insightIndex, insight.id, toIndexRow(insight));
}

/**
 * Rebuild the index from the full scope: first run after deploy, and repair.
 * This is the one place that still lists `mem:insights` whole, by design.
 */
export async function rebuildInsightIndex(kv: StateKV): Promise<{ rows: number }> {
  const all = await kv.list<Insight>(KV.insights);
  for (const insight of all) {
    await kv.set(KV.insightIndex, insight.id, toIndexRow(insight));
  }
  return { rows: all.length };
}
