import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";

// Summaries became indexable (commit 8a36a54) but the only path that fills
// the index for rows that already exist is a full rebuild, and a full
// rebuild re-embeds every observation in the store -- it ran past the
// invocation timeout on the live corpus and left no summaries indexed at
// all. This endpoint indexes summaries and nothing else: 440 rows against
// tens of thousands.

const SECRET = "index-summaries-secret";

const summary = (sessionId: string) => ({
  sessionId,
  project: "p1",
  title: `Summary of ${sessionId}`,
  narrative: "what happened",
  keyDecisions: ["a decision"],
  filesModified: [],
  concepts: [],
  observationCount: 2,
  createdAt: "2026-09-19T00:00:00.000Z",
});

function mockKV(rows: Record<string, unknown>) {
  const scopes = new Map<string, Map<string, unknown>>([[KV.summaries, new Map(Object.entries(rows))]]);
  return {
    get: async <T>(scope: string, key: string) => (scopes.get(scope)?.get(key) as T) ?? null,
    set: async () => {},
    delete: async () => {},
    update: async () => {},
    list: async <T>(scope: string): Promise<T[]> => Array.from(scopes.get(scope)?.values() ?? []) as T[],
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

async function call(secret = SECRET, rows: Record<string, unknown> = { s1: summary("s1"), s2: summary("s2") }) {
  const kv = mockKV(rows);
  const sdk = mockSdk();
  registerApiTriggers(sdk as never, kv as never, SECRET);
  return sdk._fns.get("api::index-summaries")!({
    headers: { authorization: `Bearer ${secret}` },
    body: {},
  });
}

describe("POST /agentmemory/search-index/summaries", () => {
  it("reports how many summaries it indexed", async () => {
    const res = await call();

    expect(res.status_code).toBe(200);
    expect(res.body.indexed).toBe(2);
    expect(res.body.summaries).toBe(2);
  });

  it("is happy with a store that has none", async () => {
    const res = await call(SECRET, {});

    expect(res.status_code).toBe(200);
    expect(res.body.indexed).toBe(0);
  });

  it("requires the secret", async () => {
    const res = await call("wrong");

    expect(res.status_code).toBe(401);
  });
});
