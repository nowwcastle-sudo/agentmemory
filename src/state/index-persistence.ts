import { createHash } from "node:crypto";
import { SearchIndex } from "./search-index.js";
import { VectorIndex } from "./vector-index.js";
import type { IndexFileStore } from "./index-files.js";
import type { StateKV } from "./kv.js";
import { KV, generateId } from "./schema.js";
import { logger } from "../logger.js";
import { safeAudit } from "../functions/audit.js";
import type { IndexPersistenceStatus } from "../types.js";

// A save serialises the whole BM25 index and the whole vector index on the
// main thread (51.8 MB and 145.9 MB of JSON on the 2026-09-12 corpus), hashes
// every 2 MB shard, and ships the changed shards through the engine. At the
// old 5 s cadence any burst of projections became one 2-5 s event-loop stall
// after another: health 503, /sessions timeouts, hooks falling back to the
// outbox. One minute by default; AGENTMEMORY_INDEX_SAVE_DEBOUNCE_MS overrides
// (floor 1 s). Deletes still flush immediately through flushIndexSave().
const DEFAULT_DEBOUNCE_MS = 60_000;
const MIN_DEBOUNCE_MS = 1_000;
/** Under continuous mutation a save is forced after this many debounce intervals. */
const MAX_WAIT_DEBOUNCES = 5;
const FAILURE_LOG_THROTTLE_MS = 60_000;

export function indexSaveDebounceMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env["AGENTMEMORY_INDEX_SAVE_DEBOUNCE_MS"]?.trim();
  if (!raw) return DEFAULT_DEBOUNCE_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_DEBOUNCE_MS;
  return Math.max(MIN_DEBOUNCE_MS, parsed);
}
const INDEX_PERSISTENCE_FUNCTION_ID = "mem::index-persistence";
const BM25_KEY = "data";
const BM25_MANIFEST_KEY = "data:manifest";
const BM25_SHARD_SCOPE_PREFIX = `${KV.bm25Index}:bm25:`;
const VECTOR_KEY = "vectors";
const VECTOR_MANIFEST_KEY = "vectors:manifest";
const VECTOR_SHARD_SCOPE_PREFIX = `${KV.bm25Index}:vectors:`;
const INDEX_SHARD_KEY = "data";
const DEFAULT_INDEX_SHARD_CHARS = 2_000_000;
const INDEX_STATUS_KEY = "current";

function isIndexPersistenceAuditEnabled(): boolean {
  const value = process.env["AGENTMEMORY_AUDIT_INDEX_PERSIST"]
    ?.trim()
    .toLowerCase();
  return value === "1" || value === "true";
}

type IndexShardManifest = {
  v: 1;
  generation?: string;
  shards: Array<{ scope: string; key: string; chars: number; sha256?: string }>;
  chars: number;
};

type IndexPersistenceOptions = {
  shardChars?: number;
  createGeneration?: () => string;
  /** Delay between the last mutation and the save it triggers. */
  debounceMs?: number;
  /**
   * Files on the worker's disk for both indexes. When set, saves go to the
   * files only (nothing crosses the engine) and loads read the files first,
   * falling back to the KV shards a store from before the files still holds.
   */
  files?: IndexFileStore;
};

function shardChars(options: IndexPersistenceOptions): number {
  const configured = options.shardChars;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_INDEX_SHARD_CHARS;
  }
  const wholeChars = Math.floor(configured);
  return wholeChars >= 1 ? wholeChars : DEFAULT_INDEX_SHARD_CHARS;
}

function createIndexGeneration(): string {
  return generateId("idx");
}

function statePath(scope: string, key: string): string {
  return `${scope}/${key}`;
}

function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isValidShardDescriptor(
  shard: unknown,
): shard is IndexShardManifest["shards"][number] {
  if (!shard || typeof shard !== "object") return false;
  const candidate = shard as {
    scope?: unknown;
    key?: unknown;
    chars?: unknown;
    sha256?: unknown;
  };
  return (
    typeof candidate.scope === "string" &&
    candidate.scope.length > 0 &&
    typeof candidate.key === "string" &&
    candidate.key.length > 0 &&
    Number.isInteger(candidate.chars) &&
    candidate.chars >= 0 &&
    (candidate.sha256 === undefined ||
      (typeof candidate.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(candidate.sha256)))
  );
}

