import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";

// Read-only view of the per-project relations index, for diagnosing relation
// quality (2026-09-19: counting how many graph nodes one judgment topic is
// split across). The context path renders only 12 lines of a row; the whole
// row was not reachable without reading the store directly.

const SECRET = "relations-index-secret";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(s: string, k: string) => (store.get(s)?.get(k) as T) ?? null,
    set: async <T>(s: string, k: string, d: T) => {
      if (!store.has(s)) store.set(s, new Map());
      store.get(s)!.set(k, d);
      return d;
    },
    delete: async () => {},
    update: async () => {},
    list: async <T>(scope: string): Promise<T[]> => Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}
function mockSdk() {
  const fns = new Map<string, Function>();
  return {
    registerFunction: (id: string, h: Function) => fns.set(id, h),
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload?: unknown }) => fns.get(input.function_id)?.(input.payload),
    _fns: fns,
  };
}
const row = (project: string) => ({
  project,
  updatedAt: "2026-09-19T00:00:00.000Z",
  relations: [{ source: "branch sync method", type: "prefers", target: "fast-forward-only merge", weight: 0.8, backing: 1, edgeId: `e-${project}` }],
});

async function read(project?: string, secret = SECRET) {
  const kv = mockKV();
  await kv.set(KV.graphRelationsIndex, "p1", row("p1"));
  await kv.set(KV.graphRelationsIndex, "p2", row("p2"));
  const sdk = mockSdk();
  registerApiTriggers(sdk as never, kv as never, SECRET);
  return sdk._fns.get("api::graph-relations-index-read")!({
    headers: { authorization: `Bearer ${secret}` },
    query_params: project ? { project } : {},
  });
}

describe("api::graph-relations-index-read", () => {
  it("returns one project's row", async () => {
    const res = await read("p1");
    expect(res.status_code).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].project).toBe("p1");
    expect(res.body.rows[0].relations[0].type).toBe("prefers");
  });

  it("returns every project's row when none is named", async () => {
    const res = await read();
    expect(res.status_code).toBe(200);
    expect(res.body.rows.map((r: { project: string }) => r.project).sort()).toEqual(["p1", "p2"]);
  });

  it("returns an empty list for a project with no row", async () => {
    const res = await read("nowhere");
    expect(res.body.rows).toEqual([]);
  });

  it("requires the secret", async () => {
    const res = await read("p1", "wrong");
    expect(res.status_code).toBe(401);
  });
});
