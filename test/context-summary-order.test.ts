import { describe, it, expect, vi } from "vitest";
import { registerContextFunction } from "../src/functions/context.js";
import { KV } from "../src/state/schema.js";
import { mockKV } from "./helpers/mocks.js";

// Selection picks ten summaries by relevance, and then the budget throws some
// of them away in recency order -- so the one the question is about can be
// chosen and still never rendered. Offline, relevance ranking put the target
// in the top ten for 12 of 30 recall items while the rendered context showed
// it for 7.
//
// The chosen summaries now take each other's places in the recency order:
// the same slots the block mix had before, best-ranked first, so what the
// budget cuts is the least relevant summary rather than the oldest.

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

function wireContext(kv: ReturnType<typeof mockKV>, budget: number): ContextHandler {
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

async function seed(kv: ReturnType<typeof mockKV>) {
  await kv.set(KV.profiles, "p1", profile);
  // Six recent sessions about other things, each with a summary long enough
  // that a small budget cannot hold them all.
  for (let i = 0; i < 6; i++) {
    const id = `ses_${i}`;
    await kv.set(KV.sessions, id, {
      id,
      project: "p1",
      cwd: "/repo/p1",
      startedAt: new Date(Date.UTC(2026, 8, 10 + i)).toISOString(),
      status: "completed",
      observationCount: 1,
      firstPrompt: `unrelated errand number ${i}`,
    });
    await kv.set(KV.summaries, id, {
      sessionId: id,
      project: "p1",
      title: `Errand ${i} for the office`,
      narrative: "a long narrative ".repeat(12),
      keyDecisions: [`Errand decision ${i} that runs on for a while`],
      filesModified: [],
      concepts: [],
      observationCount: 1,
      createdAt: "2026-09-19T00:00:00.000Z",
    });
  }
  // The one the question is about, older than all of them.
  await kv.set(KV.sessions, "ses_target", {
    id: "ses_target",
    project: "p1",
    cwd: "/repo/p1",
    startedAt: "2026-07-01T00:00:00.000Z",
    status: "completed",
    observationCount: 1,
    firstPrompt: "the acquire-timeout in the pool keeps firing",
  });
  await kv.set(KV.summaries, "ses_target", {
    sessionId: "ses_target",
    project: "p1",
    title: "Acquire-timeout fix",
    narrative: "a long narrative ".repeat(12),
    keyDecisions: ["Raise the acquire-timeout to thirty seconds"],
    filesModified: [],
    concepts: [],
    observationCount: 1,
    createdAt: "2026-07-01T01:00:00.000Z",
  });
  await kv.set(KV.sessions, "ses_now", {
    id: "ses_now",
    project: "p1",
    cwd: "/repo/p1",
    startedAt: "2026-09-20T00:00:00.000Z",
    status: "active",
    observationCount: 0,
  });
}

describe("mem::context summary order", () => {
  it("renders the most relevant summary when the budget holds only a few", async () => {
    const kv = mockKV();
    await seed(kv);

    const res = await wireContext(kv, 260)({
      sessionId: "ses_now",
      project: "p1",
      focusText: "what did we decide about the acquire-timeout",
    });

    expect(res.context).toContain("Acquire-timeout fix");
  });

  it("still renders the newest work when nothing matches", async () => {
    const kv = mockKV();
    await seed(kv);

    const res = await wireContext(kv, 260)({ sessionId: "ses_now", project: "p1" });

    expect(res.context).toContain("Errand 5 for the office");
  });
});