export class IndexPersistence {
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** When the oldest unsaved mutation arrived; null once a save has started. */
  private firstPendingAt: number | null = null;
  private lastFailureLogAt = 0;
  private status: IndexPersistenceStatus = { dirty: false };
  private statusWrite: Promise<void> = Promise.resolve();
  private saveQueue: Promise<void> = Promise.resolve();
  private mutationVersion = 0;

  constructor(
    private kv: StateKV,
    private bm25: SearchIndex,
    private vector: VectorIndex | null,
    private options: IndexPersistenceOptions = {},
  ) {}

  scheduleSave(): void {
    this.mutationVersion += 1;
    if (!this.status.dirty) {
      this.status = {
        ...this.status,
        dirty: true,
        dirtySince: new Date().toISOString(),
      };
      void this.persistStatus();
    }
    if (this.timer) clearTimeout(this.timer);
    // A trailing debounce alone never fires while mutations keep arriving
    // (live 2026-09-12 11:13-11:17: a projection every few seconds, no save
    // for four minutes, and a crash would have left the index without them).
    // Once the first pending mutation is MAX_WAIT_DEBOUNCES intervals old
    // the save runs on the next tick regardless.
    const now = Date.now();
    if (this.firstPendingAt === null) this.firstPendingAt = now;
    const debounce = this.options.debounceMs ?? indexSaveDebounceMs();
    const overdue = now - this.firstPendingAt >= debounce * MAX_WAIT_DEBOUNCES;
    // setTimeout discards the returned promise, so any rejection inside
    // save() would surface as unhandledRejection and crash the process
    // under sustained iii-engine write timeouts (issue #204). Funnel
    // rejections through logFailure() instead.
    this.timer = setTimeout(() => {
      void this.save();
    }, overdue ? 0 : debounce);
  }

  save(): Promise<boolean> {
    const run = this.saveQueue.then(() => this.performSave());
    this.saveQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async performSave(): Promise<boolean> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.firstPendingAt = null;
    const savingVersion = this.mutationVersion;
    const attemptAt = new Date().toISOString();
    this.status = {
      ...this.status,
      dirty: true,
      dirtySince: this.status.dirtySince ?? attemptAt,
      lastAttemptAt: attemptAt,
    };
    await this.persistStatus().catch(() => {});
    try {
      if (this.options.files) {
        await this.options.files.writeBm25(this.bm25.serializeChunks());
        if (this.vector) await this.options.files.writeVectors(this.vector);
      } else {
        await this.saveBm25Index(this.bm25.serialize());
        if (this.vector) {
          await this.saveVectorIndex(this.vector.serialize());
        }
      }
      const lastSuccessAt = new Date().toISOString();
      const caughtUp = this.mutationVersion === savingVersion;
      this.status = caughtUp
        ? {
            dirty: false,
            lastAttemptAt: attemptAt,
            lastSuccessAt,
            ...(this.status.lastFailureAt
              ? { lastFailureAt: this.status.lastFailureAt }
              : {}),
          }
        : {
            dirty: true,
            // Earlier mutations are in this checkpoint; only changes made
            // during the save can still be pending.
            dirtySince: attemptAt,
            lastAttemptAt: attemptAt,
            lastSuccessAt,
            ...(this.status.lastFailureAt
              ? { lastFailureAt: this.status.lastFailureAt }
              : {}),
          };
      await this.persistStatus().catch(() => {});
      return caughtUp;
    } catch (err) {
      this.logFailure(err);
      this.status = {
        ...this.status,
        dirty: true,
        lastAttemptAt: attemptAt,
        lastFailureAt: new Date().toISOString(),
        lastError: "index_save_failed",
      };
      await this.persistStatus().catch(() => {});
      return false;
    }
  }

