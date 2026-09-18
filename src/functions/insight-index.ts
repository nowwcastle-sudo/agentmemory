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

/**
 * What makes two insights the same insight: their scope and their title,
 * case and punctuation aside. The id is a hash of the content, and a model
 * rewords the content on every reflect run -- by 2026-09-06 the store held
 * 58 extra copies among its top 500 insights, one title five times.
 */
export function insightTitleKey(insight: { title: string; project?: string }): string {
  const title = insight.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return JSON.stringify([insight.project ?? "", title]);
}

const TITLE_STOP_WORDS = new Set([
  "a", "an", "the", "of", "to", "in", "for", "and", "or", "is", "are", "be",
  "as", "by", "on", "at", "with", "must", "should", "can", "from", "into",
  "than", "that", "this",
]);

function titleWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w && !TITLE_STOP_WORDS.has(w)),
  );
}

/**
 * Whether two titles read as one insight for display: word overlap
 * (Jaccard, stop words aside) of at least 0.5 over three or more shared
 * words, which includes the same title. Sampled on the
 * live store 2026-09-18, 15 of 16 pairs between 0.4 and 0.6 were one
 * insight reworded ("Governance workflow bypass creates silent regressions"
 * / "Governance bypass creates silent regression loops"); the miss was
 * "...explicit state management" / "...explicit secret rotation". For
 * choosing what to show only -- reflect keeps the exact-title rule, since a
 * merge in the store would make that miss permanent.
 */
export function sameInsightTitle(a: { title: string }, b: { title: string }): boolean {
  const x = titleWords(a.title);
  const y = titleWords(b.title);
  const plain = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (plain(a.title) === plain(b.title)) return true;
  if (x.size === 0 || y.size === 0) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  // Three shared words at least: two three-word titles one word apart
  // ("cap marker 0" / "cap marker 1") sit at exactly 0.5 and are different.
  return shared >= 3 && shared / (x.size + y.size - shared) >= 0.5;
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
