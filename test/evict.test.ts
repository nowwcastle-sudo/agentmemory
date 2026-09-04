import { describe, expect, it, vi } from "vitest";
import type {
  CompressedObservation,
  RawObservation,
  Session,
  SessionSummary,
} from "../src/types.js";
import { registerEvictFunction } from "../src/functions/evict.js";
import { KV } from "../src/state/schema.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type Store = Map<string, Map<string, unknown>>;
type Handler = (payload: unknown) => unknown | Promise<unknown>;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeSession(id: string): Session {
  return {
    id,
    project: "agentmemory",
    cwd: "/repo/agentmemory",
    startedAt: daysAgo(31),
    status: "active",
    observationCount: 1,
  };
}

function makeObservation(sessionId: string): CompressedObservation {
  return {
    id: "obs_1",
    sessionId,
    timestamp: daysAgo(31),
    type: "decision",
    title: "Chose durable local storage",
    facts: ["Keep the session until enrichment succeeds"],
    narrative: "The session chose durable local storage.",
    concepts: ["durability"],
    files: ["src/functions/evict.ts"],
    importance: 8,
  };
}

function makeSummary(
  sessionId: string,
  sourceFingerprint?: string,
): SessionSummary {
  return {
    sessionId,
    project: "agentmemory",
    createdAt: daysAgo(30),
    title: "Durable session summary",
    narrative: "The terminal projection completed.",
    keyDecisions: [],
    filesModified: [],
    concepts: ["durability"],
    observationCount: 1,
    sourceFingerprint,
    coveredObservationIds: ["obs_1"],
  };
}

function makeRawObservation(sessionId: string): RawObservation {
  return {
    id: "raw_1",
    sessionId,
    timestamp: daysAgo(31),
    hookType: "post_tool_use",
    toolName: "Edit",
    raw: { file_path: "src/functions/evict.ts" },
  };
}