  async load(): Promise<{
    bm25: SearchIndex | null;
    vector: VectorIndex | null;
  }> {
    const persistedStatus = await this.kv
      .get<IndexPersistenceStatus>(KV.indexStatus, INDEX_STATUS_KEY)
      .catch(() => null);
    if (persistedStatus && typeof persistedStatus.dirty === "boolean") {
      this.status = { ...persistedStatus };
    }
    let bm25: SearchIndex | null = null;
    let vector: VectorIndex | null = null;

    // Files first; a store from before the files still answers through the
    // KV shards, and the next save writes the files.
    if (this.options.files) {
      const swept = await this.options.files.sweepTemporaries().catch(() => 0);
      if (swept > 0) {
        logger.info("Removed index temp files left by an interrupted save", {
          dir: this.options.files.dir,
          removed: swept,
        });
      }
      const fileBm25 = await this.options.files.readBm25().catch((err) => {
        logger.warn("Index file unreadable; falling back to KV shards", {
          file: this.options.files?.bm25Path,
          error: errorMessage(err),
        });
        return null;
      });
      if (fileBm25) bm25 = SearchIndex.deserialize(fileBm25);
      const fileVector = await this.options.files.readVectors().catch((err) => {
        logger.warn("Index file unreadable; falling back to KV shards", {
          file: this.options.files?.vectorsPath,
          error: errorMessage(err),
        });
        return null;
      });
      if (fileVector) vector = fileVector;
    }

    if (!bm25) {
      const bm25Data = await this.loadBm25Data();
      if (bm25Data && typeof bm25Data === "string") {
        bm25 = SearchIndex.deserialize(bm25Data);
      }
    }

    if (!vector) {
      const vecData = await this.loadVectorData();
      if (vecData && typeof vecData === "string") {
        vector = VectorIndex.deserialize(vecData);
      }
    }

    return { bm25, vector };
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  getStatus(): IndexPersistenceStatus {
    return { ...this.status };
  }

  private persistStatus(): Promise<void> {
    const snapshot = { ...this.status };
    const write = this.statusWrite
      .catch(() => {})
      .then(async () => {
        await this.kv.set(KV.indexStatus, INDEX_STATUS_KEY, snapshot);
      });
    this.statusWrite = write.catch(() => {});
    return write;
  }

  private logFailure(err: unknown): void {
    const now = Date.now();
    // Throttle: persistence failures under load arrive in bursts
    // (iii-engine queue pressure). Logging every debounce flush adds
    // noise without information.
    if (now - this.lastFailureLogAt < FAILURE_LOG_THROTTLE_MS) return;
    this.lastFailureLogAt = now;
    const code = (err as { code?: string })?.code;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("index persistence: failed to save BM25/vector index", {
      code,
      message,
      hint:
        code === "TIMEOUT"
          ? "iii-engine state::set timed out; recent index updates remain in memory and will retry on the next debounce flush"
          : undefined,
    });
  }

  private async saveBm25Index(serialized: string): Promise<void> {
    await this.saveShardedIndex(
      serialized,
      BM25_MANIFEST_KEY,
      BM25_KEY,
      BM25_SHARD_SCOPE_PREFIX,
    );
  }

  private async saveVectorIndex(serialized: string): Promise<void> {
    await this.saveShardedIndex(
      serialized,
      VECTOR_MANIFEST_KEY,
      VECTOR_KEY,
      VECTOR_SHARD_SCOPE_PREFIX,
    );
  }

  private async saveShardedIndex(
    serialized: string,
    manifestKey: string,
    legacyKey: string,
    scopePrefix: string,
  ): Promise<void> {
    const previous = await this.kv
      .get<IndexShardManifest>(KV.bm25Index, manifestKey)
      .catch(() => null);
    const generation =
      this.options.createGeneration?.() ?? createIndexGeneration();
    const chunkChars = shardChars(this.options);
    const shards: IndexShardManifest["shards"] = [];
    const writes: Array<{
      shard: IndexShardManifest["shards"][number];
      chunk: string;
    }> = [];

    for (let offset = 0; offset < serialized.length; offset += chunkChars) {
      const shardIndex = shards.length;
      const chunk = serialized.slice(offset, offset + chunkChars);
      const sha256 = contentHash(chunk);
      const previousShard = previous?.shards?.[shardIndex];
      if (
        previousShard?.chars === chunk.length &&
        previousShard.sha256 === sha256
      ) {
        shards.push(previousShard);
        continue;
      }
      const scope = `${scopePrefix}${generation}:${String(shardIndex).padStart(
        5,
        "0",
      )}`;
      const shard = {
        scope,
        key: INDEX_SHARD_KEY,
        chars: chunk.length,
        sha256,
      };
      shards.push(shard);
      writes.push({ shard, chunk });
    }

    const writeResults = await Promise.allSettled(
      writes.map(async ({ shard, chunk }) => {
        await this.kv.set(shard.scope, shard.key, chunk);
        await this.auditIndexPersistence("shard_write", [
          statePath(shard.scope, shard.key),
        ], {
          scope: shard.scope,
          key: shard.key,
          manifestKey,
          generation,
          chars: chunk.length,
        });
      }),
    );
    const failedWrite = writeResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failedWrite) {
      await this.deleteShards(
        writes.map(({ shard }) => shard),
        "shard_write_rollback",
      );
      throw failedWrite.reason;
    }

    const nextManifest: IndexShardManifest = {
      v: 1,
      generation,
      shards,
      chars: serialized.length,
    };
    try {
      await this.kv.set<IndexShardManifest>(
        KV.bm25Index,
        manifestKey,
        nextManifest,
      );
      await this.auditIndexPersistence("manifest_publish", [
        statePath(KV.bm25Index, manifestKey),
      ], {
        manifestKey,
        generation,
        chars: serialized.length,
        shards: shards.length,
        result: "committed",
      });
    } catch (err) {
      if (await this.isManifestPublished(manifestKey, nextManifest)) {
        await this.auditIndexPersistence("manifest_publish", [
          statePath(KV.bm25Index, manifestKey),
        ], {
          manifestKey,
          generation,
          chars: serialized.length,
          shards: shards.length,
          result: "committed_after_error",
          error: errorMessage(err),
        });
      } else {
        await this.deleteShards(
          writes.map(({ shard }) => shard),
          "manifest_publish_rollback",
        );
      }
      throw err;
    }

    await this.deleteKey(KV.bm25Index, legacyKey, "legacy_cleanup");
    if (previous?.v === 1 && Array.isArray(previous.shards)) {
      const currentShardIds = new Set(
        shards.map((shard) => `${shard.scope}\0${shard.key}`),
      );
      for (const shard of previous.shards) {
        if (currentShardIds.has(`${shard.scope}\0${shard.key}`)) continue;
        await this.deleteShards([shard], "previous_generation_cleanup");
      }
    }
  }

