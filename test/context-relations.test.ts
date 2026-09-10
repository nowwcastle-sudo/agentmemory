import { describe, it, expect, vi } from "vitest";
import { registerContextFunction } from "../src/functions/context.js";
import { KV } from "../src/state/schema.js";
import type { ProjectProfile } from "../src/types.js";
import { mockKV } from "./helpers/mocks.js";

// The injected context block never carried a graph relation. It now reads the
// project's relations index row -- one get -- and renders a ## Relations block.

type ContextHandler = (data: { sessionId: string; project: string; budget?: number }) =>
  Promise<{ context: string; blocks: number; tokens: number }>;

function wireContext(kv: ReturnType<typeof mockKV>, budget = 4000): ContextHandler {
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

const profile: ProjectProfile = {
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

describe("mem::context relations block", () => {
  it("renders the project's typed relations from the index row and lists no graph scope", async () => {
    const kv = mockKV();
    const listed: string[] = [];
    const list = kv.list.bind(kv);
    kv.list = (async <T,>(scope: string): Promise<T[]> => {
      listed.push(scope);
      return list<T>(scope);
    }) as typeof kv.list;
    await kv.set(KV.profiles, "p1", profile);
    await kv.set(KV.graphRelationsIndex, "p1", {
      project: "p1",
      updatedAt: "2026-09-11T00:00:00.000Z",
      relations: [
        { source: "cache", type: "implements", target: "src/cache.ts", weight: 0.95, backing: 80, edgeId: "e2" },
        { source: "retry policy", type: "implements", target: "src/retry.ts", weight: 0.7, backing: 3, edgeId: "e1" },
      ],
    });

    const context = wireContext(kv);
    const result = await context({ sessionId: "s_now", project: "p1" });

    expect(result.context).toContain("## Relations");
    expect(result.context).toContain("- retry policy --implements--> src/retry.ts (3 obs)");
    expect(result.context).toContain("- cache --implements--> src/cache.ts (80 obs)");
    expect(result.context.indexOf("retry policy --implements")).toBeLessThan(result.context.indexOf("cache --implements"));
    expect(listed).not.toContain(KV.graphNodes);
    expect(listed).not.toContain(KV.graphEdges);
    expect(listed).not.toContain(KV.graphRelationsIndex);
  });

  it("omits the block when the project has no index row", async () => {
    const kv = mockKV();
    await kv.set(KV.profiles, "p1", profile);
    const context = wireContext(kv);
    const result = await context({ sessionId: "s_now", project: "p1" });
    expect(result.context).not.toContain("## Relations");
  });

  it("drops the block, not the rest, when it does not fit the budget", async () => {
    const kv = mockKV();
    await kv.set(KV.profiles, "p1", profile);
    const relations = Array.from({ length: 12 }, (_, i) => ({
      source: `concept number ${i} with a long name`, type: "uses", target: `src/some/deep/path/file_${i}.ts`, weight: 0.9, backing: 10, edgeId: `e${i}`,
    }));
    await kv.set(KV.graphRelationsIndex, "p1", { project: "p1", updatedAt: "2026-09-11T00:00:00.000Z", relations });
    const context = wireContext(kv, 120);
    const result = await context({ sessionId: "s_now", project: "p1" });
    expect(result.context).toContain("## Project Profile");
    expect(result.context).not.toContain("## Relations");
  });
});
