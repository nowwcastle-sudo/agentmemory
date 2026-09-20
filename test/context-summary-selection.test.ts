import { describe, it, expect, vi } from "vitest";
import { registerContextFunction, scoreSummaryCandidate } from "../src/functions/context.js";
import { KV } from "../src/state/schema.js";
import { mockKV } from "./helpers/mocks.js";

// v9 (2026-09-20) measured where recall actually fails. When the asked-about
// session's summary block is in the context the answer is right 0.833 of the
// time; when it is not, 0.052 -- and it was there for 6 of 30 items. Nothing
// was cut by the budget: of the 24 misses, zero had the block present with
// the decision trimmed. The summaries were simply never picked.
//
// They were picked by startedAt alone: the ten newest sessions of the
// project. On an active project a decision from three weeks ago can never
// come back, however exactly it matches what the new session is doing.
//
// Selection now scores candidates against the session's focus (its first
// prompt and its own observations, the same focus the Relations block uses)
// so an older summary about what you are doing right now can displace a
// newer one about something else.

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

type ContextHandler = (data: { sessionId: string; project: string; budget?: number }) => Promise<{
  context: string;
  blocks: number;
  tokens: number;
}>;

function wireContext(kv: ReturnType<typeof mockKV>, budget = 600): ContextHandler {
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

const summary = (id: string, title: string, decisions: string[]) => ({
  sessionId: id,
  project: "p1",
  title,
  narrative: `${title} narrative`,
  keyDecisions: decisions,
  filesModified: [],
  concepts: [],
  observationCount: 2,
  createdAt: "2026-09-19T00:00:00.000Z",
});

describe("scoreSummaryCandidate", () => {
  const focus = new Set(["retry", "backoff", "queue.ts"]);

  it("scores a summary that matches the focus above one that does not", () => {
    const onTopic = scoreSummaryCandidate(focus, summary("s1", "Retry backoff rewrite", ["Back off exponentially"]), 5);
    const offTopic = scoreSummaryCandidate(focus, summary("s2", "Logo colours", ["Use the teal"]), 5);

    expect(onTopic).toBeGreaterThan(offTopic);
  });

  it("prefers the newer of two equally relevant summaries", () => {
    const newer = scoreSummaryCandidate(focus, summary("s1", "Retry backoff rewrite", ["Back off exponentially"]), 0);
    const older = scoreSummaryCandidate(focus, summary("s2", "Retry backoff rewrite", ["Back off exponentially"]), 9);

    expect(newer).toBeGreaterThan(older);
  });

  it("gives an off-topic recent summary a real score, so recency alone still selects", () => {
    expect(scoreSummaryCandidate(new Set(["nothing", "matches"]), summary("s1", "Logo colours", ["Use the teal"]), 0)).toBeGreaterThan(0);
  });
});

describe("mem::context summary selection", () => {
  it("keeps an older on-topic summary over newer off-topic ones", async () => {
    const kv = mockKV();
    await kv.set(KV.profiles, "p1", profile);
    // Nine newer sessions about something else, one older about the focus.
    for (let i = 0; i < 9; i++) {
      const id = `ses_new_${i}`;
      await kv.set(KV.sessions, id, {
        id,
        project: "p1",
        cwd: "/repo/p1",
        startedAt: `2026-09-1${i} 00:00:00`,
        status: "completed",
        observationCount: 1,
      });
      await kv.set(KV.summaries, id, summary(id, `Logo colours round ${i}`, ["Use the teal"]));
    }
    await kv.set(KV.sessions, "ses_old", {
      id: "ses_old",
      project: "p1",
      cwd: "/repo/p1",
      startedAt: "2026-08-01T00:00:00.000Z",
      status: "completed",
      observationCount: 1,
    });
    await kv.set(KV.summaries, "ses_old", summary("ses_old", "Retry backoff rewrite", ["Back off exponentially, cap at five attempts"]));
    // The new session is about retries: its own first prompt says so.
    await kv.set(KV.sessions, "ses_now", {
      id: "ses_now",
      project: "p1",
      cwd: "/repo/p1",
      startedAt: "2026-09-20T00:00:00.000Z",
      status: "active",
      observationCount: 0,
      firstPrompt: "the retry backoff in queue.ts still hammers the API",
    });

    const context = await wireContext(kv)({ sessionId: "ses_now", project: "p1" });

    expect(context.context).toContain("Retry backoff rewrite");
  });

  it("still fills the context with recent work when nothing matches the focus", async () => {
    const kv = mockKV();
    await kv.set(KV.profiles, "p1", profile);
    for (let i = 0; i < 3; i++) {
      const id = `ses_${i}`;
      await kv.set(KV.sessions, id, {
        id,
        project: "p1",
        cwd: "/repo/p1",
        startedAt: `2026-09-1${i}T00:00:00.000Z`,
        status: "completed",
        observationCount: 1,
      });
      await kv.set(KV.summaries, id, summary(id, `Unrelated work ${i}`, ["Something else"]));
    }
    await kv.set(KV.sessions, "ses_now", {
      id: "ses_now",
      project: "p1",
      cwd: "/repo/p1",
      startedAt: "2026-09-20T00:00:00.000Z",
      status: "active",
      observationCount: 0,
      firstPrompt: "nothing in common with any of that",
    });

    const context = await wireContext(kv)({ sessionId: "ses_now", project: "p1" });

    expect(context.context).toContain("Unrelated work 2");
  });
});