  private async auditIndexPersistence(
    action: string,
    targetIds: string[],
    details: Record<string, unknown>,
  ): Promise<void> {
    if (!isIndexPersistenceAuditEnabled()) return;
    await safeAudit(
      this.kv,
      "index_persist",
      INDEX_PERSISTENCE_FUNCTION_ID,
      targetIds,
      { action, ...details },
    );
  }

  private async deleteKey(
    scope: string,
    key: string,
    reason: string,
  ): Promise<void> {
    let result = "deleted";
    let error: string | undefined;
    try {
      await this.kv.delete(scope, key);
    } catch (err) {
      result = "failed";
      error = errorMessage(err);
    }
    await this.auditIndexPersistence("delete", [statePath(scope, key)], {
      scope,
      key,
      reason,
      result,
      error,
    });
  }

  private async deleteShards(
    shards: IndexShardManifest["shards"],
    reason: string,
  ): Promise<void> {
    for (const shard of shards) {
      await this.deleteKey(shard.scope, shard.key, reason);
    }
  }

  private async isManifestPublished(
    manifestKey: string,
    expected: IndexShardManifest,
  ): Promise<boolean> {
    const published = await this.kv
      .get<IndexShardManifest>(KV.bm25Index, manifestKey)
      .catch(() => null);
    if (
      published?.v !== 1 ||
      published.generation !== expected.generation ||
      published.chars !== expected.chars ||
      !Array.isArray(published.shards) ||
      published.shards.length !== expected.shards.length
    ) {
      return false;
    }
    return published.shards.every((shard, index) => {
      const expectedShard = expected.shards[index];
      if (!expectedShard) return false;
      return (
        shard.scope === expectedShard.scope &&
        shard.key === expectedShard.key &&
        shard.chars === expectedShard.chars &&
        shard.sha256 === expectedShard.sha256
      );
    });
  }

