import type { MemoryProvider, CircuitBreakerState } from "../types.js";
import { CircuitBreaker } from "./circuit-breaker.js";

const DEFAULT_MAX_CONCURRENCY = 6;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;

type ProviderWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
};

export class ProviderCapacityError extends Error {
  readonly code = "provider_capacity_timeout";

  constructor() {
    super("provider_capacity_timeout");
    this.name = "ProviderCapacityError";
  }
}

export function isProviderCapacityError(error: unknown): boolean {
  return (
    error instanceof ProviderCapacityError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "provider_capacity_timeout")
  );
}

function configuredMaxConcurrency(): number {
  const raw = process.env.AGENTMEMORY_LLM_MAX_CONCURRENCY;
  if (!raw || !/^\d+$/.test(raw.trim())) return DEFAULT_MAX_CONCURRENCY;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_CONCURRENCY;
}

export class ResilientProvider implements MemoryProvider {
  private breaker = new CircuitBreaker();
  private inFlight = 0;
  private waiters: ProviderWaiter[] = [];
  private acquireTimeoutMs: number;
  name: string;
  readonly isNoop: boolean;

  constructor(
    private inner: MemoryProvider,
    private maxConcurrency = configuredMaxConcurrency(),
    acquireTimeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS,
  ) {
    this.maxConcurrency = Number.isFinite(maxConcurrency)
      ? Math.max(1, Math.floor(maxConcurrency))
      : DEFAULT_MAX_CONCURRENCY;
    this.acquireTimeoutMs =
      Number.isFinite(acquireTimeoutMs) && acquireTimeoutMs > 0
        ? Math.floor(acquireTimeoutMs)
        : DEFAULT_ACQUIRE_TIMEOUT_MS;
    this.name = `resilient(${inner.name})`;
    this.isNoop = inner.isNoop === true;
  }

  private acquire(): Promise<void> {
    if (this.inFlight < this.maxConcurrency) {
      this.inFlight += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter: ProviderWaiter = {
        resolve,
        reject,
        timer: null,
        settled: false,
      };
      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        waiter.reject(new ProviderCapacityError());
      }, this.acquireTimeoutMs);
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    let next = this.waiters.shift();
    while (next) {
      if (!next.settled) {
        next.settled = true;
        if (next.timer) clearTimeout(next.timer);
        next.resolve();
        return;
      }
      next = this.waiters.shift();
    }
    this.inFlight -= 1;
  }

  private async call(fn: () => Promise<string>): Promise<string> {
    await this.acquire();
    if (!this.breaker.isAllowed) {
      this.release();
      throw new Error("circuit_breaker_open");
    }
    try {
      const result = await fn();
      this.breaker.recordSuccess();
      return result;
    } catch (err) {
      this.breaker.recordFailure();
      throw err;
    } finally {
      this.release();
    }
  }

  async compress(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(() => this.inner.compress(systemPrompt, userPrompt));
  }

  async summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(() => this.inner.summarize(systemPrompt, userPrompt));
  }

  get circuitState(): CircuitBreakerState {
    return this.breaker.getState();
  }
}
