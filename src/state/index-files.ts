import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { VectorIndex, type VectorBinaryHeader } from "./vector-index.js";

// The search indexes as files on the worker's own disk.
//
// Until 2026-09-12 every index save serialised the whole BM25 index (51.8 MB
// of JSON on the live corpus) and the whole vector index (145.9 MB, one base64
// string per vector) on the main thread and shipped the changed 2 MB shards
// through the engine into the state worker; boot read all 99 shards back the
// same way. That was the largest whole-scope traffic left in the system and
// the event-loop stall behind the morning's 503s. Here the vector index is one
// binary file (a small JSON header, then one Float32 block) and the BM25 index
// one JSON file, each written to a temp name and renamed into place, so a
// crash mid-write leaves the previous file intact. IndexPersistence keeps the
// KV shards as the read fallback for a store that predates these files.

const VECTORS_FILE = "vectors.bin";
const BM25_FILE = "bm25.json";
const MAGIC = Buffer.from("AMVX", "ascii");
const FORMAT_VERSION = 1;
// magic(4) + version(u32) + headerBytes(u32); the float block starts at the
// next multiple of 4 after the header so a Float32Array view is aligned.
const PREFIX_BYTES = 12;

const isMissing = (error: unknown): boolean =>
  !!error && typeof error === "object" && (error as { code?: string }).code === "ENOENT";

const WINDOWS_RENAME_RETRY_CODES = new Set(["EACCES", "EPERM", "EBUSY"]);
const WINDOWS_RENAME_RETRY_BUDGET_MS = 30_000;

export async function renameIndexFile(
  from: string,
  to: string,
  options: {
    platform?: NodeJS.Platform;
    renameFile?: typeof rename;
    sleep?: (delayMs: number) => Promise<void>;
    budgetMs?: number;
  } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const renameFile = options.renameFile ?? rename;
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const budgetMs = options.budgetMs ?? WINDOWS_RENAME_RETRY_BUDGET_MS;
  let waitedMs = 0;
  let delayMs = 50;
  for (;;) {
    try {
      await renameFile(from, to);
      return;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (platform !== "win32" || !WINDOWS_RENAME_RETRY_CODES.has(code ?? "") || waitedMs >= budgetMs) {
        throw error;
      }
      const waitMs = Math.min(delayMs, budgetMs - waitedMs);
      await sleep(waitMs);
      waitedMs += waitMs;
      delayMs = Math.min(500, delayMs * 2);
    }
  }
}

export class IndexFileStore {
  constructor(readonly dir: string) {}

  get vectorsPath(): string {
    return join(this.dir, VECTORS_FILE);
  }

  get bm25Path(): string {
    return join(this.dir, BM25_FILE);
  }

  async writeVectors(index: VectorIndex): Promise<{ bytes: number; count: number }> {
    const { header, block } = index.toBinary();
    const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
    const blockOffset = align4(PREFIX_BYTES + headerBytes.length);
    const out = Buffer.alloc(blockOffset + block.byteLength);
    MAGIC.copy(out, 0);
    out.writeUInt32LE(FORMAT_VERSION, 4);
    out.writeUInt32LE(headerBytes.length, 8);
    headerBytes.copy(out, PREFIX_BYTES);
    Buffer.from(block.buffer, block.byteOffset, block.byteLength).copy(out, blockOffset);
    await this.writeAtomic(this.vectorsPath, out);
    return { bytes: out.length, count: header.count };
  }

  async readVectors(): Promise<VectorIndex | null> {
    let raw: Buffer;
    try {
      raw = await readFile(this.vectorsPath);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    if (raw.length < PREFIX_BYTES || !raw.subarray(0, 4).equals(MAGIC)) return null;
    if (raw.readUInt32LE(4) !== FORMAT_VERSION) return null;
    const headerLength = raw.readUInt32LE(8);
    const blockOffset = align4(PREFIX_BYTES + headerLength);
    if (PREFIX_BYTES + headerLength > raw.length || blockOffset > raw.length) return null;
    let header: VectorBinaryHeader;
    try {
      header = JSON.parse(raw.subarray(PREFIX_BYTES, PREFIX_BYTES + headerLength).toString("utf8"));
    } catch {
      return null;
    }
    const blockBytes = raw.length - blockOffset;
    if (blockBytes % Float32Array.BYTES_PER_ELEMENT !== 0) return null;
    // slice() copies into a fresh, aligned ArrayBuffer; the index then holds
    // one 4-byte-aligned block and each entry is a view into it.
    const copy = raw.buffer.slice(raw.byteOffset + blockOffset, raw.byteOffset + raw.length);
    const block = new Float32Array(copy);
    if (block.length !== header.floats) return null;
    return VectorIndex.fromBinary(header, block);
  }

  async writeBm25(serialized: string): Promise<{ bytes: number }> {
    const out = Buffer.from(serialized, "utf8");
    await this.writeAtomic(this.bm25Path, out);
    return { bytes: out.length };
  }

  async readBm25(): Promise<string | null> {
    try {
      return await readFile(this.bm25Path, "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /**
   * Removes `*.tmp-<pid>` files another process left behind when it was
   * killed mid-write (a force-stopped worker during a save leaves one beside
   * the real file). This process's own temp files are left alone.
   */
  async sweepTemporaries(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }
    const mine = `.tmp-${process.pid}`;
    let removed = 0;
    for (const name of names) {
      const match = /^(vectors\.bin|bm25\.json)\.tmp-\d+$/.exec(name);
      if (!match || name.endsWith(mine)) continue;
      await rm(join(this.dir, name), { force: true }).catch(() => {});
      removed += 1;
    }
    return removed;
  }

  private async writeAtomic(path: string, data: Buffer): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const temporary = `${path}.tmp-${process.pid}`;
    try {
      await writeFile(temporary, data);
      await renameIndexFile(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}

function align4(n: number): number {
  return (n + 3) & ~3;
}
