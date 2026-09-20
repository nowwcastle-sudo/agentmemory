import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";

// The prompt hook needs one fact about one session -- how many observations
// it has, to tell a session's first prompt from its twentieth. It was asking
// for 200 session rows and searching them, which is the whole-scope habit
// this store spent today removing, and it fails silently: a session outside
// those 200 is simply not found and nothing is injected. Measured on the
// live store, the session under test was not in the first 200.
//
// `?sessionId=` answers from one get.

const SECRET = "sessions-by-id-secret";

const session = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  project: "p1",
  cwd: "/repo/p1",
  startedAt: "2026-09-20T00:00:00.000Z",
  status: "completed",
  observationCount: 3,
  ...extra,
});

function mockKV(rows: Record<string, unknown>, summaries: Record<string, unknown> = {}) {
  const scopes = new Map<string, Map<string, unknown>>([
    [KV.sessions, new Map(Object.entries(rows))],
    [KV.summaries, new Map(Object.entries(summaries))],
  ]);
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
    trigger: async () => null,
    _fns: fns,
  };
}

async function read(query: Record<string, string>) {
  const kv = mockKV(
    { ses_1: session("ses_1"), ses_2: session("ses_2", { observationCount: 0 }) },
    { ses_1: { sessionId: "ses_1", title: "First session", keyDecisions: [], narrative: "", project: "p1" } },
  );
  const listSpy = vi.spyOn(kv, "list");
  const pageSpy = vi.spyOn(kv, "listPage");
  const sdk = mockSdk();
  registerApiTriggers(sdk as never, kv as never, SECRET);
  const res = await sdk._fns.get("api::sessions")!({
    headers: { authorization: `Bearer ${SECRET}` },
    query_params: query,
  });
  return { res, listSpy, pageSpy };
}

describe("GET /agentmemory/sessions?sessionId=", () => {
  it("answers one session without listing or paging", async () => {
    const { res, listSpy, pageSpy } = await read({ sessionId: "ses_2" });

    expect(res.status_code).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0].id).toBe("ses_2");
    expect(res.body.sessions[0].observationCount).toBe(0);
    expect(listSpy).not.toHaveBeenCalled();
    expect(pageSpy).not.toHaveBeenCalled();
  });

  it("carries the summary when there is one", async () => {
    const { res } = await read({ sessionId: "ses_1" });

    expect(res.body.sessions[0].summary.title).toBe("First session");
  });

  it("answers an empty list for a session that does not exist", async () => {
    const { res } = await read({ sessionId: "nowhere" });

    expect(res.status_code).toBe(200);
    expect(res.body.sessions).toEqual([]);
  });

  it("still lists when no sessionId is given", async () => {
    const { res, listSpy } = await read({});

    expect(res.body.sessions).toHaveLength(2);
    expect(listSpy).toHaveBeenCalled();
  });
});
