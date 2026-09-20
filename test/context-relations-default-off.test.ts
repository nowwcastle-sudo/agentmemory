import { describe, it, expect, vi, afterEach } from "vitest";
import { registerContextFunction } from "../src/functions/context.js";
import { KV } from "../src/state/schema.js";
import { mockKV } from "./helpers/mocks.js";

// Measured over 60 recall items on 2026-09-21, after the summary selection
// work: the Relations block costs 0.054 of the score, interval [-0.117,
// -0.004], winning 1 item and losing 5. On 2026-09-19 the same block was
// worth +0.054. The block did not get worse -- the summaries around it got
// better, and now it takes budget from something that answers.
//
// So it is off by default and comes back with
// AGENTMEMORY_RELATIONS_BLOCK=true, because the graph has uses beyond recall
// and the measurement only covers recall.

const profile = {
  project: "p1",
  updatedAt: "2026-09-10T00:00:00.000Z",
  topConcepts: [{ concept: "retry policy", frequency: 9 }],
  topFiles: [],
  conventions: [],
  commonErrors: [],
  recentActivity: [],
  sessionCount: 1,
  totalObservations: 3,
};

type ContextHandler = (data: { sessionId: string; project: string; budget?: number }) => Promise<{
  context: string;
}>;

function wireContext(kv: ReturnType<typeof mockKV>): ContextHandler {
  let handler: ContextHandler | undefined;
  const sdk = {
    registerFunction: vi.fn((id: string, cb: ContextHandler) => {
      if (id === "mem::context") handler = cb;
    }),
  } as unknown as import("iii-sdk").ISdk;
  registerContextFunction(sdk, kv as never, 4000);
  if (!handler) throw new Error("mem::context not registered");
  return handler;
}

async function seed(kv: ReturnType<typeof mockKV>) {
  await kv.set(KV.profiles, "p1", profile);
  await kv.set(KV.graphRelationsIndex, "p1", {
    project: "p1",
    updatedAt: "2026-09-19T00:00:00.000Z",
    relations: [
      {
        source: "branch sync method",
        type: "prefers",
        target: "fast-forward-only merge",
        weight: 0.8,
        backing: 4,
        edgeId: "e1",
      },
    ],
  });
}

afterEach(() => {
  delete process.env.AGENTMEMORY_RELATIONS_BLOCK;
});

describe("the Relations block", () => {
  it("is not rendered by default", async () => {
    const kv = mockKV();
    await seed(kv);

    const res = await wireContext(kv)({ sessionId: "s1", project: "p1" });

    expect(res.context).not.toContain("## Relations");
    // The rest of the context is untouched.
    expect(res.context).toContain("## Project Profile");
  });

  it("comes back when the flag is set", async () => {
    process.env.AGENTMEMORY_RELATIONS_BLOCK = "true";
    const kv = mockKV();
    await seed(kv);

    const res = await wireContext(kv)({ sessionId: "s1", project: "p1" });

    expect(res.context).toContain("## Relations");
  });

  it("treats any other value as off", async () => {
    process.env.AGENTMEMORY_RELATIONS_BLOCK = "1";
    const kv = mockKV();
    await seed(kv);

    const res = await wireContext(kv)({ sessionId: "s1", project: "p1" });

    expect(res.context).not.toContain("## Relations");
  });
});
