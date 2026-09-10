import type { ISdk } from "../iii-compat.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { CompressedObservation, RawObservation, Session } from "../types.js";
import { buildSyntheticCompression, isBareTitle } from "./compress-synthetic.js";
import { getSearchIndex, scheduleIndexSave } from "./search.js";
import { logger } from "../logger.js";

// Rewrite the bare titles the synthetic compressor left behind.
//
// Every synthetic observation before 2026-09-11 is titled with its tool name
// ("Bash", "Read", "prompt_submit"). The compressor now derives a title from
// the tool's input; this pass applies the same derivation to rows already in
// the store, session by session (each session scope is small), resumable by
// cursor, and re-indexes the row in BM25 so search sees the new title. Only
// synthetic rows are touched (confidence 0.3 is the compressor's signature);
// an LLM-compressed row keeps whatever title the model gave it.

export { isBareTitle };

const SYNTHETIC_CONFIDENCE = 0.3;

export interface RetitleOptions {
  /** sessions to walk in this call */
  maxSessions?: number;
  /** resume after this session id (exclusive) */
  cursor?: string;
  dryRun?: boolean;
}

export interface RetitleResult {
  sessions: number;
  scanned: number;
  retitled: number;
  nextCursor: string | null;
}

export async function retitleObservations(
  kv: StateKV,
  { maxSessions = 25, cursor, dryRun = false }: RetitleOptions = {},
): Promise<RetitleResult> {
  const all = (await kv.list<Session>(KV.sessions))
    .filter((s) => s && typeof s.id === "string")
    .map((s) => s.id)
    .sort();
  const start = cursor ? all.findIndex((id) => id > cursor) : 0;
  const ids = start < 0 ? [] : all.slice(start, start + Math.max(1, maxSessions));
  const result: RetitleResult = { sessions: 0, scanned: 0, retitled: 0, nextCursor: null };
  const index = getSearchIndex();
  for (const sessionId of ids) {
    result.sessions += 1;
    const compressed = await kv.list<CompressedObservation>(KV.observations(sessionId)).catch(() => []);
    if (compressed.length === 0) continue;
    const raws = await kv.list<RawObservation>(KV.rawObservations(sessionId)).catch(() => []);
    const rawById = new Map(raws.filter((r) => r && r.id).map((r) => [r.id, r]));
    for (const row of compressed) {
      if (!row || typeof row.id !== "string") continue;
      result.scanned += 1;
      if (row.confidence !== SYNTHETIC_CONFIDENCE) continue;
      const raw = rawById.get(row.id);
      if (!raw) continue;
      const fresh = buildSyntheticCompression(raw);
      const bare = isBareTitle(row.title);
      const changed = (bare && fresh.title !== row.title) || fresh.importance !== row.importance;
      if (!changed) continue;
      result.retitled += 1;
      if (dryRun) continue;
      const next: CompressedObservation = { ...row, title: bare ? fresh.title : row.title, importance: fresh.importance };
      await kv.set(KV.observations(sessionId), row.id, next);
      if (index.has(row.id)) {
        index.remove(row.id);
        index.add(next);
      }
    }
  }
  if (!dryRun && result.retitled > 0) scheduleIndexSave();
  const last = ids[ids.length - 1];
  result.nextCursor = last !== undefined && start + ids.length < all.length ? last : null;
  logger.info("Observation retitle pass", { ...result, dryRun });
  return result;
}

export function registerObservationRetitle(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::observation-retitle", async (data?: RetitleOptions) => ({
    success: true,
    ...(await retitleObservations(kv, data ?? {})),
  }));
}
