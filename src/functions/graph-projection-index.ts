import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import type { GraphProjection } from "../types.js";
import { logger } from "../logger.js";

// The graph projection rows that are still doing something, kept apart from
// the ones that are done -- the same shape as observation-projection-index.ts.
//
// mem:graph:projections holds one row per graph source ever projected: on the
// live store 130,526 rows and 46.6 MB (state::list accounting, 2026-09-12),
// almost all `succeeded`. The health monitor (every 30 s) and the retry
// scheduler listed the whole scope to find the few pending or failed rows,
// and state::list has no pagination. This index holds only the non-succeeded
// rows under the same keys, so those readers move from 46.6 MB per read to a
// few kilobytes.
//
// Built lazily: the first reader after deploy lists the full scope once,
// writes the active rows and a marker, and from then on only the index is
// read. A row's key is derivable from the row (sourceKind:sourceId), so the
// index can check any row against its canonical copy and heal drift.

const BUILT_KEY = "__built";

interface BuiltMarker {
  builtAt: string;
  rows: number;
}

const isRow = (value: unknown): value is GraphProjection =>
  !!value &&
  typeof (value as GraphProjection).sourceId === "string" &&
  typeof (value as GraphProjection).sourceKind === "string";

/** The key graph-source-projection.ts writes a row under. */
export function graphProjectionKey(row: Pick<GraphProjection, "sourceKind" | "sourceId">): string {
  return `${row.sourceKind}:${row.sourceId}`;
}

/** Every write of a graph projection row goes through here so the index cannot drift. */
export async function writeGraphProjection(
  kv: StateKV,
  key: string,
  row: GraphProjection,
): Promise<void> {
  await kv.set(KV.graphProjections, key, row);
  if (row.status === "succeeded") {
    await kv.delete(KV.graphProjectionsActive, key).catch(() => {});
  } else {
    await kv.set(KV.graphProjectionsActive, key, row);
  }
}

/** The one deliberate full-scope read. Safe to run again at any time. */
export async function rebuildActiveGraphProjectionIndex(
  kv: StateKV,
): Promise<{ scanned: number; active: number }> {
  return withKeyedLock("graph-projection-index-rebuild", async () => {
    const all = await kv.list<GraphProjection>(KV.graphProjections);
    const stale = await kv.list<unknown>(KV.graphProjectionsActive).catch(() => [] as unknown[]);
    for (const row of stale) {
      if (isRow(row)) await kv.delete(KV.graphProjectionsActive, graphProjectionKey(row)).catch(() => {});
    }
    let active = 0;
    for (const row of all) {
      if (!isRow(row) || row.status === "succeeded") continue;
      await kv.set(KV.graphProjectionsActive, graphProjectionKey(row), row);
      active += 1;
    }
    const marker: BuiltMarker = { builtAt: new Date().toISOString(), rows: active };
    await kv.set(KV.graphProjectionsActive, BUILT_KEY, marker);
    logger.info("Graph projection index rebuilt", { scanned: all.length, active });
    return { scanned: all.length, active };
  });
}

/**
 * The non-succeeded graph projection rows. Reads the index when it has been
 * built; builds it first when it has not. A row contradicted by its canonical
 * copy (succeeded meanwhile) is dropped here.
 */
export async function listActiveGraphProjections(kv: StateKV): Promise<GraphProjection[]> {
  const built = await kv.get<BuiltMarker>(KV.graphProjectionsActive, BUILT_KEY).catch(() => null);
  if (!built) {
    await rebuildActiveGraphProjectionIndex(kv);
  }
  const rows = await kv.list<unknown>(KV.graphProjectionsActive).then((r) => r.filter(isRow));
  const live: GraphProjection[] = [];
  for (const row of rows) {
    const key = graphProjectionKey(row);
    const canonical = await kv.get<GraphProjection>(KV.graphProjections, key).catch(() => null);
    if (canonical && canonical.status === "succeeded") {
      await kv.delete(KV.graphProjectionsActive, key).catch(() => {});
      continue;
    }
    live.push(canonical ?? row);
  }
  return live;
}
