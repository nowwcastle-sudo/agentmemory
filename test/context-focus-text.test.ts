import { describe, it, expect, vi } from "vitest";
import { registerContextFunction } from "../src/functions/context.js";
import { KV } from "../src/state/schema.js";
import { mockKV } from "./helpers/mocks.js";

// Relevance ranking (commit 427f8a1) scores past summaries against what this
// session is about -- its first prompt and its own observations. At session
// start there is neither: the hook injects context BEFORE the user's first
// prompt reaches the session row, so the focus is empty and selection falls
// back to recency, which is the behaviour v9 measured at 6 of 30.
//
// `focusText` lets a caller that already knows what is being asked -- a
// prompt hook, or an evaluation -- hand it over with the request. It is
// merged with whatever the session row already says, never replaces it.

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

async function seedProject(kv: ReturnType<typeof mockKV>) {
  await kv.set(KV.profiles, "p1", profile);
  // Twelve newer sessions: more than the ten kept, so the old one is only
  // in the context if something ranks it there.
  for (let i = 0; i < 12; i++) {
    const id = `ses_new_${i}`;
    await kv.set(KV.sessions, id, {
      id,
      project: "p1",
      cwd: "/repo/p1",
      startedAt: new Date(Date.UTC(2026, 8, 1 + i)).toISOString(),
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
  // A session row with no first prompt: what a start-of-session inject sees.
  await kv.set(KV.sessions, "ses_now", {
    id: "ses_now",
    project: "p1",
    cwd: "/repo/p1",
    startedAt: "2026-09-20T00:00:00.000Z",
    status: "active",
    observationCount: 0,
  });
}

describe("mem::context focusText", () => {
  it("ranks by the text it is given when the session has no prompt yet", async () => {
    const kv = mockKV();
    await seedProject(kv);
    const context = wireContext(kv);

    const withoutFocus = await context({ sessionId: "ses_now", project: "p1" });
    const withFocus = await context({
      sessionId: "ses_now",
      project: "p1",
      focusText: "why does the retry backoff hammer the API",
    });

    expect(withoutFocus.context).not.toContain("Retry backoff rewrite");
    expect(withFocus.context).toContain("Retry backoff rewrite");
  });

  it("adds to the session's own focus rather than replacing it", async () => {
    const kv = mockKV();
    await seedProject(kv);
    await kv.set(KV.sessions, "ses_now", {
      id: "ses_now",
      project: "p1",
      cwd: "/repo/p1",
      startedAt: "2026-09-20T00:00:00.000Z",
      status: "active",
      observationCount: 0,
      firstPrompt: "the retry backoff keeps firing",
    });
    const context = wireContext(kv);

    const res = await context({
      sessionId: "ses_now",
      project: "p1",
      focusText: "quarterly invoice reconciliation",
    });

    // The row's own prompt still ranks the retry summary in: text the caller
    // adds cannot take away what the session itself is about.
    expect(res.context).toContain("Retry backoff rewrite");
  });

  it("ignores a blank focusText", async () => {
    const kv = mockKV();
    await seedProject(kv);
    const context = wireContext(kv);

    const blank = await context({ sessionId: "ses_now", project: "p1", focusText: "   " });
    const none = await context({ sessionId: "ses_now", project: "p1" });

    expect(blank.context).toBe(none.context);
  });
});
