import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompressedObservation, Session } from "../src/types.js";
import { KV } from "../src/state/schema.js";
import {
  getSearchIndex,
  indexRecords,
  registerSearchFunction,
  setIndexPersistence,
  setVectorIndex,
} from "../src/functions/search.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

function observation(id = "obs_runtime"): CompressedObservation {
  return {
    id,
    sessionId: "ses_runtime",
    timestamp: "2026-08-28T00:00:00.000Z",
    type: "conversation",
    title: "Runtime index mutation",
    facts: [],
    narrative: "A runtime mutation must schedule persistence",
    concepts: ["persistence"],
    files: [],
    importance: 5,
    projectId: "agentmemory",
    visibility: "project",
  };
}

afterEach(() => {
  setIndexPersistence(null);
  setVectorIndex(null);
  getSearchIndex().clear();
});

describe("runtime index persistence and reconcile", () => {
  it("schedules a snapshot after indexRecords adds runtime data", async () => {
    const scheduleSave = vi.fn();
    setIndexPersistence({
      scheduleSave,
      save: vi.fn(async () => true),
      getStatus: () => ({ dirty: true }),
    });

    await indexRecords([observation()], []);

    expect(scheduleSave).toHaveBeenCalledTimes(1);
  });

  it("rebuilds from canonical data and reports snapshot success", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const save = vi.fn(async () => true);
    setIndexPersistence({
      scheduleSave: vi.fn(),
      save,
      getStatus: () => ({ dirty: false }),
    });
    setVectorIndex(null);
    const session: Session = {
      id: "ses_runtime",
      project: "agentmemory",
      cwd: "/work/agentmemory",
      startedAt: "2026-08-28T00:00:00.000Z",
      status: "completed",
      observationCount: 1,
    };
    await kv.set(KV.sessions, session.id, session);
    await kv.set(KV.observations(session.id), "obs_runtime", observation());
    registerSearchFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::index-reconcile", {})) as {
      success: boolean;
      indexed: number;
    };

    expect(result).toMatchObject({ success: true, indexed: 1 });
    expect(save).toHaveBeenCalledTimes(1);
    expect(getSearchIndex().has("obs_runtime")).toBe(true);
  });

  it("does not report reconcile success when the snapshot save fails", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    setIndexPersistence({
      scheduleSave: vi.fn(),
      save: vi.fn(async () => false),
      getStatus: () => ({
        dirty: true,
        lastFailureAt: "2026-08-28T00:00:00.000Z",
      }),
    });
    registerSearchFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::index-reconcile", {})) as {
      success: boolean;
      error?: string;
    };

    expect(result).toMatchObject({
      success: false,
      error: "index_snapshot_failed",
    });
  });

  it("exposes reconcile through the authenticated REST surface", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    setIndexPersistence({
      scheduleSave: vi.fn(),
      save: vi.fn(async () => true),
      getStatus: () => ({ dirty: false }),
    });
    registerSearchFunction(sdk as never, kv as never);
    registerApiTriggers(sdk as never, kv as never);

    const result = (await sdk.trigger("api::index-reconcile", {})) as {
      status_code: number;
      body: { success: boolean };
    };

    expect(result).toMatchObject({
      status_code: 200,
      body: { success: true },
    });
  });
});
