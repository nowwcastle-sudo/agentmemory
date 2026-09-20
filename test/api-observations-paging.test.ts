import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";

// GET /agentmemory/observations read the session's whole scope and returned
// all of it; there was no limit to give. One live session answers 59.2 MB
// that way (6,890 rows, 2026-09-20), and `state::list` has no pagination --
// but the state worker does serve `state::list_keys`, so a bounded read is
// possible: keys, then a get per row in the window (StateKV.listPage).
//
// The agent filter still needs every row to decide what is visible, so a
// filtered read keeps the old whole-scope path; that is the fail-safe
// direction -- correct and slow rather than fast and short.

const SECRET = "observations-paging-secret";

function mockKV(rows: Record<string, unknown>) {
  const scopes = new Map<string, Map<string, unknown>>();
  scopes.set(KV.observations("ses_1"), new Map(Object.entries(rows)));
  return {
    get: async <T>(scope: string, key: string) => (scopes.get(scope)?.get(key) as T) ?? null,
    set: async () => {},
    delete: async () => {},
    update: async () => {},
    list: async <T>(scope: string): Promise<T[]> => Array.from(scopes.get(scope)?.values() ?? []) as T[],
    listKeys: async (scope: string) => Array.from(scopes.get(scope)?.keys() ?? []),
    listPage: async <T>(scope: string, { offset = 0, limit = 100 } = {}) => {
      const keys = Array.from(scopes.get(scope)?.keys() ?? []);
      const window = keys.slice(offset, offset + limit);
      return {
        rows: window.map((k) => scopes.get(scope)!.get(k) as T),
        total: keys.length,
        hasMore: offset + window.length < keys.length,
      };
    },
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

const rows = Object.fromEntries(
  Array.from({ length: 5 }, (_, i) => [`obs_${i}`, { id: `obs_${i}`, title: `observation ${i}` }]),
);

async function read(query: Record<string, string>) {
  const kv = mockKV(rows);
  const listSpy = vi.spyOn(kv, "list");
  const sdk = mockSdk();
  registerApiTriggers(sdk as never, kv as never, SECRET);
  const res = await sdk._fns.get("api::observations")!({
    headers: { authorization: `Bearer ${SECRET}` },
    query_params: query,
  });
  return { res, listSpy };
}

describe("GET /agentmemory/observations paging", () => {
  it("returns a window without reading the whole scope", async () => {
    const { res, listSpy } = await read({ sessionId: "ses_1", limit: "2", offset: "1" });

    expect(res.status_code).toBe(200);
    expect(res.body.observations.map((o: { id: string }) => o.id)).toEqual(["obs_1", "obs_2"]);
    expect(res.body.total).toBe(5);
    expect(res.body.hasMore).toBe(true);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("says when the window reached the end", async () => {
    const { res } = await read({ sessionId: "ses_1", limit: "10" });

    expect(res.body.observations).toHaveLength(5);
    expect(res.body.hasMore).toBe(false);
  });

  it("returns everything when no limit is given, as before", async () => {
    const { res, listSpy } = await read({ sessionId: "ses_1" });

    expect(res.body.observations).toHaveLength(5);
    expect(res.body.total).toBeUndefined();
    expect(listSpy).toHaveBeenCalled();
  });

  it("refuses a limit that is not a positive number", async () => {
    const { res } = await read({ sessionId: "ses_1", limit: "-3" });

    expect(res.status_code).toBe(400);
  });

  it("keeps the whole-scope read when an agent filter is in play", async () => {
    const { res, listSpy } = await read({ sessionId: "ses_1", limit: "2", agentId: "agent_a" });

    expect(listSpy).toHaveBeenCalled();
    expect(res.status_code).toBe(200);
  });
});
