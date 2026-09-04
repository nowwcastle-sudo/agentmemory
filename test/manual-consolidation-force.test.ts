import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerConsolidationPipelineFunction } from "../src/functions/consolidation-pipeline.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import type { SessionSummary } from "../src/types.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { isConsolidationEnabled } from "../src/config.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  isConsolidationEnabled: vi.fn(() => false),
}));

function provider() {
  return {
    name: "eligible-test-provider",
    compress: vi.fn(),
    summarize: vi.fn().mockResolvedValue(
      '<facts><fact confidence="0.9">Manual consolidation remains available</fact></facts>',
    ),
  };
}

async function seedSummaries(kv: ReturnType<typeof mockKV>): Promise<void> {
  for (let index = 0; index < 5; index++) {
    const summary: SessionSummary = {
      sessionId: `manual_${index}`,
      project: "agentmemory",
      createdAt: `2026-09-0${index + 1}T00:00:00.000Z`,
      title: `Manual source ${index}`,
      narrative: "A source for explicit semantic consolidation.",
      keyDecisions: [],
      filesModified: [],
      concepts: ["manual-consolidation"],
      observationCount: 1,
      sourceFingerprint: `summary-manual-${index}`,
      coveredObservationIds: [`obs_manual_${index}`],
    };
    await kv.set(KV.summaries, summary.sessionId, summary);
  }
}

describe("explicit consolidation force boundary", () => {
  beforeEach(() => {
    vi.mocked(isConsolidationEnabled).mockReturnValue(false);
  });

  it("lets memory_consolidate force one whitelisted tier while automatic consolidation is off", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    await seedSummaries(kv);
    registerConsolidationPipelineFunction(
      sdk as never,
      kv as never,
      provider() as never,
    );
    registerMcpEndpoints(sdk as never, kv as never);
    const trigger = vi.spyOn(sdk, "trigger");

    const response = (await sdk.trigger("mcp::tools::call", {
      body: {
        name: "memory_consolidate",
        arguments: {
          tier: "semantic",
          project: "must-not-cross-boundary",
          strict: false,
        },
      },
      headers: {},
    })) as { status_code: number };

    expect(response.status_code).toBe(200);
    const semantic = await kv.list<{ fact: string }>(KV.semantic);
    expect(semantic).toHaveLength(1);
    expect(semantic[0].fact).toBe("Manual consolidation remains available");
    expect(
      trigger.mock.calls.find(
        ([request]) =>
          typeof request !== "string" &&
          request.function_id === "mem::consolidate-pipeline",
      )?.[0],
    ).toEqual({
      function_id: "mem::consolidate-pipeline",
      payload: { tier: "semantic", force: true },
    });
  });

  it("requires a configured REST secret before auth and forwards only tier plus force", async () => {
    const openSdk = mockSdk({ looseTrigger: true });
    const openKv = mockKV();
    await seedSummaries(openKv);
    registerConsolidationPipelineFunction(
      openSdk as never,
      openKv as never,
      provider() as never,
    );
    registerApiTriggers(openSdk as never, openKv as never);

    await expect(
      openSdk.trigger("api::consolidate-pipeline", {
        body: { tier: "semantic" },
        headers: {},
      }),
    ).resolves.toMatchObject({ status_code: 503 });
    expect(await openKv.list(KV.semantic)).toHaveLength(0);

    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    await seedSummaries(kv);
    registerConsolidationPipelineFunction(
      sdk as never,
      kv as never,
      provider() as never,
    );
    registerApiTriggers(sdk as never, kv as never, "test-only-secret");
    const trigger = vi.spyOn(sdk, "trigger");

    await expect(
      sdk.trigger("api::consolidate-pipeline", {
        body: { tier: "semantic" },
        headers: { authorization: "Bearer wrong" },
      }),
    ).resolves.toMatchObject({ status_code: 401 });
    expect(await kv.list(KV.semantic)).toHaveLength(0);

    await expect(
      sdk.trigger("api::consolidate-pipeline", {
        body: {
          tier: "semantic",
          project: "must-not-cross-boundary",
          strict: false,
          force: false,
        },
        headers: { authorization: "Bearer test-only-secret" },
      }),
    ).resolves.toMatchObject({ status_code: 200 });
    expect(await kv.list(KV.semantic)).toHaveLength(1);
    expect(
      trigger.mock.calls.find(
        ([request]) =>
          typeof request !== "string" &&
          request.function_id === "mem::consolidate-pipeline",
      )?.[0],
    ).toEqual({
      function_id: "mem::consolidate-pipeline",
      payload: { tier: "semantic", force: true },
    });
  });

  it("keeps the scheduled consolidation invocation unforced", () => {
    const source = readFileSync("src/index.ts", "utf-8");
    const start = source.indexOf("if (isConsolidationEnabled())");
    const end = source.indexOf("const shutdown", start);
    const scheduledBlock = source.slice(start, end);

    expect(scheduledBlock).toContain(
      'function_id: "mem::consolidate-pipeline", payload: {}',
    );
    expect(scheduledBlock).not.toContain("force:");
  });
});
