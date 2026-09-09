import { describe, expect, it } from "vitest";
import { evaluateHealth } from "../src/health/thresholds.js";
import type { HealthSnapshot } from "../src/types.js";

function snap(over: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    connectionState: "connected",
    workers: [],
    memory: { heapUsed: 0, heapTotal: 1, rss: 0, external: 0 },
    cpu: { userMicros: 0, systemMicros: 0, percent: 0 },
    eventLoopLagMs: 0,
    uptimeSeconds: 1,
    kvConnectivity: { status: "ok", latencyMs: 1 },
    status: "healthy",
    alerts: [],
    ...over,
  };
}

describe("evaluateHealth memory severity", () => {
  it("stays healthy when heap fills a tiny steady-state process (issue #158)", () => {
    const s = snap({
      memory: {
        heapUsed: 45 * 1024 * 1024,
        heapTotal: 46 * 1024 * 1024,
        rss: 120 * 1024 * 1024,
        external: 0,
      },
    });
    const { status, alerts, notes } = evaluateHealth(s);
    expect(status).toBe("healthy");
    expect(alerts.find((a) => a.startsWith("memory_critical_"))).toBeUndefined();
    expect(alerts.find((a) => a.startsWith("memory_warn_"))).toBeUndefined();
    expect(alerts.find((a) => a.startsWith("memory_heap_tight_"))).toBeUndefined();
    expect(notes.find((n) => n.startsWith("memory_heap_tight_"))).toBeDefined();
  });

  it("goes critical when heap ratio is high AND RSS is above the floor", () => {
    const s = snap({
      memory: {
        heapUsed: 970 * 1024 * 1024,
        heapTotal: 1000 * 1024 * 1024,
        rss: 1100 * 1024 * 1024,
        external: 0,
      },
    });
    const { status, alerts } = evaluateHealth(s);
    expect(status).toBe("critical");
    expect(alerts.some((a) => a.startsWith("memory_critical_"))).toBe(true);
  });

  it("records heap_tight in the warn band when RSS is below the floor", () => {
    const s = snap({
      memory: {
        heapUsed: 85 * 1024 * 1024,
        heapTotal: 100 * 1024 * 1024,
        rss: 50 * 1024 * 1024,
        external: 0,
      },
    });
    const { status, alerts, notes } = evaluateHealth(s);
    expect(status).toBe("healthy");
    expect(notes.some((n) => n.startsWith("memory_heap_tight_"))).toBe(true);
    expect(alerts.some((a) => a.startsWith("memory_heap_tight_"))).toBe(false);
    expect(alerts.some((a) => a.startsWith("memory_warn_"))).toBe(false);
    expect(alerts.some((a) => a.startsWith("memory_critical_"))).toBe(false);
  });

  it("goes degraded when heap is above warn AND RSS is above the floor", () => {
    const s = snap({
      memory: {
        heapUsed: 850 * 1024 * 1024,
        heapTotal: 1000 * 1024 * 1024,
        rss: 900 * 1024 * 1024,
        external: 0,
      },
    });
    const { status, alerts } = evaluateHealth(s, { memoryRssFloorBytes: 800 * 1024 * 1024 });
    expect(status).toBe("degraded");
    expect(alerts.some((a) => a.startsWith("memory_warn_"))).toBe(true);
  });

  // The worker runs with no --max-old-space-size, so V8's ceiling is ~4.3 GB
  // while heapTotal tracks a few MB above heapUsed and grows on demand. A
  // healthy process therefore sits at 95-100% of heapTotal permanently, and
  // #158's RSS floor only postpones the false alarm until RSS crosses 512 MB --
  // which the live worker did, reporting memory_critical_98%_rss564mb at 7.8%
  // of the real limit. Measure against the limit when the snapshot carries one.
  it("stays healthy at 98% of heapTotal when the V8 limit is far away", () => {
    const s = snap({
      memory: {
        heapUsed: 335 * 1024 * 1024,
        heapTotal: 342 * 1024 * 1024,
        rss: 591 * 1024 * 1024,
        external: 95 * 1024 * 1024,
        heapLimit: 4288 * 1024 * 1024,
      },
    });
    const { status, alerts } = evaluateHealth(s);
    expect(alerts.some((a) => a.startsWith("memory_critical_"))).toBe(false);
    expect(alerts.some((a) => a.startsWith("memory_warn_"))).toBe(false);
    expect(status).toBe("healthy");
  });

  // The same shape with a limit the process really is about to hit must still
  // alarm -- that is the case the OOM on 2026-09-07 needed and did not get.
  it("goes critical when heapUsed approaches the V8 limit", () => {
    const s = snap({
      memory: {
        heapUsed: 250 * 1024 * 1024,
        heapTotal: 254 * 1024 * 1024,
        rss: 600 * 1024 * 1024,
        external: 0,
        heapLimit: 256 * 1024 * 1024,
      },
    });
    const { status, alerts } = evaluateHealth(s);
    expect(alerts.some((a) => a.startsWith("memory_critical_"))).toBe(true);
    expect(status).toBe("critical");
  });

  it("respects caller-supplied memoryRssFloorBytes", () => {
    const s = snap({
      memory: {
        heapUsed: 98,
        heapTotal: 100,
        rss: 50 * 1024 * 1024,
        external: 0,
      },
    });
    const loose = evaluateHealth(s, { memoryRssFloorBytes: 10 * 1024 * 1024 });
    expect(loose.status).toBe("critical");
    const strict = evaluateHealth(s, { memoryRssFloorBytes: 1024 * 1024 * 1024 });
    expect(strict.status).toBe("healthy");
  });
});

