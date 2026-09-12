// Read-side accounting for state::list, the one KV call that returns a whole
// scope as a single message. After the hot paths were rewritten (cycle A,
// 2026-09-11) every remaining whole-scope read lives in a maintenance path,
// and which of them matter is a question of bytes × calls on live traffic,
// not of call sites in the source. Each list records its scope, row count,
// an estimated byte volume and the calling file:line; /health shows the top
// scopes so the next index or paging change goes where the traffic is.

export type KvListStat = {
  scope: string;
  calls: number;
  rows: number;
  maxRows: number;
  /** rows × the first row's JSON size per call, summed. An estimate. */
  estBytes: number;
  lastAt: string;
  callers: Record<string, number>;
};

const MAX_SCOPES = 200;
const MAX_CALLERS_PER_SCOPE = 8;

const stats = new Map<string, KvListStat>();

export function recordKvList(scope: string, rows: unknown[], caller = "unknown"): void {
  const count = Array.isArray(rows) ? rows.length : 0;
  let rowBytes = 0;
  if (count > 0) {
    try {
      rowBytes = JSON.stringify(rows[0]).length + 2;
    } catch {
      rowBytes = 0;
    }
  }
  let stat = stats.get(scope);
  if (!stat) {
    if (stats.size >= MAX_SCOPES) return;
    stat = { scope, calls: 0, rows: 0, maxRows: 0, estBytes: 0, lastAt: "", callers: {} };
    stats.set(scope, stat);
  }
  stat.calls += 1;
  stat.rows += count;
  stat.maxRows = Math.max(stat.maxRows, count);
  stat.estBytes += count * rowBytes;
  stat.lastAt = new Date().toISOString();
  if (caller in stat.callers) {
    stat.callers[caller] += 1;
  } else if (Object.keys(stat.callers).length < MAX_CALLERS_PER_SCOPE) {
    stat.callers[caller] = 1;
  } else {
    stat.callers["(other)"] = (stat.callers["(other)"] ?? 0) + 1;
  }
}

/** Top scopes by estimated byte volume. */
export function getKvListStats(limit = 20): KvListStat[] {
  return [...stats.values()]
    .sort((a, b) => b.estBytes - a.estBytes || b.calls - a.calls)
    .slice(0, Math.max(0, limit))
    .map((stat) => ({ ...stat, callers: { ...stat.callers } }));
}

export function resetKvListStatsForTests(): void {
  stats.clear();
}

/** The first stack frame outside the KV layer, as "file.ts:line". */
export function kvListCaller(): string {
  const stack = new Error().stack?.split("\n") ?? [];
  for (const line of stack.slice(1)) {
    if (/kv\.ts|kv-list-stats\.ts|node:internal|<anonymous>$/.test(line) && !/\.test\./.test(line)) continue;
    const match = /([^/\\(\s]+?\.(?:[cm]?[jt]s)):(\d+)/.exec(line);
    if (match) return `${match[1]}:${match[2]}`;
  }
  return "unknown";
}