function mockKV(store: Store, listFailures: Set<string> = new Set()) {
  return {
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
      if (listFailures.has(scope)) throw new Error(`list failed for ${scope}`);
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const handlers = new Map<string, Handler>();
  const calls: Array<{ function_id: string; payload: unknown }> = [];
  return {
    calls,
    sdk: {
      registerFunction: (functionId: string, handler: Handler) => {
        handlers.set(functionId, handler);
      },
      trigger: async (input: { function_id: string; payload: unknown }) => {
        calls.push(input);
        const handler = handlers.get(input.function_id);
        if (!handler) throw new Error(`missing handler: ${input.function_id}`);
        return handler(input.payload);
      },
    },
  };
}

function storeForObservations(
  sessionId: string,
  observations: Array<CompressedObservation | RawObservation>,
): Store {
  const session = makeSession(sessionId);
  return new Map([
    [KV.sessions, new Map([[session.id, session]])],
    [KV.summaries, new Map()],
    [KV.sessionProjections, new Map()],
    [
      KV.observations(session.id),
      new Map(observations.map((observation) => [observation.id, observation])),
    ],
    [KV.config, new Map()],
    [KV.audit, new Map()],
  ]);
}

function storeForObservedSession(sessionId: string): Store {
  return storeForObservations(sessionId, [makeObservation(sessionId)]);
}

describe("mem::evict stale sessions", () => {
  it("queues terminal recovery first and deletes only after a later succeeded sweep", async () => {
    const sessionId = "ses_stale";
    const store = storeForObservedSession(sessionId);
    const kv = mockKV(store);
    const { sdk, calls } = mockSdk();

    registerEvictFunction(sdk as never, kv as never);
    sdk.registerFunction("event::session::ended", async (payload) => {
      expect(payload).toEqual({ sessionId, evictAfterSuccess: true });
      expect(await kv.get(KV.sessions, sessionId)).toMatchObject({
        id: sessionId,
      });
      return { success: true, projectionQueued: true };
    });

    const first = (await sdk.trigger({
      function_id: "mem::evict",
      payload: {},
    })) as { staleSessions: number };

    expect(first.staleSessions).toBe(0);
    expect(await kv.get(KV.sessions, sessionId)).toMatchObject({ id: sessionId });
    expect(await kv.list(KV.audit)).toHaveLength(0);
    expect(calls.map((call) => call.function_id)).toContain(
      "event::session::ended",
    );

    await kv.set(KV.sessionProjections, sessionId, {
      sessionId,
      status: "succeeded",
      attempts: 1,
      observationCount: 1,
      updatedAt: new Date().toISOString(),
      sourceFingerprint: "sha256:terminal",
      evictAfterSuccess: true,
      terminalOutcome: "summary_written",
    });
    await kv.set(
      KV.summaries,
      sessionId,
      makeSummary(sessionId, "sha256:terminal"),
    );
    const second = (await sdk.trigger({
      function_id: "mem::evict",
      payload: {},
    })) as { staleSessions: number };

    expect(second.staleSessions).toBe(1);
    expect(await kv.get(KV.sessions, sessionId)).toBeNull();
    const audits = await kv.list<{ details: { reason: string } }>(KV.audit);
    expect(audits[0].details.reason).toBe(
      "stale_session_projection_succeeded_then_evicted",
    );
  });

  it("deletes only exact written-summary or legacy fingerprint matches", async () => {
    const preserved = [
      "skip_auto",
      "skip_no_provider",
      "missing_summary",
      "missing_projection_fingerprint",
      "missing_summary_fingerprint",
      "mismatch",
      "empty_fingerprints",
    ];
    const deleted = ["written_exact", "legacy_exact"];
    const ids = [...preserved, ...deleted];
    const store: Store = new Map([
      [KV.sessions, new Map(ids.map((id) => [id, makeSession(id)]))],
      [KV.summaries, new Map()],
      [KV.sessionProjections, new Map()],
      [KV.config, new Map()],
      [KV.audit, new Map()],
    ]);
    for (const id of ids) {
      store.set(KV.observations(id), new Map([["obs_1", makeObservation(id)]]));
    }
    const kv = mockKV(store);
    const { sdk } = mockSdk();
    registerEvictFunction(sdk as never, kv as never);
    sdk.registerFunction("event::session::ended", () => ({ success: true }));

    const projections = [
      {
        sessionId: "skip_auto",
        sourceFingerprint: "fp-skip-auto",
        terminalOutcome: "skipped_automatic_enrichment",
      },
      {
        sessionId: "skip_no_provider",
        sourceFingerprint: "fp-skip-provider",
        terminalOutcome: "skipped_no_provider",
      },
      {
        sessionId: "missing_summary",
        sourceFingerprint: "fp-missing-summary",
        terminalOutcome: "summary_written",
      },
      {
        sessionId: "missing_projection_fingerprint",
        terminalOutcome: "summary_written",
      },
      {
        sessionId: "missing_summary_fingerprint",
        sourceFingerprint: "fp-missing-summary-fingerprint",
        terminalOutcome: "summary_written",
      },
      {
        sessionId: "mismatch",
        sourceFingerprint: "fp-projection",
        terminalOutcome: "summary_written",
      },
      {
        sessionId: "empty_fingerprints",
        sourceFingerprint: "",
        terminalOutcome: "summary_written",
      },
      {
        sessionId: "written_exact",
        sourceFingerprint: "fp-written",
        terminalOutcome: "summary_written",
      },
      {
        sessionId: "legacy_exact",
        sourceFingerprint: "fp-legacy",
      },
    ];
    for (const projection of projections) {
      await kv.set(KV.sessionProjections, projection.sessionId, {
        ...projection,
        status: "succeeded",
        attempts: 1,
        observationCount: 1,
        updatedAt: daysAgo(30),
        evictAfterSuccess: true,
      });
    }
    for (const [sessionId, sourceFingerprint] of [
      ["skip_auto", "fp-skip-auto"],
      ["skip_no_provider", "fp-skip-provider"],
      ["missing_projection_fingerprint", "fp-present"],
      ["missing_summary_fingerprint", undefined],
      ["mismatch", "fp-summary"],
      ["empty_fingerprints", ""],
      ["written_exact", "fp-written"],
      ["legacy_exact", "fp-legacy"],
    ] as const) {
      await kv.set(
        KV.summaries,
        sessionId,
        makeSummary(sessionId, sourceFingerprint),
      );
    }

    const dryRun = (await sdk.trigger({
      function_id: "mem::evict",
      payload: { dryRun: true },
    })) as { staleSessions: number };
    expect(dryRun.staleSessions).toBe(2);
    for (const id of ids) {
      expect(await kv.get(KV.sessions, id)).toMatchObject({ id });
    }

    const result = (await sdk.trigger({
      function_id: "mem::evict",
      payload: {},
    })) as { staleSessions: number };

    expect(result.staleSessions).toBe(2);
    for (const id of preserved) {
      expect(await kv.get(KV.sessions, id)).toMatchObject({ id });
    }
    for (const id of deleted) {
      expect(await kv.get(KV.sessions, id)).toBeNull();
    }
  });

  it("preserves zero-observation sessions whenever any incomplete projection row exists", async () => {
    const ids = ["zero_skip", "zero_missing_summary"];
    const store: Store = new Map([
      [KV.sessions, new Map(ids.map((id) => [id, makeSession(id)]))],
      [KV.summaries, new Map()],
      [KV.sessionProjections, new Map()],
      [KV.config, new Map()],
      [KV.audit, new Map()],
    ]);
    for (const id of ids) store.set(KV.observations(id), new Map());
    const kv = mockKV(store);
    const { sdk, calls } = mockSdk();
    registerEvictFunction(sdk as never, kv as never);
    sdk.registerFunction("event::session::ended", () => ({ success: true }));
    await kv.set(KV.sessionProjections, "zero_skip", {
      sessionId: "zero_skip",
      status: "succeeded",
      attempts: 1,
      observationCount: 0,
      sourceFingerprint: "fp-zero-skip",
      terminalOutcome: "skipped_automatic_enrichment",
      terminalReason: "automatic_enrichment_disabled",
      updatedAt: daysAgo(30),
      evictAfterSuccess: true,
    });
    await kv.set(KV.sessionProjections, "zero_missing_summary", {
      sessionId: "zero_missing_summary",
      status: "succeeded",
      attempts: 1,
      observationCount: 0,
      sourceFingerprint: "fp-zero-missing",
      terminalOutcome: "summary_written",
      updatedAt: daysAgo(30),
      evictAfterSuccess: true,
    });

    const dryRun = (await sdk.trigger({
      function_id: "mem::evict",
      payload: { dryRun: true },
    })) as { staleSessions: number };
    expect(dryRun.staleSessions).toBe(0);

    const result = (await sdk.trigger({
      function_id: "mem::evict",
      payload: {},
    })) as { staleSessions: number };
    expect(result.staleSessions).toBe(0);
    for (const id of ids) {
      expect(await kv.get(KV.sessions, id)).toMatchObject({ id });
    }
    expect(calls.map((call) => call.function_id)).not.toContain(
      "event::session::ended",
    );
  });

  it("queues every stale session without inline consolidation amplification", async () => {
    const ids = ["ses_a", "ses_b", "ses_c"];
    const store: Store = new Map([
      [KV.sessions, new Map(ids.map((id) => [id, makeSession(id)]))],
      [KV.summaries, new Map()],
      [KV.sessionProjections, new Map()],
      [KV.config, new Map()],
      [KV.audit, new Map()],
    ]);
    for (const id of ids) {
      store.set(KV.observations(id), new Map([["obs_1", makeObservation(id)]]));
    }
    const kv = mockKV(store);
    const { sdk, calls } = mockSdk();
    const endedPayloads: unknown[] = [];

    registerEvictFunction(sdk as never, kv as never);
    sdk.registerFunction("event::session::ended", (payload) => {
      endedPayloads.push(payload);
      return { success: true, projectionQueued: true };
    });

    const result = (await sdk.trigger({
      function_id: "mem::evict",
      payload: {},
    })) as { staleSessions: number };

    expect(result.staleSessions).toBe(0);
    expect(endedPayloads).toHaveLength(3);
    for (const id of ids) {
      expect(endedPayloads).toContainEqual({
        sessionId: id,
        evictAfterSuccess: true,
      });
      expect(await kv.get(KV.sessions, id)).toMatchObject({ id });
    }
    const fnIds = calls.map((call) => call.function_id);
    expect(fnIds).not.toContain("mem::consolidate-pipeline");
    expect(fnIds).not.toContain("mem::auto-crystallize");
  });

  it("keeps a stale observed session when terminal queueing fails", async () => {
    const sessionId = "ses_unrecovered";
    const store = storeForObservedSession(sessionId);
    const kv = mockKV(store);
    const { sdk, calls } = mockSdk();

    registerEvictFunction(sdk as never, kv as never);
    sdk.registerFunction("event::session::ended", () => ({
      success: false,
      error: "queue_unavailable",
    }));

    const result = (await sdk.trigger({
      function_id: "mem::evict",
      payload: {},
    })) as { staleSessions: number };

    expect(result.staleSessions).toBe(0);
    expect(await kv.get(KV.sessions, sessionId)).toMatchObject({ id: sessionId });
    expect(calls.map((call) => call.function_id)).toContain(
      "event::session::ended",
    );
  });

  it("keeps a stale session when observation scanning fails", async () => {
    const sessionId = "ses_scan_failed";
    const store = storeForObservedSession(sessionId);
    const kv = mockKV(store, new Set([KV.observations(sessionId)]));
    const { sdk, calls } = mockSdk();

    registerEvictFunction(sdk as never, kv as never);
    sdk.registerFunction("event::session::ended", () => ({ success: true }));

    const result = (await sdk.trigger({
      function_id: "mem::evict",
      payload: {},
    })) as { staleSessions: number };

    expect(result.staleSessions).toBe(0);
    expect(await kv.get(KV.sessions, sessionId)).toMatchObject({ id: sessionId });
    expect(calls.map((call) => call.function_id)).not.toContain(
      "event::session::ended",
    );
  });

  it("keeps a stale session that only has raw observations", async () => {
    const sessionId = "ses_raw_only";
    const store = storeForObservations(sessionId, [makeRawObservation(sessionId)]);
    const kv = mockKV(store);
    const { sdk, calls } = mockSdk();

    registerEvictFunction(sdk as never, kv as never);
    sdk.registerFunction("event::session::ended", () => ({ success: true }));

    const result = (await sdk.trigger({
      function_id: "mem::evict",
      payload: {},
    })) as { staleSessions: number };

    expect(result.staleSessions).toBe(0);
    expect(await kv.get(KV.sessions, sessionId)).toMatchObject({ id: sessionId });
    expect(calls.map((call) => call.function_id)).not.toContain(
      "event::session::ended",
    );
  });
});
