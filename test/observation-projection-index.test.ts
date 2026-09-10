import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  writeObservationProjection,
  listActiveProjections,
  rebuildActiveProjectionIndex,
} from "../src/functions/observation-projection-index.js";
import { KV } from "../src/state/schema.js";
import type { ObservationProjection } from "../src/types.js";

// mem:obs:projections holds 58,651 rows (12.8 MB) on the live store, nearly
// all succeeded. Three readers listed the whole scope to find the few that
// are not -- the drain refresh, health reconcile every 30 s, and the retry
// scheduler -- and state::list has no pagination. The active index is the
// non-succeeded subset in the same shape.

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const listed: string[] = [];
  return {
    listed,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      listed.push(scope);
      return Array.from(store.get(scope)?.values() ?? []) as T[];
    },
  };
}

function row(id: string, status: ObservationProjection["status"], attempts = 0): ObservationProjection {
  return { observationId: id, captureId: `cap_${id}`, sessionId: "ses_1", status, attempts, updatedAt: "2026-09-11T00:00:00Z" };
}

describe("observation projection active index", () => {
  it("is its own scope beside the full projection scope", () => {
    expect(KV.observationProjectionsActive).toBe("mem:obs:projections:active");
    expect(KV.observationProjectionsActive).not.toBe(KV.observationProjections);
  });

  it("keeps non-succeeded rows in the index and drops a row once it succeeds", async () => {
    const kv = mockKV();
    await writeObservationProjection(kv as never, row("o1", "pending"));
    await writeObservationProjection(kv as never, row("o2", "failed", 3));
    expect(await kv.get(KV.observationProjectionsActive, "o1")).toMatchObject({ status: "pending" });
    expect(await kv.get(KV.observationProjectionsActive, "o2")).toMatchObject({ status: "failed" });

    await writeObservationProjection(kv as never, row("o1", "succeeded", 1));
    expect(await kv.get(KV.observationProjections, "o1")).toMatchObject({ status: "succeeded" });
    expect(await kv.get(KV.observationProjectionsActive, "o1")).toBeNull();
  });

  it("builds the index from the full scope on the first read, then reads only the index", async () => {
    const kv = mockKV();
    // A store that predates the index: rows exist, index does not.
    await kv.set(KV.observationProjections, "a", row("a", "succeeded"));
    await kv.set(KV.observationProjections, "b", row("b", "pending"));
    await kv.set(KV.observationProjections, "c", row("c", "failed", 2));
    await kv.set(KV.observationProjections, "d", row("d", "running", 1));

    const first = await listActiveProjections(kv as never);
    expect(first.map((r) => r.observationId).sort()).toEqual(["b", "c", "d"]);
    expect(kv.listed).toContain(KV.observationProjections);

    kv.listed.length = 0;
    const second = await listActiveProjections(kv as never);
    expect(second.map((r) => r.observationId).sort()).toEqual(["b", "c", "d"]);
    expect(kv.listed).toEqual([KV.observationProjectionsActive]);
  });

  it("does not hand the built marker back as a row", async () => {
    const kv = mockKV();
    await kv.set(KV.observationProjections, "b", row("b", "pending"));
    const rows = await listActiveProjections(kv as never);
    expect(rows).toHaveLength(1);
    expect(rows[0].observationId).toBe("b");
  });

  it("no source file writes the full projection scope except through the helper", () => {
    // A direct write leaves the index stale and the readers blind to that
    // row. The helper is the only writer; this test keeps it that way.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".ts") && !name.startsWith("_")) {
          const text = readFileSync(path, "utf8");
          if (
            /kv\s*\.set\(\s*KV\.observationProjections\b/.test(text) &&
            !path.endsWith("observation-projection-index.ts")
          ) {
            offenders.push(name);
          }
        }
      }
    };
    walk(fileURLToPath(new URL("../src", import.meta.url)));
    expect(offenders).toEqual([]);
  });

  it("rebuild replaces a stale index and reports what it scanned", async () => {
    const kv = mockKV();
    await kv.set(KV.observationProjectionsActive, "gone", row("gone", "pending"));
    await kv.set(KV.observationProjections, "x", row("x", "pending"));
    await kv.set(KV.observationProjections, "y", row("y", "succeeded"));
    const result = await rebuildActiveProjectionIndex(kv as never);
    expect(result).toEqual({ scanned: 2, active: 1 });
    const rows = await listActiveProjections(kv as never);
    expect(rows.map((r) => r.observationId)).toEqual(["x"]);
  });
});
