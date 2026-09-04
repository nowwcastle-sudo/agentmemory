import { createHash } from "node:crypto";

const TTL_MS = 5 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60_000;

interface DedupEntry {
  hash: string;
  observationId: string;
  expiresAt: number;
}

export class DedupMap {
  private entries = new Map<string, DedupEntry>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  computeHash(sessionId: string, toolName: string, toolInput: unknown): string {
    const input =
      typeof toolInput === "string"
        ? toolInput.slice(0, 500)
        : JSON.stringify(toolInput ?? "").slice(0, 500);
    const raw = `${sessionId}:${toolName}:${input}`;
    return createHash("sha256").update(raw).digest("hex");
  }

  isDuplicate(hash: string): boolean {
    return this.getObservationId(hash) !== undefined;
  }

  getObservationId(hash: string): string | undefined {
    const entry = this.entries.get(hash);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(hash);
      return undefined;
    }
    return entry.observationId;
  }

  record(hash: string, observationId: string): void {
    this.entries.set(hash, {
      hash,
      observationId,
      expiresAt: Date.now() + TTL_MS,
    });
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now > entry.expiresAt) this.entries.delete(key);
    }
  }

  stop(): void {
    clearInterval(this.cleanupTimer);
  }

  get size(): number {
    return this.entries.size;
  }
}
