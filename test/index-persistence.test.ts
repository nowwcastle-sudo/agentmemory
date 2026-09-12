import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { IndexPersistence, indexSaveDebounceMs } from "../src/state/index-persistence.js";
import { SearchIndex } from "../src/state/search-index.js";
import { VectorIndex } from "../src/state/vector-index.js";
import type { CompressedObservation } from "../src/types.js";

const BM25_SCOPE = "mem:index:bm25";
const BM25_LEGACY_KEY = "data";
const BM25_MANIFEST_KEY = "data:manifest";
const VECTOR_LEGACY_KEY = "vectors";
const VECTOR_MANIFEST_KEY = "vectors:manifest";

type TestIndexShardManifest = {
  v: 1;
  generation?: string;
  shards: Array<{ scope: string; key: string; chars: number; sha256?: string }>;
  chars: number;
};

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

type MockKV = ReturnType<typeof mockKV>;

function makeObs(
  overrides: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id: "obs_1",
    sessionId: "ses_1",
    timestamp: new Date().toISOString(),
    type: "file_edit",
    title: "Edit auth middleware",
    subtitle: "JWT validation",
    facts: ["Added token check"],
    narrative: "Modified the auth middleware to validate JWT tokens",
    concepts: ["authentication", "jwt"],
    files: ["src/middleware/auth.ts"],
    importance: 7,
    ...overrides,
  };
}

function makeBm25(id: string, title: string): SearchIndex {
  const bm25 = new SearchIndex();
  bm25.add(makeObs({ id, title, narrative: `${title} narrative` }));
  return bm25;
}

function makeVector(id = "obs_1"): VectorIndex {
  const vector = new VectorIndex();
  vector.add(id, "ses_1", new Float32Array([0.1, 0.2, 0.3]));
  return vector;
}

async function getBm25Manifest(kv: MockKV): Promise<TestIndexShardManifest> {
  const manifest = await kv.get<TestIndexShardManifest>(
    BM25_SCOPE,
    BM25_MANIFEST_KEY,
  );
  expect(manifest).not.toBeNull();
  return manifest!;
}