  private async loadBm25Data(): Promise<string | null> {
    return this.loadShardedData(BM25_KEY, BM25_MANIFEST_KEY, "BM25");
  }

  private async loadVectorData(): Promise<string | null> {
    return this.loadShardedData(VECTOR_KEY, VECTOR_MANIFEST_KEY, "vector");
  }

  private async loadShardedData(
    legacyKey: string,
    manifestKey: string,
    label: string,
  ): Promise<string | null> {
    const manifest = await this.readIndexValue<IndexShardManifest>(
      KV.bm25Index,
      manifestKey,
      label,
      "manifest",
    );
    if (!manifest.ok) return null;
    // #797: some iii-state adapters return `undefined` (not `null`) for
    // a missing key. The previous `value !== null` check passed
    // undefined through to loadManifestData, which then crashed on
    // `manifest.v` with TypeError. Treat both null and undefined as
    // "no manifest" and fall through to the legacy path. The shape
    // check stays so a malformed-but-present row still fails closed.
    if (
      manifest.value != null &&
      typeof manifest.value === "object"
    ) {
      return this.loadManifestData(manifest.value, label);
    }

    const legacy = await this.readIndexValue<string>(
      KV.bm25Index,
      legacyKey,
      label,
      "legacy",
    );
    if (!legacy.ok) return null;
    if (legacy.value && typeof legacy.value === "string") return legacy.value;
    return null;
  }

  private async readIndexValue<T>(
    scope: string,
    key: string,
    label: string,
    source: "manifest" | "legacy",
  ): Promise<{ ok: true; value: T | null } | { ok: false }> {
    try {
      return { ok: true, value: await this.kv.get<T>(scope, key) };
    } catch (err) {
      logger.warn(`index persistence: ${label} ${source} read failed`, {
        scope,
        key,
        message: errorMessage(err),
      });
      return { ok: false };
    }
  }

  private async loadManifestData(
    manifest: IndexShardManifest,
    label: string,
  ): Promise<string | null> {
    if (
      manifest.v !== 1 ||
      !Array.isArray(manifest.shards) ||
      manifest.shards.length === 0 ||
      !Number.isInteger(manifest.chars) ||
      manifest.chars < 0
    ) {
      logger.warn(`index persistence: ${label} shard manifest invalid`);
      return null;
    }
    for (const shard of manifest.shards) {
      if (!isValidShardDescriptor(shard)) {
        logger.warn(`index persistence: ${label} shard manifest invalid`);
        return null;
      }
    }
    const loadedShards = await Promise.all(
      manifest.shards.map(async (shard) => ({
        shard,
        chunk: await this.kv.get<string>(shard.scope, shard.key).catch(() => null),
      })),
    );
    const chunks: string[] = [];
    let chars = 0;
    for (const { shard, chunk } of loadedShards) {
      if (typeof chunk !== "string") {
        logger.warn(`index persistence: ${label} shard missing`, {
          scope: shard.scope,
          key: shard.key,
        });
        return null;
      }
      if (chunk.length !== shard.chars) {
        logger.warn(`index persistence: ${label} shard length mismatch`, {
          scope: shard.scope,
          key: shard.key,
          expected: shard.chars,
          actual: chunk.length,
        });
        return null;
      }
      if (shard.sha256 && contentHash(chunk) !== shard.sha256) {
        logger.warn(`index persistence: ${label} shard hash mismatch`, {
          scope: shard.scope,
          key: shard.key,
        });
        return null;
      }
      chunks.push(chunk);
      chars += chunk.length;
    }
    if (chars !== manifest.chars) {
      logger.warn(`index persistence: ${label} total length mismatch`, {
        expected: manifest.chars,
        actual: chars,
      });
      return null;
    }
    return chunks.join("");
  }
}
