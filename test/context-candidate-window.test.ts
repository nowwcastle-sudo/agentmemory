import { describe, it, expect, vi } from "vitest";
import { registerContextFunction, scoreSessionCandidate } from "../src/functions/context.js";
import { KV } from "../src/state/schema.js";
import { mockKV } from "./helpers/mocks.js";

// Ranking summaries only helps for sessions that are candidates at all. With
// the 40 most recent as the pool, 19 of the 30 v9 recall items sat outside it
// (ranks 52, 59, 63 ... 114 in their projects) -- unreachable however good
// the score was.
//
// Widening the pool cannot cost a read per session: a summary is one get, and
// 200 gets per injected context is not a context injection any more. But the
// session rows are already in hand, and each carries `firstPrompt`. So the
// pool is chosen from EVERY session of the project on that text alone, and
// only the chosen few have their summaries read.

const profile = {
  project: "p1",
  updatedAt: "2026-09-10T00:00:00.000Z",
  topConcepts: [],
  topFiles: [],
  conventions: [],
  commonErrors: [],
  recentActivity: [],
  sessionCount: 1,
  totalObservations: 3,
};

type ContextHandler = (data: {
  sessionId: string;
  project: string;
  budget?: number;
  focusText?: string;
}) => Promise<{ context: string; blocks: number; tokens: number }>;

function wireContext(kv: ReturnType<typeof mockKV>, budget = 900): ContextHandler {
  let handler: ContextHandler | undefined;
  const sdk = {
    registerFunction: vi.fn((id: string, cb: ContextHandler) => {
      if (id === "mem::context") handler = cb;
    }),
  } as unknown as import("iii-sdk").ISdk;
  registerContextFunction(sdk, kv as never, budget);
  if (!handler) throw new Error("mem::context not registered");
  return handler;
}

describe("scoreSessionCandidate", () => {
  const focus = new Set(["retry", "backoff", "queue.ts"]);

  it("scores a session whose prompt matches the focus above one that does not", () => {
    const onTopic = scoreSessionCandidate(focus, "the retry backoff hammers the API", 50);
    const offTopic = scoreSessionCandidate(focus, "pick the logo colours", 50);

    expect(onTopic).toBeGreaterThan(offTopic);
  });

  it("prefers the newer of two equally relevant sessions", () => {
    expect(scoreSessionCandidate(focus, "retry backoff", 0)).toBeGreaterThan(
      scoreSessionCandidate(focus, "retry backoff", 80),
    );
  });

  it("scores a session with no prompt at all, so it can still be reached", () => {
    expect(scoreSessionCandidate(focus, undefined, 3)).toBeGreaterThan(0);
  });
});

describe("mem::context candidate window", () => {
  it("reaches a matching session far outside the recent window", async () => {
    const kv = mockKV();
    await kv.set(KV.profiles, "p1", profile);
    // 80 newer sessions about something else.
    for (let i = 0; i < 80; i++) {
      const id = `ses_new_${i}`;
      await kv.set(KV.sessions, id, {
        id,
        project: "p1",
        cwd: "/repo/p1",
        startedAt: new Date(Date.UTC(2026, 5, 1 + i)).toISOString(),
        status: "completed",
        observationCount: 1,
        firstPrompt: `pick the logo colours, round ${i}`,
      });
      await kv.set(KV.summaries, id, {
        sessionId: id,
        project: "p1",
        title: `Logo colours round ${i}`,
        narrative: "colour work",
        keyDecisions: ["Use the teal"],
        filesModified: [],
        concepts: [],
        observationCount: 1,
        createdAt: "2026-09-19T00:00:00.000Z",
      });
    }
    // The one that matters, older than all of them.
    await kv.set(KV.sessions, "ses_old", {
      id: "ses_old",
      project: "p1",
      cwd: "/repo/p1",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      observationCount: 1,
      firstPrompt: "the retry backoff in queue.ts hammers the API",
    });
    await kv.set(KV.summaries, "ses_old", {
      sessionId: "ses_old",
      project: "p1",
      title: "Retry backoff rewrite",
      narrative: "reworked retries",
      keyDecisions: ["Back off exponentially, cap at five attempts"],
      filesModified: [],
      concepts: [],
      observationCount: 1,
      createdAt: "2026-01-01T01:00:00.000Z",
    });
    await kv.set(KV.sessions, "ses_now", {
      id: "ses_now",
      project: "p1",
      cwd: "/repo/p1",
      startedAt: "2026-09-20T00:00:00.000Z",
      status: "active",
      observationCount: 0,
    });

    const res = await wireContext(kv)({
      sessionId: "ses_now",
      project: "p1",
      focusText: "what did we decide about the retry backoff in queue.ts",
    });

    expect(res.context).toContain("Retry backoff rewrite");
  });

  it("reads a summary only for the sessions it keeps", async () => {
    const kv = mockKV();
    await kv.set(KV.profiles, "p1", profile);
    for (let i = 0; i < 60; i++) {
      const id = `ses_${i}`;
      await kv.set(KV.sessions, id, {
        id,
        project: "p1",
        cwd: "/repo/p1",
        startedAt: new Date(Date.UTC(2026, 5, 1 + i)).toISOString(),
        status: "completed",
        observationCount: 1,
        firstPrompt: `work item ${i}`,
      });
      await kv.set(KV.summaries, id, {
        sessionId: id,
        project: "p1",
        title: `Work ${i}`,
        narrative: "n",
        keyDecisions: ["d"],
        filesModified: [],
        concepts: [],
        observationCount: 1,
        createdAt: "2026-09-19T00:00:00.000Z",
      });
    }
    await kv.set(KV.sessions, "ses_now", {
      id: "ses_now",
      project: "p1",
      cwd: "/repo/p1",
      startedAt: "2026-09-20T00:00:00.000Z",
      status: "active",
      observationCount: 0,
    });
    const summaryReads: string[] = [];
    const get = kv.get.bind(kv);
    kv.get = (async (scope: string, key: string) => {
      if (scope === KV.summaries) summaryReads.push(key);
      return get(scope, key);
    }) as typeof kv.get;

    await wireContext(kv)({ sessionId: "ses_now", project: "p1" });

    // The pool, not the project: 60 sessions exist, far fewer are read.
    expect(summaryReads.length).toBeLessThanOrEqual(40);
    expect(summaryReads.length).toBeGreaterThan(0);
  });
});
