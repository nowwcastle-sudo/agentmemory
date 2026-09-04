import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KV } from "../src/state/schema.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import { registerObservationProjectionFunction } from "../src/functions/observation-projection.js";
import { ProjectionCoordinator } from "../src/functions/projection-coordinator.js";
import {
  getSearchIndex,
  setEmbeddingProvider,
  setVectorIndex,
} from "../src/functions/search.js";
import { VectorIndex } from "../src/state/vector-index.js";
import type { EmbeddingProvider } from "../src/types.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type Handler = (data: unknown) => Promise<unknown>;

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    update: async (
      scope: string,
      key: string,
      updates: Array<{ path: string; value: unknown }>,
    ): Promise<void> => {
      const entries = store.get(scope);
      if (!entries) return;
      const value = (entries.get(key) as Record<string, unknown>) ?? {};
      for (const update of updates) value[update.path] = update.value;
      entries.set(key, value);
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      (Array.from(store.get(scope)?.values() ?? []) as T[]),
  };
}

function mockSdk() {
  const functions = new Map<string, Handler>();
  const triggers: Array<{
    type: string;
    function_id: string;
    config?: { topic?: string };
  }> = [];
  return {
    registerFunction: (
      idOrOptions: string | { id: string },
      handler: Handler,
    ): void => {
      const id = typeof idOrOptions === "string" ? idOrOptions : idOrOptions.id;
      functions.set(id, handler);
    },
    registerTrigger: (trigger: (typeof triggers)[number]): void => {
      triggers.push(trigger);
    },
    trigger: async (
      idOrInput:
        | string
        | { function_id: string; payload: unknown; action?: unknown },
      data?: unknown,
    ): Promise<unknown> => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload =
        typeof idOrInput === "string" ? data : idOrInput.payload;
      if (id === "iii::durable::publish") {
        const published = payload as { topic?: string; data?: unknown };
        const subscribers = triggers.filter(
          (trigger) =>
            trigger.type === "durable:subscriber" &&
            trigger.config?.topic === published.topic,
        );
        await Promise.all(
          subscribers.map(async (trigger) => {
            const subscriber = functions.get(trigger.function_id);
            if (subscriber) await subscriber(published.data);
          }),
        );
        return null;
      }
      return (await functions.get(id)?.(payload)) ?? null;
    },
  };
}

function validPayload(sessionId: string) {
  return {
    sessionId,
    hookType: "post_tool_use",
    timestamp: new Date().toISOString(),
    data: {
      tool_name: "Read",
      tool_input: { file_path: "src/foo.ts" },
      tool_output: "file contents here",
    },
  };
}

function registerCapturePipeline(
  sdk: ReturnType<typeof mockSdk>,
  kv: ReturnType<typeof mockKV>,
): void {
  registerObservationProjectionFunction(
    sdk as never,
    kv as never,
    undefined,
    undefined,
    new ProjectionCoordinator(),
  );
  registerObserveFunction(sdk as never, kv as never);
}

describe("synthetic observation BM25 projection", () => {
  beforeEach(() => {
    delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
    getSearchIndex().clear();
    setVectorIndex(null);
    setEmbeddingProvider(null);
  });

  afterEach(() => {
    delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
    setVectorIndex(null);
    setEmbeddingProvider(null);
    getSearchIndex().clear();
    vi.restoreAllMocks();
  });

  it("fails projection when BM25 rejects but retains the derived observation", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerCapturePipeline(sdk, kv);
    const addSpy = vi
      .spyOn(getSearchIndex(), "add")
      .mockImplementationOnce(() => {
        throw new Error("bm25 unavailable");
      });

    const result = (await sdk.trigger(
      "mem::observe",
      validPayload("ses_bm25_failure"),
    )) as { observationId: string };

    await vi.waitFor(() =>
      expect(
        kv.store
          .get(KV.observationProjections)
          ?.get(result.observationId),
      ).toMatchObject({ status: "failed" }),
    );
    expect(
      kv.store
        .get(KV.observations("ses_bm25_failure"))
        ?.has(result.observationId),
    ).toBe(true);
    expect(addSpy).toHaveBeenCalledOnce();
  });

  it("succeeds through BM25 when vector embedding rejects", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const vectorIndex = new VectorIndex();
    const embeddingProvider: EmbeddingProvider = {
      name: "rejecting-test-provider",
      dimensions: 3,
      embed: vi.fn().mockRejectedValue(new Error("embedding unavailable")),
      embedBatch: vi.fn().mockRejectedValue(new Error("embedding unavailable")),
    };
    setVectorIndex(vectorIndex);
    setEmbeddingProvider(embeddingProvider);
    registerCapturePipeline(sdk, kv);

    const result = (await sdk.trigger(
      "mem::observe",
      validPayload("ses_vector_failure"),
    )) as { observationId: string };

    await vi.waitFor(() =>
      expect(
        kv.store
          .get(KV.observationProjections)
          ?.get(result.observationId),
      ).toMatchObject({ status: "succeeded" }),
    );
    expect(getSearchIndex().has(result.observationId)).toBe(true);
    expect(vectorIndex.size).toBe(0);
    expect(embeddingProvider.embed).toHaveBeenCalledOnce();
  });
});
