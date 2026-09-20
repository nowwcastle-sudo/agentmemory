import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerDiagnosticsFunction } from "../src/functions/diagnostics.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

// The live diagnose returns 298 checks, 279 of them one-per-session warnings
// that a session has been active over 24 hours -- and two real failures sit
// inside that pile. Two things are wrong with the check.
//
// It judges by `startedAt`, so a session that began yesterday and was working
// a minute ago is "abandoned"; what it means to ask is when the session was
// last touched. And it emits a line per session, which turns a fleet-wide
// condition (2026-09-20: 185 sessions left `active` because no end event ever
// arrived) into 279 lines that bury everything else.

const session = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  project: "p1",
  cwd: "/repo/p1",
  startedAt: "2026-09-01T00:00:00.000Z",
  status: "active",
  observationCount: 1,
  ...extra,
});

async function diagnose(sessions: Array<Record<string, unknown>>, now: string) {
  vi.setSystemTime(new Date(now));
  const kv = mockKV();
  for (const s of sessions) await kv.set(KV.sessions, s.id as string, s);
  const sdk = mockSdk({ looseTrigger: true });
  registerDiagnosticsFunction(sdk as never, kv as never);
  const result = await sdk.trigger("mem::diagnose", { categories: ["sessions"] });
  return (result as { checks: Array<{ name: string; status: string; message: string }> }).checks;
}

describe("abandoned session check", () => {
  it("judges by the last activity, not by when the session started", async () => {
    const checks = await diagnose(
      [session("ses_working", { startedAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-20T11:55:00.000Z" })],
      "2026-09-20T12:00:00.000Z",
    );

    expect(checks.some((c) => c.name.startsWith("abandoned-session"))).toBe(false);
  });

  it("still notices a session nothing has touched in a day", async () => {
    const checks = await diagnose(
      [session("ses_stale", { updatedAt: "2026-09-18T00:00:00.000Z" })],
      "2026-09-20T12:00:00.000Z",
    );

    expect(checks.some((c) => c.name.startsWith("abandoned-session"))).toBe(true);
  });

  it("falls back to startedAt when the row has no updatedAt", async () => {
    const checks = await diagnose([session("ses_old")], "2026-09-20T12:00:00.000Z");

    expect(checks.some((c) => c.name.startsWith("abandoned-session"))).toBe(true);
  });

  it("reports many stale sessions as one line, naming a few", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      session(`ses_${i}`, { updatedAt: "2026-09-10T00:00:00.000Z" }),
    );

    const checks = await diagnose(many, "2026-09-20T12:00:00.000Z");
    const abandoned = checks.filter((c) => c.name.startsWith("abandoned-session"));

    expect(abandoned).toHaveLength(1);
    expect(abandoned[0].message).toContain("30");
    // A reader needs somewhere to start, so the line names a few of them.
    expect(abandoned[0].message).toContain("ses_0");
  });

  it("says sessions are healthy when none are stale", async () => {
    const checks = await diagnose(
      [session("ses_live", { updatedAt: "2026-09-20T11:00:00.000Z" })],
      "2026-09-20T12:00:00.000Z",
    );

    expect(checks.some((c) => c.name === "sessions-ok")).toBe(true);
  });
});