describe("IndexPersistence", () => {
  let kv: ReturnType<typeof mockKV>;
  let previousAuditFlag: string | undefined;

  beforeEach(() => {
    previousAuditFlag = process.env.AGENTMEMORY_AUDIT_INDEX_PERSIST;
    delete process.env.AGENTMEMORY_AUDIT_INDEX_PERSIST;
    vi.useFakeTimers();
    kv = mockKV();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (previousAuditFlag === undefined) {
      delete process.env.AGENTMEMORY_AUDIT_INDEX_PERSIST;
    } else {
      process.env.AGENTMEMORY_AUDIT_INDEX_PERSIST = previousAuditFlag;
    }
  });

  // Every debounced save serialises the whole BM25 index (51.8 MB on the live
  // corpus) and the whole vector index (145.9 MB) on the main thread; at the
  // old 5 s cadence that was one 2-5 s event-loop stall after any burst of
  // mutations (2026-09-12: health 503, /sessions timeouts, the outbox grew
  // from 44 to 231 while hooks fell back). The cadence is an option now,
  // read from AGENTMEMORY_INDEX_SAVE_DEBOUNCE_MS, one minute by default.
  it("waits the configured debounce before a save, one minute by default", async () => {
    const bm25 = new SearchIndex();
    bm25.add(makeObs({ id: "obs_1", title: "auth handler" }));
    const persistence = new IndexPersistence(kv as never, bm25, null);

    persistence.scheduleSave();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await kv.get(BM25_SCOPE, BM25_MANIFEST_KEY)).toBeNull();
    await vi.advanceTimersByTimeAsync(55_000);
    expect(await kv.get(BM25_SCOPE, BM25_MANIFEST_KEY)).not.toBeNull();

    const quickKv = mockKV();
    const quick = new IndexPersistence(quickKv as never, bm25, null, { debounceMs: 250 });
    quick.scheduleSave();
    await vi.advanceTimersByTimeAsync(250);
    expect(await quickKv.get(BM25_SCOPE, BM25_MANIFEST_KEY)).not.toBeNull();

    // A trailing debounce alone never fires while mutations keep coming
    // (live 2026-09-12 11:13-11:17: projections every few seconds, no save
    // for four minutes). A save is forced once the first pending mutation is
    // five debounce intervals old.
    const busyKv = mockKV();
    const busy = new IndexPersistence(busyKv as never, bm25, null, { debounceMs: 1_000 });
    for (let tick = 0; tick < 12; tick += 1) {
      busy.scheduleSave();
      await vi.advanceTimersByTimeAsync(500);
      if (tick === 8) expect(await busyKv.get(BM25_SCOPE, BM25_MANIFEST_KEY)).toBeNull();
    }
    expect(await busyKv.get(BM25_SCOPE, BM25_MANIFEST_KEY)).not.toBeNull();

    expect(indexSaveDebounceMs({})).toBe(60_000);
    expect(indexSaveDebounceMs({ AGENTMEMORY_INDEX_SAVE_DEBOUNCE_MS: "15000" })).toBe(15_000);
    expect(indexSaveDebounceMs({ AGENTMEMORY_INDEX_SAVE_DEBOUNCE_MS: "10" })).toBe(1_000);
    expect(indexSaveDebounceMs({ AGENTMEMORY_INDEX_SAVE_DEBOUNCE_MS: "soon" })).toBe(60_000);
  });

  it("saves and loads BM25 index round-trip", async () => {
    const bm25 = new SearchIndex();
    bm25.add(makeObs({ id: "obs_1", title: "auth handler" }));

    const persistence = new IndexPersistence(kv as never, bm25, null);
    await persistence.save();

    const loaded = await persistence.load();
    expect(loaded.bm25).not.toBeNull();
    expect(loaded.bm25!.size).toBe(1);
    const results = loaded.bm25!.search("auth");
    expect(results.length).toBe(1);
  });

  it("does not flood the governance audit log with index persistence rows by default", async () => {
    const persistence = new IndexPersistence(
      kv as never,
      makeBm25("obs_audit_off", "audit off"),
      null,
    );

    await persistence.save();

    expect(await kv.list("mem:audit")).toHaveLength(0);
  });

  it.each(["1", " 1 ", "true", "TRUE", " true "])(
    "records index persistence diagnostics when AGENTMEMORY_AUDIT_INDEX_PERSIST=%j",
    async (value) => {
      process.env.AGENTMEMORY_AUDIT_INDEX_PERSIST = value;
      const persistence = new IndexPersistence(
        kv as never,
        makeBm25("obs_audit_on", "audit on"),
        null,
      );

      await persistence.save();

      expect(await kv.list("mem:audit")).not.toHaveLength(0);
    },
  );

  it.each(["0", "false", "yes", ""])(
    "keeps index persistence auditing off for AGENTMEMORY_AUDIT_INDEX_PERSIST=%j",
    async (value) => {
      process.env.AGENTMEMORY_AUDIT_INDEX_PERSIST = value;
      const persistence = new IndexPersistence(
        kv as never,
        makeBm25("obs_audit_invalid", "audit invalid"),
        null,
      );

      await persistence.save();

      expect(await kv.list("mem:audit")).toHaveLength(0);
    },
  );

  it("round-trips the index while index persistence auditing is disabled", async () => {
    const persistence = new IndexPersistence(
      kv as never,
      makeBm25("obs_round_trip_no_audit", "round trip no audit"),
      null,
    );

    await persistence.save();

    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();
    expect(loaded.bm25?.has("obs_round_trip_no_audit")).toBe(true);
    expect(await kv.list("mem:audit")).toHaveLength(0);
  });

  it("saves BM25 index shards outside the BM25 metadata scope", async () => {
    const bm25 = new SearchIndex();
    bm25.add(
      makeObs({
        id: "obs_1",
        title: "auth handler ".repeat(40),
        narrative: "JWT middleware validation ".repeat(40),
      }),
    );

    const persistence = new IndexPersistence(kv as never, bm25, null, {
      shardChars: 80,
      createGeneration: () => "gen_bm25",
    });
    await persistence.save();

    const manifest = await getBm25Manifest(kv);
    expect(manifest.generation).toBe("gen_bm25");
    expect(manifest.shards.length).toBeGreaterThan(1);
    expect(manifest.shards[0].scope).toContain(":gen_bm25:");
    await expect(kv.get(BM25_SCOPE, BM25_LEGACY_KEY)).resolves.toBeNull();
    await expect(
      kv.get(manifest.shards[0].scope, manifest.shards[0].key),
    ).resolves.toEqual(expect.any(String));

    const loaded = await persistence.load();
    expect(loaded.bm25).not.toBeNull();
    expect(loaded.bm25!.search("auth").length).toBe(1);
  });

  it("reuses unchanged BM25 and vector shards after append-only updates", async () => {
    const bm25 = new SearchIndex();
    const vector = new VectorIndex();
    for (let index = 0; index < 8; index++) {
      bm25.add(makeObs({
        id: `obs_${index}`,
        title: `append-only document ${index} ${"stable ".repeat(12)}`,
        narrative: `persisted document ${index} ${"content ".repeat(12)}`,
      }));
      vector.add(
        `obs_${index}`,
        "ses_1",
        new Float32Array(Array.from({ length: 24 }, (_, item) => item + index)),
      );
    }
    let generation = 0;
    const persistence = new IndexPersistence(kv as never, bm25, vector, {
      shardChars: 240,
      createGeneration: () => `gen_${++generation}`,
    });

    await persistence.save();
    const firstBm25 = await getBm25Manifest(kv);
    const firstVector = await kv.get<TestIndexShardManifest>(
      BM25_SCOPE,
      VECTOR_MANIFEST_KEY,
    );
    expect(firstBm25.shards.length).toBeGreaterThan(2);
    expect(firstVector!.shards.length).toBeGreaterThan(2);

    bm25.add(makeObs({ id: "obs_appended", title: "appended searchable record" }));
    vector.add(
      "obs_appended",
      "ses_1",
      new Float32Array(Array.from({ length: 24 }, (_, item) => item + 100)),
    );
    await persistence.save();

    const secondBm25 = await getBm25Manifest(kv);
    const secondVector = await kv.get<TestIndexShardManifest>(
      BM25_SCOPE,
      VECTOR_MANIFEST_KEY,
    );
    expect(secondBm25.shards.slice(0, firstBm25.shards.length - 1)).toEqual(
      firstBm25.shards.slice(0, -1),
    );
    expect(
      secondVector!.shards.slice(0, firstVector!.shards.length - 1),
    ).toEqual(
      firstVector!.shards.slice(0, -1),
    );
    expect(secondBm25.shards[firstBm25.shards.length - 1]?.scope).not.toBe(
      firstBm25.shards.at(-1)?.scope,
    );
    expect(secondVector!.shards[firstVector!.shards.length - 1]?.scope).not.toBe(
      firstVector!.shards.at(-1)?.scope,
    );

    const loaded = await persistence.load();
    expect(loaded.bm25?.search("appended")[0]?.obsId).toBe("obs_appended");
    expect(loaded.vector?.size).toBe(9);
  });

  it("does not rewrite index shards when the snapshot is unchanged", async () => {
    const bm25 = makeBm25("obs_stable", "stable snapshot");
    const vector = makeVector("obs_stable");
    const instrumentedKv = {
      ...kv,
      set: vi.fn(kv.set),
    };
    let generation = 0;
    const persistence = new IndexPersistence(
      instrumentedKv as never,
      bm25,
      vector,
      {
        shardChars: 80,
        createGeneration: () => `gen_${++generation}`,
      },
    );

    await persistence.save();
    instrumentedKv.set.mockClear();
    await persistence.save();

    const shardWrites = instrumentedKv.set.mock.calls.filter(([scope]) =>
      String(scope).startsWith("mem:index:bm25:bm25:") ||
      String(scope).startsWith("mem:index:bm25:vectors:"),
    );
    expect(shardWrites).toHaveLength(0);
  });

  it("loads legacy monolithic BM25 and vector snapshots", async () => {
    const bm25 = makeBm25("obs_1", "legacy auth handler");
    const vector = makeVector("obs_1");
    await kv.set(BM25_SCOPE, BM25_LEGACY_KEY, bm25.serialize());
    await kv.set(BM25_SCOPE, VECTOR_LEGACY_KEY, vector.serialize());

    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();

    expect(loaded.bm25).not.toBeNull();
    expect(loaded.bm25!.search("legacy").length).toBe(1);
    expect(loaded.vector).not.toBeNull();
    expect(loaded.vector!.size).toBe(1);
  });

  it("fails closed instead of falling back when manifest reads fail", async () => {
    const legacy = makeBm25("obs_legacy", "legacy stale snapshot");
    await kv.set(BM25_SCOPE, BM25_LEGACY_KEY, legacy.serialize());
    const failingKv = {
      ...kv,
      get: vi.fn(async <T>(scope: string, key: string): Promise<T | null> => {
        if (scope === BM25_SCOPE && key === BM25_MANIFEST_KEY) {
          throw new Error("manifest backend unavailable");
        }
        return kv.get(scope, key);
      }),
    };

    const loaded = await new IndexPersistence(
      failingKv as never,
      new SearchIndex(),
      null,
    ).load();

    expect(loaded.bm25).toBeNull();
  });

  it("fails closed when legacy snapshot reads fail", async () => {
    const failingKv = {
      ...kv,
      get: vi.fn(async <T>(scope: string, key: string): Promise<T | null> => {
        if (scope === BM25_SCOPE && key === BM25_LEGACY_KEY) {
          throw new Error("legacy backend unavailable");
        }
        return kv.get(scope, key);
      }),
    };

    const loaded = await new IndexPersistence(
      failingKv as never,
      new SearchIndex(),
      null,
    ).load();

    expect(loaded.bm25).toBeNull();
  });

  it("loads sharded manifests that omit optional generation metadata", async () => {
    const bm25 = makeBm25("obs_1", "deterministic shard auth");
    const serialized = bm25.serialize();
    const chunks = [serialized.slice(0, 50), serialized.slice(50)];
    await kv.set("mem:index:bm25:bm25:00000", "data", chunks[0]);
    await kv.set("mem:index:bm25:bm25:00001", "data", chunks[1]);
    await kv.set<TestIndexShardManifest>(BM25_SCOPE, BM25_MANIFEST_KEY, {
      v: 1,
      chars: serialized.length,
      shards: [
        {
          scope: "mem:index:bm25:bm25:00000",
          key: "data",
          chars: chunks[0].length,
        },
        {
          scope: "mem:index:bm25:bm25:00001",
          key: "data",
          chars: chunks[1].length,
        },
      ],
    });

    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();

    expect(loaded.bm25).not.toBeNull();
    expect(loaded.bm25!.search("deterministic").length).toBe(1);
  });

  it("saves and loads vector index round-trip", async () => {
    const bm25 = new SearchIndex();
    const vector = makeVector();

    const persistence = new IndexPersistence(kv as never, bm25, vector);
    await persistence.save();

    const loaded = await persistence.load();
    expect(loaded.vector).not.toBeNull();
    expect(loaded.vector!.size).toBe(1);
  });

  it("saves vector index shards outside the BM25 scope", async () => {
    const bm25 = new SearchIndex();
    const vector = new VectorIndex();
    vector.add(
      "obs_1",
      "ses_1",
      new Float32Array(Array.from({ length: 32 }, (_, i) => i)),
    );

    const persistence = new IndexPersistence(kv as never, bm25, vector, {
      shardChars: 40,
      createGeneration: () => "gen_vector",
    });
    await persistence.save();

    const manifest = await kv.get<TestIndexShardManifest>(
      BM25_SCOPE,
      VECTOR_MANIFEST_KEY,
    );
    expect(manifest).not.toBeNull();
    expect(manifest!.generation).toBe("gen_vector");
    expect(manifest!.shards.length).toBeGreaterThan(1);
    expect(manifest!.shards[0].scope).toContain(":gen_vector:");
    await expect(kv.get(BM25_SCOPE, VECTOR_LEGACY_KEY)).resolves.toBeNull();
    await expect(
      kv.get(manifest!.shards[0].scope, manifest!.shards[0].key),
    ).resolves.toEqual(expect.any(String));

    const loaded = await persistence.load();
    expect(loaded.vector).not.toBeNull();
    expect(loaded.vector!.size).toBe(1);
  });

  it("persists empty vector snapshots so cleared vectors do not reload", async () => {
    const previousBm25 = makeBm25("obs_old", "alpha previous snapshot");
    const previousVector = makeVector("obs_old");
    await new IndexPersistence(kv as never, previousBm25, previousVector, {
      shardChars: 80,
      createGeneration: () => "gen_old",
    }).save();

    const nextBm25 = makeBm25("obs_new", "bravo new snapshot");
    const emptyVector = new VectorIndex();
    await new IndexPersistence(kv as never, nextBm25, emptyVector, {
      shardChars: 80,
      createGeneration: () => "gen_empty",
    }).save();

    const vectorManifest = await kv.get<TestIndexShardManifest>(
      BM25_SCOPE,
      VECTOR_MANIFEST_KEY,
    );
    expect(vectorManifest).not.toBeNull();
    expect(vectorManifest!.generation).toBe("gen_empty");
    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();
    expect(loaded.bm25!.search("bravo").length).toBe(1);
    expect(loaded.vector).not.toBeNull();
    expect(loaded.vector!.size).toBe(0);
  });

  it("avoids one oversized state::set string payload for persisted indexes", async () => {
    const maxStringPayloadChars = 80;
    const bm25 = new SearchIndex();
    bm25.add(
      makeObs({
        id: "obs_1",
        title: "large persisted snapshot ".repeat(40),
        narrative: "oversized state set reproduction ".repeat(40),
      }),
    );
    const vector = new VectorIndex();
    vector.add(
      "obs_1",
      "ses_1",
      new Float32Array(Array.from({ length: 64 }, (_, i) => i / 10)),
    );
    const guardedKv = {
      ...kv,
      set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (
          typeof data === "string" &&
          data.length > maxStringPayloadChars
        ) {
          throw new Error(`oversized state::set payload: ${scope}/${key}`);
        }
        return kv.set(scope, key, data);
      }),
    };

    await new IndexPersistence(guardedKv as never, bm25, vector, {
      shardChars: maxStringPayloadChars,
      createGeneration: () => "gen_payload_limit",
    }).save();

    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();
    expect(loaded.bm25!.search("oversized").length).toBe(1);
    expect(loaded.vector!.size).toBe(1);
  });

  it("falls back to the default shard size for fractional values below one", async () => {
    const bm25 = makeBm25("obs_fraction", "fractional shard config");
    let newShardWrites = 0;
    const guardedKv = {
      ...kv,
      set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope.includes(":gen_fraction:")) {
          newShardWrites += 1;
          if (newShardWrites > 3) {
            throw new Error("fractional shard size caused zero-width shards");
          }
        }
        return kv.set(scope, key, data);
      }),
    };

    await new IndexPersistence(guardedKv as never, bm25, null, {
      shardChars: 0.5,
      createGeneration: () => "gen_fraction",
    }).save();

    const manifest = await getBm25Manifest(kv);
    expect(manifest.generation).toBe("gen_fraction");
    expect(manifest.shards.length).toBe(1);
    expect(newShardWrites).toBe(1);
  });

  it("keeps the previous generation when a shard write fails before manifest commit", async () => {
    const previous = makeBm25("obs_old", "alpha previous snapshot");
    await new IndexPersistence(kv as never, previous, null, {
      shardChars: 80,
      createGeneration: () => "gen_old",
    }).save();
    const previousManifest = await getBm25Manifest(kv);

    let newShardWrites = 0;
    const failingKv = {
      ...kv,
      set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope.includes(":gen_new:")) {
          newShardWrites += 1;
          if (newShardWrites === 2) throw new Error("shard write failed");
        }
        return kv.set(scope, key, data);
      }),
    };

    const next = makeBm25("obs_new", "bravo new snapshot");
    await new IndexPersistence(failingKv as never, next, null, {
      shardChars: 80,
      createGeneration: () => "gen_new",
    }).save();

    await expect(kv.get(BM25_SCOPE, BM25_MANIFEST_KEY)).resolves.toEqual(
      previousManifest,
    );
    await expect(
      kv.get("mem:index:bm25:bm25:gen_new:00000", "data"),
    ).resolves.toBeNull();
    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();
    expect(loaded.bm25!.search("alpha").length).toBe(1);
    expect(loaded.bm25!.search("bravo").length).toBe(0);
  });

  it.each(["shard", "manifest"] as const)(
    "preserves reused shards when a %s write fails",
    async (failure) => {
      const bm25 = new SearchIndex();
      for (let index = 0; index < 8; index++) {
        bm25.add(makeObs({
          id: `obs_${index}`,
          title: `stable document ${index} ${"content ".repeat(12)}`,
          narrative: `stable narrative ${index} ${"details ".repeat(12)}`,
        }));
      }
      await new IndexPersistence(kv as never, bm25, null, {
        shardChars: 240,
        createGeneration: () => "gen_old",
      }).save();
      const previousManifest = await getBm25Manifest(kv);

      bm25.add(makeObs({ id: "obs_appended", title: "appended record" }));
      const failingKv = {
        ...kv,
        set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
          if (failure === "shard" && scope.includes(":gen_new:")) {
            throw new Error("new shard write failed");
          }
          if (
            failure === "manifest" &&
            scope === BM25_SCOPE &&
            key === BM25_MANIFEST_KEY
          ) {
            throw new Error("new manifest write failed");
          }
          return kv.set(scope, key, data);
        }),
      };

      await new IndexPersistence(failingKv as never, bm25, null, {
        shardChars: 240,
        createGeneration: () => "gen_new",
      }).save();

      await expect(kv.get(BM25_SCOPE, BM25_MANIFEST_KEY)).resolves.toEqual(
        previousManifest,
      );
      for (const shard of previousManifest.shards) {
        await expect(kv.get(shard.scope, shard.key)).resolves.toEqual(
          expect.any(String),
        );
      }
      const loaded = await new IndexPersistence(
        kv as never,
        new SearchIndex(),
        null,
      ).load();
      expect(loaded.bm25?.search("stable").length).toBeGreaterThan(0);
      expect(loaded.bm25?.search("appended").length).toBe(0);
    },
  );

  it("keeps the previous generation when manifest set rejects before commit", async () => {
    const previous = makeBm25("obs_old", "alpha previous snapshot");
    await new IndexPersistence(kv as never, previous, null, {
      shardChars: 80,
      createGeneration: () => "gen_old",
    }).save();
    const previousManifest = await getBm25Manifest(kv);

    const failingKv = {
      ...kv,
      set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope === BM25_SCOPE && key === BM25_MANIFEST_KEY) {
          throw new Error("manifest write failed");
        }
        return kv.set(scope, key, data);
      }),
    };

    const next = makeBm25("obs_new", "bravo new snapshot");
    await new IndexPersistence(failingKv as never, next, null, {
      shardChars: 80,
      createGeneration: () => "gen_new",
    }).save();

    await expect(kv.get(BM25_SCOPE, BM25_MANIFEST_KEY)).resolves.toEqual(
      previousManifest,
    );
    await expect(
      kv.get("mem:index:bm25:bm25:gen_new:00000", "data"),
    ).resolves.toBeNull();
    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();
    expect(loaded.bm25!.search("alpha").length).toBe(1);
    expect(loaded.bm25!.search("bravo").length).toBe(0);
  });

  it("keeps a generation loadable when manifest set commits before rejecting", async () => {
    const previous = makeBm25("obs_old", "alpha previous snapshot");
    await new IndexPersistence(kv as never, previous, null, {
      shardChars: 80,
      createGeneration: () => "gen_old",
    }).save();

    const failingKv = {
      ...kv,
      set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope === BM25_SCOPE && key === BM25_MANIFEST_KEY) {
          await kv.set(scope, key, data);
          throw new Error("manifest write timed out after commit");
        }
        return kv.set(scope, key, data);
      }),
    };

    const next = makeBm25("obs_new", "bravo new snapshot");
    await new IndexPersistence(failingKv as never, next, null, {
      shardChars: 80,
      createGeneration: () => "gen_new",
    }).save();

    const manifest = await getBm25Manifest(kv);
    expect(manifest.generation).toBe("gen_new");
    await expect(
      kv.get("mem:index:bm25:bm25:gen_new:00000", "data"),
    ).resolves.toEqual(expect.any(String));
    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();
    expect(loaded.bm25!.search("bravo").length).toBe(1);
  });

  it("deletes a shard that committed before set rejected", async () => {
    const previous = makeBm25("obs_old", "alpha previous snapshot");
    await new IndexPersistence(kv as never, previous, null, {
      shardChars: 80,
      createGeneration: () => "gen_old",
    }).save();
    const previousManifest = await getBm25Manifest(kv);

    const failingKv = {
      ...kv,
      set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope === "mem:index:bm25:bm25:gen_new:00000") {
          await kv.set(scope, key, data);
          throw new Error("state::set timed out after commit");
        }
        return kv.set(scope, key, data);
      }),
    };

    const next = makeBm25("obs_new", "bravo new snapshot");
    await new IndexPersistence(failingKv as never, next, null, {
      shardChars: 80,
      createGeneration: () => "gen_new",
    }).save();

    await expect(kv.get(BM25_SCOPE, BM25_MANIFEST_KEY)).resolves.toEqual(
      previousManifest,
    );
    await expect(
      kv.get("mem:index:bm25:bm25:gen_new:00000", "data"),
    ).resolves.toBeNull();
    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();
    expect(loaded.bm25!.search("alpha").length).toBe(1);
    expect(loaded.bm25!.search("bravo").length).toBe(0);
  });

  it("loads the new generation even when old generation cleanup fails", async () => {
    const previous = makeBm25("obs_old", "alpha previous snapshot");
    await new IndexPersistence(kv as never, previous, null, {
      shardChars: 80,
      createGeneration: () => "gen_old",
    }).save();

    const cleanupKv = {
      ...kv,
      delete: vi.fn(async () => {
        throw new Error("cleanup failed");
      }),
    };
    const next = makeBm25("obs_new", "bravo new snapshot");
    await new IndexPersistence(cleanupKv as never, next, null, {
      shardChars: 80,
      createGeneration: () => "gen_new",
    }).save();

    const manifest = await getBm25Manifest(kv);
    expect(manifest.generation).toBe("gen_new");
    expect(cleanupKv.delete).toHaveBeenCalled();
    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();
    expect(loaded.bm25!.search("bravo").length).toBe(1);
    expect(loaded.bm25!.search("alpha").length).toBe(0);
  });

  it("keeps the previous vector generation when vector save fails after BM25 publish", async () => {
    const previousBm25 = makeBm25("obs_old", "alpha previous snapshot");
    const previousVector = makeVector("obs_old");
    await new IndexPersistence(kv as never, previousBm25, previousVector, {
      shardChars: 80,
      createGeneration: () => "gen_old",
    }).save();

    const failingKv = {
      ...kv,
      set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope === BM25_SCOPE && key === VECTOR_MANIFEST_KEY) {
          throw new Error("vector manifest write failed");
        }
        return kv.set(scope, key, data);
      }),
    };
    const nextBm25 = makeBm25("obs_new", "bravo new snapshot");
    const nextVector = new VectorIndex();
    nextVector.add("obs_new", "ses_1", new Float32Array([0.4, 0.5, 0.6]));

    await new IndexPersistence(failingKv as never, nextBm25, nextVector, {
      shardChars: 80,
      createGeneration: () => "gen_new",
    }).save();

    await expect(
      kv.get("mem:index:bm25:vectors:gen_new:00000", "data"),
    ).resolves.toBeNull();
    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();
    expect(loaded.bm25!.search("bravo").length).toBe(1);
    expect(loaded.vector!.size).toBe(1);
    expect(
      loaded.vector!.search(new Float32Array([0.1, 0.2, 0.3]))[0]?.obsId,
    ).toBe("obs_old");
  });

  it("fails closed when a manifest shard is missing", async () => {
    const bm25 = makeBm25("obs_1", "alpha sharded snapshot");
    await new IndexPersistence(kv as never, bm25, null, {
      shardChars: 80,
      createGeneration: () => "gen_missing",
    }).save();
    const manifest = await getBm25Manifest(kv);
    await kv.delete(manifest.shards[0].scope, manifest.shards[0].key);

    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();

    expect(loaded.bm25).toBeNull();
  });

  it("fails closed when a manifest shard length mismatches", async () => {
    const bm25 = makeBm25("obs_1", "alpha sharded snapshot");
    await new IndexPersistence(kv as never, bm25, null, {
      shardChars: 80,
      createGeneration: () => "gen_mismatch",
    }).save();
    const manifest = await getBm25Manifest(kv);
    const firstShard = manifest.shards[0];
    const chunk = await kv.get<string>(firstShard.scope, firstShard.key);
    await kv.set(firstShard.scope, firstShard.key, `${chunk}x`);

    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();

    expect(loaded.bm25).toBeNull();
  });

  it("fails closed when a manifest shard hash mismatches", async () => {
    const bm25 = makeBm25("obs_1", "alpha sharded snapshot");
    await new IndexPersistence(kv as never, bm25, null, {
      shardChars: 100_000,
      createGeneration: () => "gen_hash_mismatch",
    }).save();
    const manifest = await getBm25Manifest(kv);
    const firstShard = manifest.shards[0];
    const chunk = await kv.get<string>(firstShard.scope, firstShard.key);
    const replacement = chunk?.startsWith("{") ? "[" : "{";
    await kv.set(
      firstShard.scope,
      firstShard.key,
      `${replacement}${chunk?.slice(1) ?? ""}`,
    );

    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();

    expect(loaded.bm25).toBeNull();
  });

  it("fails closed before reading a malformed shard hash descriptor", async () => {
    await kv.set<TestIndexShardManifest>(BM25_SCOPE, BM25_MANIFEST_KEY, {
      v: 1,
      chars: 10,
      shards: [{ scope: "valid", key: "data", chars: 10, sha256: "invalid" }],
    });
    const guardedKv = {
      ...kv,
      get: vi.fn(async <T>(scope: string, key: string): Promise<T | null> => {
        if (scope === "valid") {
          throw new Error("malformed shard descriptor was read");
        }
        return kv.get(scope, key);
      }),
    };

    const loaded = await new IndexPersistence(
      guardedKv as never,
      new SearchIndex(),
      null,
    ).load();

    expect(loaded.bm25).toBeNull();
    expect(guardedKv.get).not.toHaveBeenCalledWith("valid", "data");
  });

  it("fails closed before reading invalid shard descriptors", async () => {
    await kv.set<TestIndexShardManifest>(BM25_SCOPE, BM25_MANIFEST_KEY, {
      v: 1,
      chars: 10,
      shards: [{ scope: "", key: "data", chars: 10 }],
    });
    const guardedKv = {
      ...kv,
      get: vi.fn(async <T>(scope: string, key: string): Promise<T | null> => {
        if (scope === "") {
          throw new Error("invalid shard descriptor was read");
        }
        return kv.get(scope, key);
      }),
    };

    const loaded = await new IndexPersistence(
      guardedKv as never,
      new SearchIndex(),
      null,
    ).load();

    expect(loaded.bm25).toBeNull();
    expect(guardedKv.get).not.toHaveBeenCalledWith("", "data");
  });

  it("scheduleSave debounces multiple calls", async () => {
    const bm25 = new SearchIndex();
    const persistence = new IndexPersistence(kv as never, bm25, null);

    persistence.scheduleSave();
    persistence.scheduleSave();
    persistence.scheduleSave();

    await expect(kv.get(BM25_SCOPE, BM25_MANIFEST_KEY)).resolves.toBeNull();

    vi.advanceTimersByTime(5000);
    await vi.runAllTimersAsync();

    const saved = await kv.get<string>(BM25_SCOPE, BM25_MANIFEST_KEY);
    expect(saved).not.toBeNull();
  });

  it("stop clears the pending timer", async () => {
    const bm25 = new SearchIndex();
    bm25.add(makeObs({ id: "obs_1", title: "auth handler" }));
    const persistence = new IndexPersistence(kv as never, bm25, null);

    persistence.scheduleSave();
    persistence.stop();

    vi.advanceTimersByTime(10000);
    const saved = await kv.get<string>(BM25_SCOPE, BM25_MANIFEST_KEY);
    expect(saved).toBeNull();
  });

  it("returns null indexes when nothing has been saved", async () => {
    const bm25 = new SearchIndex();
    const persistence = new IndexPersistence(kv as never, bm25, null);

    const loaded = await persistence.load();
    expect(loaded.bm25).toBeNull();
    expect(loaded.vector).toBeNull();
  });

  it("scheduled save swallows kv.set rejection without unhandledRejection (#204)", async () => {
    const failingKv = {
      ...mockKV(),
      set: vi.fn(async () => {
        const err = new Error(
          "TIMEOUT: invocation timed out after 30000ms",
        ) as Error & { code?: string; function_id?: string };
        err.code = "TIMEOUT";
        err.function_id = "state::set";
        throw err;
      }),
    };
    const bm25 = new SearchIndex();
    bm25.add(makeObs({ id: "obs_1", title: "auth handler" }));
    const persistence = new IndexPersistence(failingKv as never, bm25, null);

    let unhandled = false;
    const onUnhandled = () => {
      unhandled = true;
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      persistence.scheduleSave();
      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();
      // give microtasks a chance to flush
      await Promise.resolve();
      expect(failingKv.set).toHaveBeenCalled();
      expect(unhandled).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("save() does not throw when kv.set rejects (#204)", async () => {
    const failingKv = {
      ...mockKV(),
      set: vi.fn(async () => {
        throw new Error("TIMEOUT");
      }),
    };
    const bm25 = new SearchIndex();
    bm25.add(makeObs({ id: "obs_1", title: "auth handler" }));
    const persistence = new IndexPersistence(failingKv as never, bm25, null);

    await expect(persistence.save()).resolves.toBe(false);
  });

  it("persists dirty status before the debounce and clears it only after success", async () => {
    const bm25 = new SearchIndex();
    bm25.add(makeObs({ id: "obs_status", title: "status" }));
    const persistence = new IndexPersistence(kv as never, bm25, null);

    persistence.scheduleSave();
    await Promise.resolve();
    await Promise.resolve();
    expect(persistence.getStatus()).toMatchObject({
      dirty: true,
      dirtySince: expect.any(String),
    });

    vi.advanceTimersByTime(5000);
    await vi.runAllTimersAsync();
    expect(persistence.getStatus()).toMatchObject({
      dirty: false,
      lastSuccessAt: expect.any(String),
    });
    expect(
      await kv.get("mem:index:status", "current"),
    ).toMatchObject({ dirty: false, lastSuccessAt: expect.any(String) });
  });

  it("keeps dirty state when the index changes during a snapshot save", async () => {
    let releaseManifest!: () => void;
    let manifestStarted!: () => void;
    const manifestGate = new Promise<void>((resolve) => {
      releaseManifest = resolve;
    });
    const started = new Promise<void>((resolve) => {
      manifestStarted = resolve;
    });
    let delayed = false;
    const delayedKv = {
      ...kv,
      set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (
          !delayed &&
          scope === BM25_SCOPE &&
          key === BM25_MANIFEST_KEY
        ) {
          delayed = true;
          manifestStarted();
          await manifestGate;
        }
        return kv.set(scope, key, data);
      }),
    };
    const bm25 = makeBm25("obs_before", "before concurrent mutation");
    const persistence = new IndexPersistence(delayedKv as never, bm25, null);
    persistence.scheduleSave();

    const saving = persistence.save();
    await started;
    bm25.add(makeObs({
      id: "obs_during",
      title: "mutation during snapshot",
    }));
    persistence.scheduleSave();
    releaseManifest();

    await expect(saving).resolves.toBe(false);
    expect(persistence.getStatus()).toMatchObject({
      dirty: true,
      lastSuccessAt: expect.any(String),
    });
    expect(
      await kv.get("mem:index:status", "current"),
    ).toMatchObject({ dirty: true, lastSuccessAt: expect.any(String) });
    persistence.stop();
  });

  it("returns false and preserves a restart-visible dirty failure status", async () => {
    const base = mockKV();
    const failingKv = {
      ...base,
      set: vi.fn(async <T>(scope: string, key: string, data: T) => {
        if (scope === "mem:index:status") return base.set(scope, key, data);
        throw new Error("injected index write failure");
      }),
    };
    const persistence = new IndexPersistence(
      failingKv as never,
      makeBm25("obs_failed_status", "failed status"),
      null,
    );
    persistence.scheduleSave();

    await expect(persistence.save()).resolves.toBe(false);
    expect(persistence.getStatus()).toMatchObject({
      dirty: true,
      lastFailureAt: expect.any(String),
      lastError: "index_save_failed",
    });

    const restarted = new IndexPersistence(
      base as never,
      new SearchIndex(),
      null,
    );
    await restarted.load();
    expect(restarted.getStatus()).toMatchObject({
      dirty: true,
      lastFailureAt: expect.any(String),
    });
  });

  it("retries a restart-visible dirty snapshot after loading a valid index", async () => {
    const original = makeBm25("obs_restart_dirty", "restart dirty index");
    const first = new IndexPersistence(kv as never, original, null);
    await first.save();
    await kv.set("mem:index:status", "current", {
      dirty: true,
      dirtySince: "2026-09-01T00:00:00.000Z",
      lastAttemptAt: "2026-09-01T00:00:00.000Z",
    });

    const restartedIndex = new SearchIndex();
    const restarted = new IndexPersistence(kv as never, restartedIndex, null);
    const loaded = await restarted.load();
    expect(loaded.bm25).not.toBeNull();
    restartedIndex.restoreFrom(loaded.bm25!);

    vi.advanceTimersByTime(5000);
    await vi.runAllTimersAsync();
    expect(restarted.getStatus()).toMatchObject({
      dirty: false,
      lastSuccessAt: expect.any(String),
    });
  });

  // #797: first run after upgrading to 0.9.25 crashed with
  // 'TypeError: Cannot read properties of undefined (reading "v")'
  // because some iii-state adapters return `undefined` (not `null`)
  // for a missing key. The load path's `value !== null` check passed
  // undefined to loadManifestData, which then read `undefined.v`.
  it("load() returns null instead of crashing when kv.get returns undefined for the manifest (#797)", async () => {
    const undefinedKv = {
      ...mockKV(),
      get: vi.fn(async () => undefined),
    };
    const persistence = new IndexPersistence(
      undefinedKv as never,
      new SearchIndex(),
      null,
    );

    const loaded = await persistence.load();
    expect(loaded.bm25).toBeNull();
    expect(loaded.vector).toBeNull();
  });

  it("load() does not crash when a manifest row value is the wrong shape (#797)", async () => {
    const wrongShapeKv = {
      ...mockKV(),
      get: vi.fn(async () => "not-a-manifest"),
    };
    const persistence = new IndexPersistence(
      wrongShapeKv as never,
      new SearchIndex(),
      null,
    );

    await expect(persistence.load()).resolves.toBeDefined();
  });
});
