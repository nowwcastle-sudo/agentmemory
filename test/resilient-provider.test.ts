import { describe, expect, it, vi } from "vitest";

import { ResilientProvider } from "../src/providers/resilient.js";
import type { MemoryProvider } from "../src/types.js";

describe("ResilientProvider LLM concurrency", () => {
  it("does not count a rejected open-circuit call as another provider failure", async () => {
    let providerCalls = 0;
    const inner: MemoryProvider = {
      name: "always-failing",
      compress: async () => {
        providerCalls += 1;
        throw new Error("remote_failure");
      },
      summarize: async () => "unused",
    };
    const provider = new ResilientProvider(inner, 1);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(provider.compress("system", "input")).rejects.toThrow(
        "remote_failure",
      );
    }
    expect(provider.circuitState).toMatchObject({
      state: "open",
      failures: 3,
    });

    await expect(provider.compress("system", "blocked")).rejects.toThrow(
      "circuit_breaker_open",
    );
    expect(providerCalls).toBe(3);
    expect(provider.circuitState).toMatchObject({
      state: "open",
      failures: 3,
    });
  });

  it("bounds capacity wait without recording a provider failure", async () => {
    let releaseFirst!: () => void;
    let compressStarted = 0;
    let summarizeStarted = 0;
    const inner: MemoryProvider = {
      name: "capacity-controlled",
      compress: async () => {
        compressStarted += 1;
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return "compressed";
      },
      summarize: async () => {
        summarizeStarted += 1;
        return "summarized";
      },
    };

    const provider = new ResilientProvider(inner, 1, 10);
    const first = provider.compress("system", "first");
    await vi.waitFor(() => expect(compressStarted).toBe(1));

    const queued = provider.summarize("system", "queued");
    const outcome = await Promise.race([
      queued.then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({
          status: "rejected" as const,
          message: error instanceof Error ? error.message : String(error),
        }),
      ),
      new Promise<{ status: "waiting" }>((resolve) =>
        setTimeout(() => resolve({ status: "waiting" }), 100),
      ),
    ]);
    const circuitAtCapacity = provider.circuitState;

    releaseFirst();
    await first;
    if (outcome.status === "waiting") await queued;

    expect(outcome).toEqual({
      status: "rejected",
      message: "provider_capacity_timeout",
    });
    expect(summarizeStarted).toBe(0);
    expect(circuitAtCapacity).toMatchObject({ state: "closed", failures: 0 });
    await expect(provider.summarize("system", "after-release")).resolves.toBe(
      "summarized",
    );
  });

  it("serializes provider calls when the maximum concurrency is one", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const started: string[] = [];
    let releaseCompress!: () => void;
    let releaseSummarize!: () => void;

    const inner: MemoryProvider = {
      name: "controlled",
      compress: async () => {
        started.push("compress");
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => {
          releaseCompress = resolve;
        });
        inFlight -= 1;
        return "compressed";
      },
      summarize: async () => {
        started.push("summarize");
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => {
          releaseSummarize = resolve;
        });
        inFlight -= 1;
        return "summarized";
      },
    };

    const provider = new ResilientProvider(inner, 1);
    const compression = provider.compress("system", "observation");
    const summary = provider.summarize("system", "session");

    await vi.waitFor(() => expect(started).toEqual(["compress"]));
    releaseCompress();
    await vi.waitFor(() => expect(started).toEqual(["compress", "summarize"]));
    releaseSummarize();

    await expect(Promise.all([compression, summary])).resolves.toEqual([
      "compressed",
      "summarized",
    ]);
    expect(maxInFlight).toBe(1);
  });

  it("uses AGENTMEMORY_LLM_MAX_CONCURRENCY when no constructor override is passed", async () => {
    const original = process.env.AGENTMEMORY_LLM_MAX_CONCURRENCY;
    process.env.AGENTMEMORY_LLM_MAX_CONCURRENCY = "1";
    const releases: Array<() => void> = [];
    let started = 0;
    const inner: MemoryProvider = {
      name: "configured",
      compress: async () => {
        started += 1;
        await new Promise<void>((resolve) => releases.push(resolve));
        return "done";
      },
      summarize: async () => "done",
    };

    try {
      const provider = new ResilientProvider(inner);
      const first = provider.compress("system", "first");
      const second = provider.compress("system", "second");

      await vi.waitFor(() => expect(started).toBe(1));
      releases.shift()!();
      await vi.waitFor(() => expect(started).toBe(2));
      releases.shift()!();
      await expect(Promise.all([first, second])).resolves.toEqual(["done", "done"]);
    } finally {
      if (original === undefined) {
        delete process.env.AGENTMEMORY_LLM_MAX_CONCURRENCY;
      } else {
        process.env.AGENTMEMORY_LLM_MAX_CONCURRENCY = original;
      }
    }
  });
  it("waits longer for a slot than a call can hold one", () => {
    // A waiter that gives up sooner than an in-flight call can finish is
    // guaranteed to fail once every slot is busy: the slot it is waiting for
    // cannot possibly free up in time. The bound has to outlive one call.
    const previous = process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];
    process.env["AGENTMEMORY_LLM_TIMEOUT_MS"] = "45000";
    try {
      const provider = new ResilientProvider({
        name: "stub",
        isNoop: false,
      } as unknown as MemoryProvider);
      const acquireBound = (provider as unknown as { acquireTimeoutMs: number })
        .acquireTimeoutMs;
      expect(acquireBound).toBeGreaterThan(45_000);
    } finally {
      if (previous === undefined) delete process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];
      else process.env["AGENTMEMORY_LLM_TIMEOUT_MS"] = previous;
    }
  });

  it("honours an explicit acquire bound over the derived one", () => {
    const provider = new ResilientProvider(
      { name: "stub", isNoop: false } as unknown as MemoryProvider,
      2,
      7_000,
    );
    expect(
      (provider as unknown as { acquireTimeoutMs: number }).acquireTimeoutMs,
    ).toBe(7_000);
  });
});
