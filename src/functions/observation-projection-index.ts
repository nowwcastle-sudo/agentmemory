import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import type { ObservationProjection } from "../types.js";
import { logger } from "../logger.js";

// The rows that are still doing something, kept apart from the ones that are
// done.
//
// mem:obs:projections keeps a row for every observation ever projected --
// 58,651 rows and 12.8 MB on the live store, almost all of them `succeeded`.
// The drain, the health reconcile (every 30 s) and the retry scheduler each
// listed the whole scope to find the handful that are pending or failed, and
// state::list has no pagination: the scope crosses the engine as one message.
// This index holds only the non-succeeded rows, in the same shape, so those
// readers move from 12.8 MB per read to a few kilobytes.
//
// Built lazily: the first reader after deploy (or after a restore) lists the
// full scope once, writes the active rows and a marker, and from then on only
// the index is read. Until that happens nothing changes, so an un-migrated
// store behaves exactly as before.

const BUILT_KEY = "__built";

interface BuiltMarker {
  builtAt: string;
  rows: number;
}

const isRow = (value: unknown): value is ObservationProjection =>
  !!value && typeof (value as ObservationProjection).observationId === "string";

/** Every write of a projection row goes through here so the index cannot drift. */
export async function writeObservationProjection(
  kv: StateKV,
  row: ObservationProjection,
): Promise<void> {
  await kv.set(KV.observationProjections, row.observationId, row);
  if (row.status === "succeeded") {
    await kv.delete(KV.observationProjectionsActive, row.observationId).catch(() => {});
  } else {
    await kv.set(KV.observationProjectionsActive, row.observationId, row);
  }
}

/**
 * The one deliberate full-scope read: list everything, keep what is not
 * succeeded, mark the index built. Safe to run again at any time.
 */
export async function rebuildActiveProjectionIndex(
  kv: StateKV,
): Promise<{ scanned: number; active: number }> {
  return withKeyedLock("obs-projection-index-rebuild", async () => {
    const all = await kv.list<ObservationProjection>(KV.observationProjections);
    const stale = await kv.list<unknown>(KV.observationProjectionsActive).catch(() => [] as unknown[]);
    for (const row of stale) {
      if (isRow(row)) await kv.delete(KV.observationProjectionsActive, row.observationId).catch(() => {});
    }
    let active = 0;
    for (const row of all) {
      if (row.status === "succeeded") continue;
      await kv.set(KV.observationProjectionsActive, row.observationId, row);
      active += 1;
    }
    const marker: BuiltMarker = { builtAt: new Date().toISOString(), rows: active };
    await kv.set(KV.observationProjectionsActive, BUILT_KEY, marker);
    logger.info("Observation projection index rebuilt", { scanned: all.length, active });
    return { scanned: all.length, active };
  });
}

/**
 * The non-succeeded projection rows. Reads the index when it has been built;
 * builds it first when it has not.
 */
export async function listActiveProjections(
  kv: StateKV,
): Promise<ObservationProjection[]> {
  const built = await kv.get<BuiltMarker>(KV.observationProjectionsActive, BUILT_KEY).catch(() => null);
  if (!built) {
    await rebuildActiveProjectionIndex(kv);
  }
  const rows = await kv.list<unknown>(KV.observationProjectionsActive).then((r) => r.filter(isRow));
  // The canonical row is the truth. A worker killed between the helper's two
  // writes (canonical first, index second) leaves an index row that says
  // running for a row that has succeeded; the active set is small, so one
  // get per row is cheap, and a contradicted row is dropped here.
  const live: ObservationProjection[] = [];
  for (const row of rows) {
    const canonical = await kv
      .get<ObservationProjection>(KV.observationProjections, row.observationId)
      .catch(() => null);
    if (canonical && canonical.status === "succeeded") {
      await kv.delete(KV.observationProjectionsActive, row.observationId).catch(() => {});
      continue;
    }
    live.push(canonical ?? row);
  }
  return live;
}
