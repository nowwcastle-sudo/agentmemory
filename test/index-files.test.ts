import { describe, it, expect } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexFileStore } from "../src/state/index-files.js";
import { IndexPersistence } from "../src/state/index-persistence.js";
import { SearchIndex } from "../src/state/search-index.js";
import { VectorIndex } from "../src/state/vector-index.js";
import type { CompressedObservation } from "../src/types.js";

/**
 * Index persistence used to serialise the whole BM25 index (51.8 MB of JSON on
 * the live corpus) and the whole vector index (145.9 MB, one base64 string per
 * vector) and ship them through the engine into the state worker as 2 MB
 * shards, on every save. The worker's disk is right there: the vector index
 * becomes one binary file (a JSON header plus one Float32 block), the BM25
 * index one JSON file, both written temp-then-rename. Nothing about the
 * indexes crosses the engine any more; the KV shards stay readable as the
 * fallback for a store that predates the files.
 */
const BM25_SCOPE = "mem:index:bm25";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
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
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function makeObs(overrides: Partial<CompressedObservation> = {}): CompressedObservation {
  return {
    id: "obs_1",
    sessionId: "ses_1",
    timestamp: "2026-09-12T02:00:00.000Z",
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

function sampleVectors(): VectorIndex {
  const vector = new VectorIndex();
  vector.add("obs_1", "ses_1", new Float32Array([0.1, 0.2, 0.3]), {
    sourceKind: "observation",
    projectId: "proj-1",
  });
  vector.add("obs_2", "ses_2", new Float32Array([1, 0, 0]), {
    actorAgentId: "agent-9",
    visibility: "private",
  });
  vector.add("obs_3", "ses_1", new Float32Array([0, 1, 0]));
  return vector;
}

describe("IndexFileStore", () => {
  it("round-trips the vector index through one binary file, temp file gone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentmemory-index-files-"));
    try {
      const store = new IndexFileStore(dir);
      const vector = sampleVectors();
      await store.writeVectors(vector);
      const files = await readdir(dir);
      expect(files).toContain("vectors.bin");
      expect(files.some((name) => name.includes(".tmp"))).toBe(false);

      const loaded = await store.readVectors();
      expect(loaded).not.toBeNull();
      expect(loaded!.size).toBe(3);
      // Same entries, same metadata, same floats: the JSON form is identical.
      expect(loaded!.serialize()).toBe(vector.serialize());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("round-trips the BM25 index as a file and reports absence as null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentmemory-index-files-"));
    try {
      const store = new IndexFileStore(dir);
      expect(await store.readBm25()).toBeNull();
      expect(await store.readVectors()).toBeNull();

      const bm25 = new SearchIndex();
      bm25.add(makeObs({ id: "obs_1", title: "auth handler" }));
      await store.writeBm25(bm25.serialize());
      const text = await store.readBm25();
      expect(text).not.toBeNull();
      const back = SearchIndex.deserialize(text!);
      expect(back.size).toBe(1);
      expect(back.search("auth")).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sweeps temp files left by a process killed mid-write, and keeps its own", async () => {
    // Live 2026-09-12 11:55: vectors.bin.tmp-18116 beside vectors.bin after a
    // worker was force-stopped during a save.
    const dir = await mkdtemp(join(tmpdir(), "agentmemory-index-files-"));
    try {
      const store = new IndexFileStore(dir);
      await store.writeVectors(sampleVectors());
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(dir, "vectors.bin.tmp-18116"), "half");
      await writeFile(join(dir, "bm25.json.tmp-4"), "half");
      await writeFile(join(dir, `bm25.json.tmp-${process.pid}`), "mine");
      const removed = await store.sweepTemporaries();
      expect(removed).toBe(2);
      const files = (await readdir(dir)).sort();
      expect(files).toEqual([`bm25.json.tmp-${process.pid}`, "vectors.bin"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a vector file whose header and block disagree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentmemory-index-files-"));
    try {
      const store = new IndexFileStore(dir);
      await store.writeVectors(sampleVectors());
      const { writeFile, readFile } = await import("node:fs/promises");
      const raw = await readFile(join(dir, "vectors.bin"));
      await writeFile(join(dir, "vectors.bin"), raw.subarray(0, raw.length - 8));
      expect(await store.readVectors()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("IndexPersistence with a file store", () => {
  it("saves to files and sends no index shard through the KV", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentmemory-index-files-"));
    try {
      const kv = mockKV();
      const bm25 = new SearchIndex();
      bm25.add(makeObs({ id: "obs_1", title: "auth handler" }));
      const persistence = new IndexPersistence(kv as never, bm25, sampleVectors(), {
        files: new IndexFileStore(dir),
      });
      await persistence.save();

      const files = await readdir(dir);
      expect(files).toContain("bm25.json");
      expect(files).toContain("vectors.bin");
      const indexScopes = [...kv.store.keys()].filter((scope) => scope.startsWith(BM25_SCOPE));
      expect(indexScopes).toEqual([]);

      const loaded = await new IndexPersistence(kv as never, new SearchIndex(), new VectorIndex(), {
        files: new IndexFileStore(dir),
      }).load();
      expect(loaded.bm25?.size).toBe(1);
      expect(loaded.vector?.size).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the KV shards when the files are absent, then writes files on the next save", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentmemory-index-files-"));
    try {
      const kv = mockKV();
      const bm25 = new SearchIndex();
      bm25.add(makeObs({ id: "obs_1", title: "auth handler" }));
      // A store from before the files existed: shards in the KV only.
      await new IndexPersistence(kv as never, bm25, sampleVectors()).save();

      const withFiles = new IndexPersistence(kv as never, new SearchIndex(), new VectorIndex(), {
        files: new IndexFileStore(dir),
      });
      const loaded = await withFiles.load();
      expect(loaded.bm25?.size).toBe(1);
      expect(loaded.vector?.size).toBe(3);
      expect(await readdir(dir)).toEqual([]);

      const migrated = new IndexPersistence(kv as never, loaded.bm25!, loaded.vector!, {
        files: new IndexFileStore(dir),
      });
      await migrated.save();
      expect(await readdir(dir)).toEqual(expect.arrayContaining(["bm25.json", "vectors.bin"]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
