import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";

// GET /agentmemory/sessions?limit=N read every session row AND every summary
// row before keeping N of them. On the live store that is the second and
// third largest whole-scope read of the day (sessions 683 rows / 0.36 MB,
// summaries 440 rows / 0.4 MB, 2026-09-20), and the caller asked for ten.
//
// With a limit and no agent filter the rows come through StateKV.listPage and
// each kept session's summary through one get. Everything else -- no limit,
// an agent filter, the legacy summary fallback -- keeps the old path, because
// those decide what to keep by looking at every row.

const SECRET = "sessions-bounded-secret";

const session = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  project: "p1",
  cwd: "/repo/p1",
  startedAt: "2026-09-20T00:00:00.000Z",
  status: "completed",
  observationCount: 1,
  ...extra,
});

function mockKV(sessions: Record<string, unknown>, summaries: Record<string, unknown>) {
  const scopes = new Map<string, Map<string, unknown>>([
    [KV.sessions, new Map(Object.entries(sessions))],
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

const manySessions = Object.fromEntries(
  Array.from({ length: 5 }, (_, i) => [`ses_${i}`, session(`ses_${i}`)]),
);
const manySummaries = Object.fromEntries(
  Array.from({ length: 5 }, (_, i) => [
    `ses_${i}`,
    { sessionId: `ses_${i}`, title: `summary ${i}`, keyDecisions: [], narrative: "", project: "p1" },
  ]),
);

async function read(query: Record<string, string>, sessions = manySessions, summaries = manySummaries) {
  const kv = mockKV(sessions, summaries);
  const listed: string[] = [];
  const originalList = kv.list;
  kv.list = (async (scope: string) => {
    listed.push(scope);
    return originalList(scope);
  }) as typeof kv.list;
  const sdk = mockSdk();
  registerApiTriggers(sdk as never, kv as never, SECRET);
  const res = await sdk._fns.get("api::sessions")!({
    headers: { authorization: `Bearer ${SECRET}` },
    query_params: query,
  });
  return { res, listed };
}

describe("GET /agentmemory/sessions bounded read", () => {
  it("reads a window and one summary per kept session", async () => {
    const { res, listed } = await read({ limit: "2" });

    expect(res.status_code).toBe(200);
    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.sessions[0].summary.title).toBe("summary 0");
    expect(listed).not.toContain(KV.sessions);
    expect(listed).not.toContain(KV.summaries);
  });

  it("keeps a session that has no summary", async () => {
    const { res } = await read({ limit: "2" }, manySessions, {});

    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.sessions[0].summary).toBeUndefined();
  });

  it("reads everything when no limit is given, as before", async () => {
    const { res, listed } = await read({});

    expect(res.body.sessions).toHaveLength(5);
    expect(listed).toContain(KV.sessions);
  });

  it("keeps the whole-scope read when an agent filter is in play", async () => {
    const { listed } = await read({ limit: "2", agentId: "agent_a" });

    expect(listed).toContain(KV.sessions);
  });

  it("still refuses a limit that is not a positive integer", async () => {
    const { res } = await read({ limit: "0" });

    expect(res.status_code).toBe(400);
  });

  it("skips rows that are not valid sessions", async () => {
    const { res } = await read({ limit: "3" }, {
      ses_bad: { id: "ses_bad" },
      ses_good: session("ses_good"),
    }, {});

    expect(res.body.sessions.map((s: { id: string }) => s.id)).toEqual(["ses_good"]);
  });
});
