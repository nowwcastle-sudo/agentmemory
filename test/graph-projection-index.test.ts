import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  graphProjectionKey,
  listActiveGraphProjections,
  rebuildActiveGraphProjectionIndex,
  writeGraphProjection,
} from "../src/functions/graph-projection-index.js";
import { KV } from "../src/state/schema.js";
import type { GraphProjection } from "../src/types.js";

/**
 * The first reading of the state::list accounting (2026-09-12 12:23, ninety
 * seconds after boot) put mem:graph:projections on top: 130,526 rows, 46.6 MB,
 * listed twice already — the health monitor and the retry scheduler read the
 * whole scope every 30 s to find the handful of rows that are not succeeded.
 * Same shape as the observation projections fixed in cycle A, same fix: an
 * index scope of the non-succeeded rows kept by the one writer.
 */
function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const listed: string[] = [];
  return {
    listed,
    get: async <T,>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T,>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T,>(scope: string): Promise<T[]> => {
      listed.push(scope);
      return Array.from(store.get(scope)?.values() ?? []) as T[];
    },
  };
}

function row(sourceId: string, status: GraphProjection["status"], attempts = 0): GraphProjection {
  return {
    sourceKind: "observation",
    sourceId,
    projectId: "proj",
    visibility: "private",
    status,
    attempts,
    updatedAt: "2026-09-12T03:00:00Z",
  } as GraphProjection;
}

describe("graph projection active index", () => {
  it("derives the row key the writer uses and keeps a separate scope", () => {
    expect(graphProjectionKey(row("obs_1", "pending"))).toBe("observation:obs_1");
    expect(KV.graphProjectionsActive).toBe("mem:graph:projections:active");
    expect(KV.graphProjectionsActive).not.toBe(KV.graphProjections);
  });

  it("keeps non-succeeded rows in the index and drops a row once it succeeds", async () => {
    const kv = mockKV();
    await writeGraphProjection(kv as never, "observation:obs_1", row("obs_1", "pending"));
    await writeGraphProjection(kv as never, "observation:obs_2", row("obs_2", "failed", 3));
    await writeGraphProjection(kv as never, "observation:obs_3", row("obs_3", "succeeded"));
    const canonical = await kv.list<GraphProjection>(KV.graphProjections);
    expect(canonical).toHaveLength(3);
    const active = await kv.list<GraphProjection>(KV.graphProjectionsActive);
    expect(active.map((r) => r.sourceId).sort()).toEqual(["obs_1", "obs_2"]);

    await writeGraphProjection(kv as never, "observation:obs_1", row("obs_1", "succeeded", 1));
    expect((await kv.list<GraphProjection>(KV.graphProjectionsActive)).map((r) => r.sourceId)).toEqual(["obs_2"]);
  });

  it("builds the index from the full scope on the first read, then reads only the index", async () => {
    const kv = mockKV();
    await kv.set(KV.graphProjections, "observation:a", row("a", "succeeded"));
    await kv.set(KV.graphProjections, "observation:b", row("b", "pending"));
    await kv.set(KV.graphProjections, "observation:c", row("c", "running"));

    const first = await listActiveGraphProjections(kv as never);
    expect(first.map((r) => r.sourceId).sort()).toEqual(["b", "c"]);
    expect(kv.listed).toContain(KV.graphProjections);

    kv.listed.length = 0;
    const second = await listActiveGraphProjections(kv as never);
    expect(second.map((r) => r.sourceId).sort()).toEqual(["b", "c"]);
    expect(kv.listed).not.toContain(KV.graphProjections);
    expect(second.every((r) => typeof r.sourceId === "string")).toBe(true);
  });

  it("drops an index row whose canonical row has already succeeded", async () => {
    const kv = mockKV();
    await rebuildActiveGraphProjectionIndex(kv as never);
    await kv.set(KV.graphProjectionsActive, "observation:x", row("x", "running"));
    await kv.set(KV.graphProjections, "observation:x", row("x", "succeeded", 2));
    expect(await listActiveGraphProjections(kv as never)).toEqual([]);
    expect(await kv.get(KV.graphProjectionsActive, "observation:x")).toBeNull();
  });

  it("no source file writes the full graph projection scope except through the helper", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".ts") && !name.startsWith("_")) {
          const text = readFileSync(path, "utf8");
          if (
            /kv\s*\.set\(\s*KV\.graphProjections\b/.test(text) &&
            !path.endsWith("graph-projection-index.ts")
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
    await kv.set(KV.graphProjections, "observation:a", row("a", "pending"));
    await kv.set(KV.graphProjections, "observation:b", row("b", "succeeded"));
    await kv.set(KV.graphProjectionsActive, "observation:zombie", row("zombie", "running"));
    const report = await rebuildActiveGraphProjectionIndex(kv as never);
    expect(report).toEqual({ scanned: 2, active: 1 });
    expect((await listActiveGraphProjections(kv as never)).map((r) => r.sourceId)).toEqual(["a"]);
  });
});
