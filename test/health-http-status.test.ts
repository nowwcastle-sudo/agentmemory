import { describe, expect, it } from "vitest";
import { healthHttpStatus } from "../src/health/thresholds.js";

/**
 * GET /agentmemory/health answered 503 whenever the snapshot said "critical",
 * and "critical" includes a busy CPU (cpu_critical_150%) and a slow event
 * loop. 2026-09-12: a worker that was capturing and searching fine answered
 * 503 for most of an hour, and every monitor read a busy worker as a dead
 * one. The HTTP code now says whether the service can answer at all — the
 * store reachable, the engine connected; load stays in the body's status and
 * alerts, which monitors already read.
 */
const base = {
  status: "critical" as const,
  alerts: ["cpu_critical_150%"],
  kvConnectivity: { status: "ok", latencyMs: 3 },
  connectionState: "connected",
};

describe("healthHttpStatus", () => {
  it("keeps 200 for a busy worker whose store and engine answer", () => {
    expect(healthHttpStatus(base)).toBe(200);
    expect(healthHttpStatus({ ...base, alerts: ["event_loop_lag_critical_2607ms"] })).toBe(200);
    expect(healthHttpStatus({ ...base, status: "degraded", alerts: ["cpu_warn_90%"] })).toBe(200);
  });

  it("answers 503 when the store or the engine is unreachable", () => {
    expect(healthHttpStatus({ ...base, kvConnectivity: { status: "error", latencyMs: 0 } })).toBe(503);
    expect(healthHttpStatus({ ...base, kvConnectivity: { status: "timeout", latencyMs: 180000 } })).toBe(503);
    expect(healthHttpStatus({ ...base, connectionState: "disconnected" })).toBe(503);
  });

  it("answers 200 when there is no snapshot yet", () => {
    expect(healthHttpStatus(null)).toBe(200);
    expect(healthHttpStatus(undefined)).toBe(200);
  });
});