describe("evaluateHealth index snapshot severity", () => {
  const withIndex = (index: Record<string, unknown>) =>
    snap({
      pipeline: {
        compression: { pending: 0, failed: 0 },
        summary: { pending: 0, failed: 0 },
        graph: { pending: 0, failed: 0 },
        index: index as never,
        graphSnapshot: { present: true, dirty: false },
        collectedAt: new Date().toISOString(),
      } as never,
    });

  // lastFailureAt is a high-water mark, not a current state. Testing it against
  // `dirty` alone means one failure days ago alarms on every later dirty
  // window, however many successful snapshots happened in between -- the live
  // worker carried a 2026-09-04 failure against a 2026-09-09 success.
  it("does not alarm when the last snapshot attempt succeeded after the failure", () => {
    const { status, alerts } = evaluateHealth(
      withIndex({
        dirty: true,
        lastFailureAt: "2026-09-04T14:44:36.870Z",
        lastSuccessAt: "2026-09-09T00:15:46.239Z",
      }),
    );
    expect(alerts).not.toContain("index_snapshot_failed");
    expect(status).toBe("healthy");
  });

  it("alarms when the failure is the most recent outcome", () => {
    const { status, alerts } = evaluateHealth(
      withIndex({
        dirty: true,
        lastFailureAt: "2026-09-09T00:20:00.000Z",
        lastSuccessAt: "2026-09-09T00:15:46.239Z",
      }),
    );
    expect(alerts).toContain("index_snapshot_failed");
    expect(status).toBe("degraded");
  });

  it("alarms on a failure with no success ever recorded", () => {
    const { alerts } = evaluateHealth(
      withIndex({ dirty: true, lastFailureAt: "2026-09-09T00:20:00.000Z" }),
    );
    expect(alerts).toContain("index_snapshot_failed");
  });
});

describe("evaluateHealth KV connectivity severity", () => {
  it("goes critical when the KV read/write probe fails", () => {
    const { status, alerts } = evaluateHealth(
      snap({
        kvConnectivity: {
          status: "error",
          error: "kv_probe_failed",
          latencyMs: 5001,
        },
      }),
    );

    expect(status).toBe("critical");
    expect(alerts).toContain("kv_connectivity_error");
  });

  it("goes degraded, not critical, when KV is connected but slow", () => {
    const { status, alerts } = evaluateHealth(
      snap({ kvConnectivity: { status: "ok", latencyMs: 2500 } }),
      { kvLatencyWarnMs: 2000 },
    );

    expect(status).toBe("degraded");
    expect(alerts).toContain("kv_latency_warn_2500ms");
    expect(alerts).not.toContain("kv_connectivity_error");
  });

  it("stays healthy when the KV probe succeeds below the latency threshold", () => {
    expect(
      evaluateHealth(
        snap({ kvConnectivity: { status: "ok", latencyMs: 1999 } }),
        { kvLatencyWarnMs: 2000 },
      ),
    ).toMatchObject({ status: "healthy", alerts: [] });
  });
});
