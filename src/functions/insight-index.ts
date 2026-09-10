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

export interface InsightIndexRow {
  id: string;
  title: string;
  preview: string;
  confidence: number;
  project?: string;
  sourceConceptCluster: string[];
  lastReinforcedAt?: string;
  updatedAt: string;
  deleted?: boolean;
}

export function toIndexRow(insight: Insight): InsightIndexRow {
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
    sourceConceptCluster: insight.sourceConceptCluster ?? [],
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
