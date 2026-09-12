import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateKV } from "../src/state/kv.js";
import {
  getKvListStats,
  recordKvList,
  resetKvListStatsForTests,
} from "../src/state/kv-list-stats.js";

/**
 * Problem 1: state::list returns a scope as one message and every maintenance
 * path (reflect, decay, export, evict, snapshot, context fallback, ...) still
 * lists whole scopes. Which of them matter is a question of bytes × calls per
 * day, not of call sites in the source. This counter answers it from live
 * traffic: per scope, calls, rows, an estimated byte volume (rows × the first
 * row's JSON size) and the callers that asked; /health exposes the top rows.
 */
describe("kv list stats", () => {
  beforeEach(() => resetKvListStatsForTests());

  it("accumulates calls, rows and an estimated byte volume per scope, sorted by volume", () => {
    recordKvList("mem:sessions", [{ id: "s1", cwd: "D:/x" }, { id: "s2", cwd: "D:/y" }], "context.ts:120");
    recordKvList("mem:sessions", [{ id: "s1", cwd: "D:/x" }], "reflect.ts:40");
    recordKvList("mem:graph:nodes", new Array(1000).fill({ id: "n", name: "node", properties: {} }), "graph.ts:900");

    const stats = getKvListStats(10);
    expect(stats.map((s) => s.scope)).toEqual(["mem:graph:nodes", "mem:sessions"]);
    const sessions = stats[1];
    expect(sessions.calls).toBe(2);
    expect(sessions.rows).toBe(3);
    expect(sessions.maxRows).toBe(2);
    expect(sessions.estBytes).toBeGreaterThan(0);
    expect(sessions.callers).toEqual({ "context.ts:120": 1, "reflect.ts:40": 1 });
    expect(typeof sessions.lastAt).toBe("string");
  });

  it("caps the number of rows returned and the callers kept per scope", () => {
    for (let i = 0; i < 30; i += 1) recordKvList(`scope-${i}`, [{ i }], `caller-${i}.ts:1`);
    expect(getKvListStats(5)).toHaveLength(5);
    for (let i = 0; i < 40; i += 1) recordKvList("busy", [{ i }], `site-${i}.ts:1`);
    const busy = getKvListStats(50).find((s) => s.scope === "busy")!;
    // Eight named callers plus one overflow bucket.
    expect(Object.keys(busy.callers).length).toBe(9);
    expect(busy.callers["(other)"]).toBe(32);
    expect(busy.calls).toBe(40);
  });

  it("records every StateKV.list with the calling file and line", async () => {
    const rows = [{ id: "a" }, { id: "b" }];
    const trigger = vi.fn(async () => rows);
    const kv = new StateKV({ trigger } as never);

    const got = await kv.list("mem:obs:projections:active");
    expect(got).toBe(rows);

    const stat = getKvListStats(10).find((s) => s.scope === "mem:obs:projections:active");
    expect(stat).toBeDefined();
    expect(stat!.rows).toBe(2);
    const callers = Object.keys(stat!.callers);
    expect(callers).toHaveLength(1);
    expect(callers[0]).toMatch(/kv-list-stats\.test\.ts:\d+/);
  });
});
