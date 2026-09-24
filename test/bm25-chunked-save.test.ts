import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexFileStore } from "../src/state/index-files.js";
import { IndexPersistence } from "../src/state/index-persistence.js";
import { SearchIndex } from "../src/state/search-index.js";
import type { CompressedObservation } from "../src/types.js";

/**
 * Index saves run at most every five minutes under steady writes, and each
 * built the whole BM25 file (~70 MB of JSON on 2026-09-24) in one
 * JSON.stringify on the main thread: a 1–3 s stall every save. The file is
 * now produced in pieces with the event loop turning between them, and its
 * bytes are exactly what serialize() gives.
 */

function makeObs(i: number): CompressedObservation {
  return {
    id: `obs_${i}`,
    sessionId: `ses_${i % 7}`,
    timestamp: "2026-09-24T00:00:00.000Z",
    type: "file_edit",
    title: `edit ${i} handler`,
    facts: [`fact ${i}`],
    narrative: `changed module ${i} and its tests`,
    concepts: ["search"],
    files: [`src/mod${i}.ts`],
    importance: 5,
    ...(i % 2 ? { projectId: "p1" } : {}),
  } as CompressedObservation;
}

function populated(count: number): SearchIndex {
  const index = new SearchIndex();
  for (let i = 0; i < count; i++) index.add(makeObs(i));
  return index;
}

describe("chunked BM25 save", () => {
  it("produces exactly the serialize() text in pieces", () => {
    const index = populated(250);
    const pieces = [...index.serializeChunks(40)];
    expect(pieces.length).toBeGreaterThan(5);
    expect(pieces.join("")).toBe(index.serialize());
    expect([...new SearchIndex().serializeChunks(40)].join("")).toBe(new SearchIndex().serialize());
  });

  it("writes the same file and lets the event loop run while writing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentmemory-bm25-chunks-"));
    try {
      const index = populated(250);
      const store = new IndexFileStore(dir);
      let turns = 0;
      const tick = setInterval(() => (turns += 1), 0);
      await store.writeBm25(index.serializeChunks(40));
      clearInterval(tick);
      expect(await readFile(store.bm25Path, "utf8")).toBe(index.serialize());
      expect(turns).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("hands the file store pieces, not one string, when the index is saved", async () => {
    const store = new Map<string, unknown>();
    const kv = {
      get: async (scope: string, key: string) => store.get(`${scope}/${key}`) ?? null,
      set: async (scope: string, key: string, value: unknown) => (store.set(`${scope}/${key}`, value), value),
      delete: async (scope: string, key: string) => void store.delete(`${scope}/${key}`),
      list: async () => [],
    };
    let written: unknown;
    const files = {
      writeBm25: async (serialized: unknown) => ((written = serialized), { bytes: 1 }),
      writeVectors: async () => ({ bytes: 1, count: 0 }),
    };
    const index = populated(30);
    const persistence = new IndexPersistence(kv as never, index, null, { files: files as never });

    expect(await persistence.save()).toBe(true);
    expect(typeof written).not.toBe("string");
    expect([...(written as Iterable<string>)].join("")).toBe(index.serialize());
  });

  it("captures the documents present when the save starts", () => {
    const index = populated(100);
    const before = index.serialize();
    const pieces = index.serializeChunks(10);
    const first = pieces.next().value as string;
    index.remove("obs_50");
    index.add(makeObs(500));
    expect(first + [...pieces].join("")).toBe(before);
  });
});
