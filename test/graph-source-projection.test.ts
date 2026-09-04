import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CompressedObservation,
  GraphNode,
  HookPayload,
  Memory,
  Session,
  SessionSummary,
} from "../src/types.js";
import { KV } from "../src/state/schema.js";
import { registerGraphFunction } from "../src/functions/graph.js";
import { registerGraphSourceProjectionFunction } from "../src/functions/graph-source-projection.js";
import { ProjectionCoordinator } from "../src/functions/projection-coordinator.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import { registerObservationProjectionFunction } from "../src/functions/observation-projection.js";
import { registerRememberFunction } from "../src/functions/remember.js";
import { getSearchIndex, setIndexPersistence } from "../src/functions/search.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const noopProvider = {
  name: "noop",
  compress: vi.fn(),
  summarize: vi.fn(),
};

function session(id = "ses_graph_source"): Session {
  return {
    id,
    project: "agentmemory",
    cwd: "/work/agentmemory",
    startedAt: "2026-08-28T00:00:00.000Z",
    status: "active",
    observationCount: 1,
    agentId: "reviewer",
  };
}

function observation(
  id = "obs_graph_source",
  overrides: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id,
    sessionId: "ses_graph_source",
    timestamp: "2026-08-28T00:00:00.000Z",
    type: "subagent",
    title: "reviewer result",
    facts: [],
    narrative: "Found the graph projection gap",
    concepts: ["JWT"],
    files: ["src/auth.ts"],
    importance: 7,
    agentId: "reviewer",
    ...overrides,
  };
}

function memory(
  id = "mem_graph_source",
  overrides: Partial<Memory> = {},
): Memory {
  return {
    id,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    type: "architecture",
    title: "Use JWT middleware",
    content: "Keep JWT validation in the shared auth middleware",
    concepts: ["jwt"],
    files: ["docs/auth.md"],
    sessionIds: [],
    strength: 7,
    version: 1,
    isLatest: true,
    project: "agentmemory",
    agentId: "architect",
    ...overrides,
  };
}

function registerGraphPipeline(
  sdk: ReturnType<typeof mockSdk>,
  kv: ReturnType<typeof mockKV>,
  provider = noopProvider,
) {
  const coordinator = new ProjectionCoordinator();
  const graphCore = registerGraphFunction(
    sdk as never,
    kv as never,
    provider as never,
    coordinator,
  );
  const projectGraphSourcesCore = registerGraphSourceProjectionFunction(
    sdk as never,
    kv as never,
    graphCore,
    coordinator,
  );
  return { coordinator, graphCore, projectGraphSourcesCore };
}

describe("common graph source projection", () => {
  beforeEach(() => {
    process.env["GRAPH_EXTRACTION_ENABLED"] = "false";
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "false";
  });

  it("returns one core whose persisted result matches the public wrapper", async () => {
    const setup = async (suffix: string) => {
      const sdk = mockSdk();
      const kv = mockKV();
      const coordinator = new ProjectionCoordinator();
      const graphCore = registerGraphFunction(
        sdk as never,
        kv as never,
        noopProvider as never,
        coordinator,
      );
      const projectCore = registerGraphSourceProjectionFunction(
        sdk as never,
        kv as never,
        graphCore,
        coordinator,
      );
      const sessionId = `ses_graph_core_${suffix}`;
      const observationId = `obs_graph_core_${suffix}`;
      await kv.set(KV.sessions, sessionId, session(sessionId));
      await kv.set(
        KV.observations(sessionId),
        observationId,
        observation(observationId, { sessionId }),
      );
      return { sdk, kv, projectCore, sessionId, observationId };
    };
    const direct = await setup("direct");
    const wrapped = await setup("wrapped");
    const directRequest = {
      sources: [
        {
          sourceKind: "observation" as const,
          sourceId: direct.observationId,
          sessionId: direct.sessionId,
        },
      ],
      mode: "structural" as const,
    };
    const wrappedRequest = {
      sources: [
        {
          sourceKind: "observation" as const,
          sourceId: wrapped.observationId,
          sessionId: wrapped.sessionId,
        },
      ],
      mode: "structural" as const,
    };

    const directResult = await direct.projectCore(directRequest);
    const wrappedResult = await wrapped.sdk.trigger(
      "mem::project-graph-sources",
      wrappedRequest,
    );

    expect(directResult).toMatchObject({
      success: true,
      sourcesProjected: 1,
      sourcesFailed: 0,
    });
    expect(wrappedResult).toMatchObject({
      success: true,
      sourcesProjected: 1,
      sourcesFailed: 0,
    });
    expect(await direct.kv.list(KV.graphProjections)).toHaveLength(1);
    expect(await wrapped.kv.list(KV.graphProjections)).toHaveLength(1);
  });

  it("projects persisted observations and memories through one idempotent function", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerGraphPipeline(sdk, kv);
    await kv.set(KV.sessions, "ses_graph_source", session());
    await kv.set(
      KV.observations("ses_graph_source"),
      "obs_graph_source",
      observation(),
    );
    await kv.set(KV.memories, "mem_graph_source", memory());

    const first = (await sdk.trigger("mem::project-graph-sources", {
      sources: [
        {
          sourceKind: "observation",
          sourceId: "obs_graph_source",
          sessionId: "ses_graph_source",
        },
        { sourceKind: "memory", sourceId: "mem_graph_source" },
      ],
    })) as {
      success: boolean;
      sourcesProjected: number;
      nodesAdded: number;
    };

    expect(first).toMatchObject({ success: true, sourcesProjected: 2 });
    expect(first.nodesAdded).toBe(3);
    const projections = await kv.list<{
      sourceKind: string;
      sourceId: string;
      status: string;
      projectId: string;
    }>(KV.graphProjections);
    expect(projections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceKind: "observation",
          sourceId: "obs_graph_source",
          status: "succeeded",
          projectId: "agentmemory",
        }),
        expect.objectContaining({
          sourceKind: "memory",
          sourceId: "mem_graph_source",
          status: "succeeded",
          projectId: "agentmemory",
        }),
      ]),
    );
    expect(projections.every((projection) => !("outcome" in projection))).toBe(
      true,
    );

    const conceptNodes = (await kv.list<GraphNode>(KV.graphNodes)).filter(
      (node) => node.type === "concept" && node.name.toLowerCase() === "jwt",
    );
    expect(conceptNodes).toHaveLength(1);
    expect(conceptNodes[0].sourceObservationIds).toEqual(
      expect.arrayContaining(["obs_graph_source", "mem_graph_source"]),
    );

    const second = (await sdk.trigger("mem::project-graph-sources", {
      sources: [
        {
          sourceKind: "observation",
          sourceId: "obs_graph_source",
          sessionId: "ses_graph_source",
        },
        { sourceKind: "memory", sourceId: "mem_graph_source" },
      ],
    })) as { success: boolean; nodesAdded: number; edgesAdded: number };
    expect(second).toMatchObject({
      success: true,
      nodesAdded: 0,
      edgesAdded: 0,
    });
  });

  it("reprojects unchanged sources after graph reset changes generation", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerGraphPipeline(sdk, kv);
    await kv.set(KV.sessions, "ses_graph_source", session());
    await kv.set(
      KV.observations("ses_graph_source"),
      "obs_graph_source",
      observation(),
    );
    const request = {
      sources: [
        {
          sourceKind: "observation" as const,
          sourceId: "obs_graph_source",
          sessionId: "ses_graph_source",
        },
      ],
    };

    const first = (await sdk.trigger(
      "mem::project-graph-sources",
      request,
    )) as { sourcesProjected: number };
    expect(first.sourcesProjected).toBe(1);
    await sdk.trigger("mem::graph-reset", {});
    const reset = await kv.get<{ graphGeneration?: string }>(
      KV.graphSnapshot,
      "current",
    );

    const second = (await sdk.trigger(
      "mem::project-graph-sources",
      request,
    )) as { sourcesProjected: number; sourcesDeduplicated: number };
    expect(second.sourcesProjected).toBe(1);
    expect(second.sourcesDeduplicated).toBe(0);
    expect(
      await kv.get<{ graphGeneration?: string }>(
        KV.graphProjections,
        "observation:obs_graph_source",
      ),
    ).toMatchObject({ graphGeneration: reset?.graphGeneration });
  });

  it("records an explicit no_structure outcome for a structureless conversation", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerGraphPipeline(sdk, kv);
    await kv.set(KV.sessions, "ses_graph_source", session());
    await kv.set(
      KV.observations("ses_graph_source"),
      "obs_conversation",
      observation("obs_conversation", {
        type: "conversation",
        concepts: [],
        files: [],
      }),
    );

    const result = (await sdk.trigger("mem::project-graph-sources", {
      sources: [
        {
          sourceKind: "observation",
          sourceId: "obs_conversation",
          sessionId: "ses_graph_source",
        },
      ],
    })) as { success: boolean; nodesAdded: number; edgesAdded: number };
    expect(result).toMatchObject({ success: true, nodesAdded: 0, edgesAdded: 0 });
    expect(
      await kv.get<{ status: string; outcome: string }>(
        KV.graphProjections,
        "observation:obs_conversation",
      ),
    ).toMatchObject({ status: "succeeded", outcome: "no_structure" });
  });

  it("never sends mixed project or private-owner scopes to graph extraction", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set(KV.sessions, "ses-a", {
      ...session("ses-a"),
      project: "project-a",
    });
    await kv.set(
      KV.observations("ses-a"),
      "obs-a",
      observation("obs-a", { sessionId: "ses-a" }),
    );
    const memories = [
      memory("mem-a-shared", { project: "project-a", agentId: "agent-b" }),
      memory("mem-b-shared", { project: "project-b", agentId: "agent-a" }),
      memory("mem-a-private", {
        project: "project-a",
        agentId: "agent-a",
        visibility: "agent_private",
      }),
      memory("mem-b-private", {
        project: "project-a",
        agentId: "agent-b",
        visibility: "agent_private",
      }),
    ];
    for (const item of memories) await kv.set(KV.memories, item.id, item);

    const batches: CompressedObservation[][] = [];
    registerGraphSourceProjectionFunction(
      sdk as never,
      kv as never,
      async (payload) => {
        batches.push(payload.observations);
        return { success: true, nodesAdded: 0, edgesAdded: 0 };
      },
      new ProjectionCoordinator(),
    );

    const result = (await sdk.trigger("mem::project-graph-sources", {
      sources: [
        { sourceKind: "observation", sourceId: "obs-a", sessionId: "ses-a" },
        ...memories.map((item) => ({
          sourceKind: "memory",
          sourceId: item.id,
        })),
      ],
    })) as { success: boolean; sourcesProjected: number };

    expect(result).toMatchObject({ success: true, sourcesProjected: 5 });
    expect(batches.map((batch) => batch.length).sort()).toEqual([1, 1, 1, 2]);
    for (const batch of batches) {
      const scopes = new Set(
        batch.map((item) =>
          [
            item.projectId,
            item.visibility,
            item.visibility === "agent_private" ? item.agentId : "",
          ].join("|"),
        ),
      );
      expect(scopes.size).toBe(1);
    }
  });

  it("retries a failed graph projection from persistent state", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set(KV.sessions, "ses_graph_source", session());
    await kv.set(
      KV.observations("ses_graph_source"),
      "obs_retry_graph",
      observation("obs_retry_graph"),
    );
    let fail = true;
    registerGraphSourceProjectionFunction(
      sdk as never,
      kv as never,
      async () => {
        if (fail) {
          fail = false;
          return { success: false, error: "injected graph failure" };
        }
        return { success: true, nodesAdded: 0, edgesAdded: 0 };
      },
      new ProjectionCoordinator(),
    );

    const request = {
      sources: [
        {
          sourceKind: "observation",
          sourceId: "obs_retry_graph",
          sessionId: "ses_graph_source",
        },
      ],
    };
    const first = (await sdk.trigger(
      "mem::project-graph-sources",
      request,
    )) as { success: boolean };
    expect(first.success).toBe(false);
    expect(
      await kv.get<{ status: string; attempts: number }>(
        KV.graphProjections,
        "observation:obs_retry_graph",
      ),
    ).toMatchObject({ status: "failed", attempts: 1 });
    expect(await kv.list(KV.projectionFailed("graph"))).toHaveLength(1);

    const second = (await sdk.trigger(
      "mem::project-graph-sources",
      request,
    )) as { success: boolean };
    expect(second.success).toBe(true);
    expect(
      await kv.get<{ status: string; attempts: number; outcome: string }>(
        KV.graphProjections,
        "observation:obs_retry_graph",
      ),
    ).toMatchObject({
      status: "succeeded",
      attempts: 2,
      outcome: "no_structure",
    });
    expect(await kv.list(KV.projectionPending("graph"))).toHaveLength(0);
    expect(await kv.list(KV.projectionFailed("graph"))).toHaveLength(0);
  });

  it("reprojects a changed source with the same id and count", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set(KV.sessions, "ses_graph_source", session());
    await kv.set(
      KV.observations("ses_graph_source"),
      "obs_changed_graph",
      observation("obs_changed_graph", { concepts: ["before"] }),
    );
    let extracts = 0;
    sdk.registerFunction("mem::graph-extract", async () => {
      extracts += 1;
      return { success: true, nodesAdded: 1, edgesAdded: 0 };
    });
    registerGraphSourceProjectionFunction(sdk as never, kv as never);
    const request = {
      sources: [
        {
          sourceKind: "observation" as const,
          sourceId: "obs_changed_graph",
          sessionId: "ses_graph_source",
        },
      ],
    };

    await sdk.trigger("mem::project-graph-sources", request);
    await kv.set(
      KV.observations("ses_graph_source"),
      "obs_changed_graph",
      observation("obs_changed_graph", { concepts: ["after"] }),
    );
    const second = (await sdk.trigger(
      "mem::project-graph-sources",
      request,
    )) as { sourcesProjected: number };

    expect(second.sourcesProjected).toBe(1);
    expect(extracts).toBe(2);
    expect(
      await kv.get<Record<string, unknown>>(
        KV.graphProjections,
        "observation:obs_changed_graph",
      ),
    ).toMatchObject({
      status: "succeeded",
      sourceFingerprint: expect.any(String),
    });
  });

  it("returns actual new counts and normalizes names across separate extracts", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerGraphPipeline(sdk, kv);

    const first = (await sdk.trigger("mem::graph-extract", {
      observations: [observation("obs_upper", { concepts: ["JWT"], files: [] })],
    })) as { nodesAdded: number };
    const second = (await sdk.trigger("mem::graph-extract", {
      observations: [observation("obs_lower", { concepts: ["jwt"], files: [] })],
    })) as { nodesAdded: number };

    expect(first.nodesAdded).toBe(1);
    expect(second.nodesAdded).toBe(0);
    expect(await kv.list(KV.graphNodes)).toHaveLength(1);
  });

  it("defers a different source immediately while a slow projection is active", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set(KV.sessions, "ses-slow-a", session("ses-slow-a"));
    await kv.set(KV.sessions, "ses-fast-b", session("ses-fast-b"));
    await kv.set(
      KV.observations("ses-slow-a"),
      "obs-slow-a",
      observation("obs-slow-a", { sessionId: "ses-slow-a" }),
    );
    await kv.set(
      KV.observations("ses-fast-b"),
      "obs-fast-b",
      observation("obs-fast-b", { sessionId: "ses-fast-b" }),
    );
    let releaseSlow: (() => void) | undefined;
    const started: string[] = [];
    registerGraphSourceProjectionFunction(
      sdk as never,
      kv as never,
      async (data) => {
        const id = data.observations[0].id;
        started.push(id);
        if (id === "obs-slow-a") {
          await new Promise<void>((resolve) => {
            releaseSlow = resolve;
          });
        }
        return { success: true, nodesAdded: 0, edgesAdded: 0 };
      },
      new ProjectionCoordinator(),
    );

    const slow = sdk.trigger("mem::project-graph-sources", {
      sources: [
        {
          sourceKind: "observation",
          sourceId: "obs-slow-a",
          sessionId: "ses-slow-a",
        },
      ],
    });
    await vi.waitFor(() => expect(started).toContain("obs-slow-a"));
    const fastRequest = {
      sources: [
        {
          sourceKind: "observation",
          sourceId: "obs-fast-b",
          sessionId: "ses-fast-b",
        },
      ],
    };
    const fast = await sdk.trigger("mem::project-graph-sources", fastRequest);

    try {
      expect(fast).toEqual({
        success: false,
        deferred: true,
        error: "projection_coordinator_busy",
      });
      expect(started).not.toContain("obs-fast-b");
    } finally {
      releaseSlow?.();
    }
    await slow;

    await expect(
      sdk.trigger("mem::project-graph-sources", fastRequest),
    ).resolves.toMatchObject({ success: true, sourcesProjected: 1 });
    expect(started).toContain("obs-fast-b");
  });

  it("serializes only the short graph merge so concurrent extracts stay idempotent", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerGraphPipeline(sdk, kv);

    await Promise.all([
      sdk.trigger("mem::graph-extract", {
        observations: [
          observation("obs-concurrent-a", { concepts: ["shared"], files: [] }),
        ],
      }),
      sdk.trigger("mem::graph-extract", {
        observations: [
          observation("obs-concurrent-b", { concepts: ["SHARED"], files: [] }),
        ],
      }),
    ]);

    expect(await kv.list(KV.graphNodes)).toHaveLength(1);
    expect(
      await kv.get<{ stats: { totalNodes: number } }>(
        KV.graphSnapshot,
        "current",
      ),
    ).toMatchObject({ stats: { totalNodes: 1 } });
  });

  it("defers a concurrent projection of the same source without a second extract", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set(KV.sessions, "ses-same-source", session("ses-same-source"));
    await kv.set(
      KV.observations("ses-same-source"),
      "obs-same-source",
      observation("obs-same-source", { sessionId: "ses-same-source" }),
    );
    let release: (() => void) | undefined;
    let extracts = 0;
    registerGraphSourceProjectionFunction(
      sdk as never,
      kv as never,
      async () => {
        extracts += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { success: true, nodesAdded: 0, edgesAdded: 0 };
      },
      new ProjectionCoordinator(),
    );
    const request = {
      sources: [
        {
          sourceKind: "observation" as const,
          sourceId: "obs-same-source",
          sessionId: "ses-same-source",
        },
      ],
    };

    const first = sdk.trigger("mem::project-graph-sources", request);
    await vi.waitFor(() => expect(extracts).toBe(1));
    const second = sdk.trigger("mem::project-graph-sources", request);

    try {
      const secondResult = await Promise.race([
        second,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("same source did not coalesce")), 500),
        ),
      ]);
      expect(secondResult).toEqual({
        success: false,
        deferred: true,
        error: "projection_coordinator_busy",
      });
      expect(extracts).toBe(1);
    } finally {
      release?.();
    }
    await first;
  });

  it("projects an observation structurally without calling the graph provider", async () => {
    process.env["GRAPH_EXTRACTION_ENABLED"] = "true";
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "semantic-test",
      compress: vi.fn(async () => `<entities>
<entity type="concept" name="provider-only"/>
</entities><relationships></relationships>`),
      summarize: vi.fn(),
    };
    registerGraphPipeline(sdk, kv, provider);
    await kv.set(KV.sessions, "ses_graph_source", session());
    await kv.set(
      KV.observations("ses_graph_source"),
      "obs_structural_only",
      observation("obs_structural_only"),
    );

    const result = await sdk.trigger("mem::project-graph-sources", {
      mode: "structural",
      sources: [
        {
          sourceKind: "observation",
          sourceId: "obs_structural_only",
          sessionId: "ses_graph_source",
        },
      ],
    });

    expect(result).toMatchObject({ success: true, sourcesProjected: 1 });
    expect(provider.compress).not.toHaveBeenCalled();
    expect(
      await kv.get(KV.graphProjections, "observation:obs_structural_only"),
    ).toMatchObject({
      status: "succeeded",
      extractionLevel: "structural",
    });
  });

  it("upgrades a summary source from structural to semantic exactly once", async () => {
    process.env["GRAPH_EXTRACTION_ENABLED"] = "true";
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "semantic-test",
      compress: vi.fn(async () => `<entities>
<entity type="concept" name="semantic-session-concept"/>
</entities><relationships></relationships>`),
      summarize: vi.fn(),
    };
    registerGraphPipeline(sdk, kv, provider);
    const activeSession = session("ses_summary_source");
    await kv.set(KV.sessions, activeSession.id, activeSession);
    await kv.set(KV.summaries, activeSession.id, {
      sessionId: activeSession.id,
      project: activeSession.project,
      createdAt: "2026-08-28T00:10:00.000Z",
      title: "Session graph summary",
      narrative: "The session chose a bounded semantic graph.",
      keyDecisions: ["Project summaries rather than every event"],
      filesModified: ["src/functions/graph.ts"],
      concepts: ["bounded enrichment"],
      observationCount: 4,
    } satisfies SessionSummary);
    const request = {
      sources: [
        {
          sourceKind: "summary" as const,
          sourceId: activeSession.id,
          sessionId: activeSession.id,
        },
      ],
    };

    const structural = await sdk.trigger("mem::project-graph-sources", {
      ...request,
      mode: "structural",
    });
    const semantic = await sdk.trigger("mem::project-graph-sources", {
      ...request,
      mode: "semantic",
    });
    const repeated = await sdk.trigger("mem::project-graph-sources", {
      ...request,
      mode: "semantic",
    });

    expect(structural).toMatchObject({ success: true, sourcesProjected: 1 });
    expect(semantic).toMatchObject({ success: true, sourcesProjected: 1 });
    expect(repeated).toMatchObject({
      success: true,
      sourcesProjected: 0,
      sourcesDeduplicated: 1,
    });
    expect(provider.compress).toHaveBeenCalledTimes(1);
    expect(
      await kv.get(KV.graphProjections, `summary:${activeSession.id}`),
    ).toMatchObject({ status: "succeeded", extractionLevel: "semantic" });
  });

  it("keeps structural graph data but fails a requested semantic projection when the provider fails", async () => {
    process.env["GRAPH_EXTRACTION_ENABLED"] = "true";
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "semantic-test",
      compress: vi.fn(async () => {
        throw new Error("injected semantic timeout");
      }),
      summarize: vi.fn(),
    };
    registerGraphPipeline(sdk, kv, provider);
    const activeSession = session("ses_semantic_failure");
    await kv.set(KV.sessions, activeSession.id, activeSession);
    await kv.set(KV.summaries, activeSession.id, {
      sessionId: activeSession.id,
      project: activeSession.project,
      createdAt: "2026-08-28T00:10:00.000Z",
      title: "Preserve structural graph",
      narrative: "Semantic enrichment timed out.",
      keyDecisions: [],
      filesModified: ["src/preserved.ts"],
      concepts: ["preserved concept"],
      observationCount: 1,
    } satisfies SessionSummary);

    const result = await sdk.trigger("mem::project-graph-sources", {
      mode: "semantic",
      sources: [
        {
          sourceKind: "summary",
          sourceId: activeSession.id,
          sessionId: activeSession.id,
        },
      ],
    });

    expect(result).toMatchObject({ success: false, sourcesFailed: 1 });
    expect(await kv.list(KV.graphNodes)).not.toHaveLength(0);
    expect(
      await kv.get(KV.graphProjections, `summary:${activeSession.id}`),
    ).toMatchObject({
      status: "failed",
      extractionLevel: "structural",
      lastError: expect.stringContaining("injected semantic timeout"),
    });
  });
});

describe("new capture and memory wiring", () => {
  beforeEach(() => {
    process.env["GRAPH_EXTRACTION_ENABLED"] = "false";
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "false";
  });

  it("routes a newly captured observation through the common graph projector", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    const pipeline = registerGraphPipeline(sdk, kv);
    registerObservationProjectionFunction(
      sdk as never,
      kv as never,
      undefined,
      pipeline.projectGraphSourcesCore,
      pipeline.coordinator,
    );
    registerObserveFunction(sdk as never, kv as never);
    const payload: HookPayload = {
      captureId: "capture-graph-source",
      hookType: "post_tool_use",
      sessionId: "ses_new_capture",
      project: "agentmemory",
      cwd: "/work/agentmemory",
      timestamp: "2026-08-28T00:00:00.000Z",
      data: {
        tool_name: "Read",
        tool_input: { file_path: "src/index.ts" },
        tool_output: "contents",
      },
    };

    const result = (await sdk.trigger("mem::observe", payload)) as {
      observationId: string;
    };
    await vi.waitFor(async () =>
      expect(
        await kv.get<{ status: string; sourceKind: string }>(
          KV.graphProjections,
          `observation:${result.observationId}`,
        ),
      ).toMatchObject({ status: "succeeded", sourceKind: "observation" }),
    );
    expect(
      await kv.get<{ status: string; sourceKind: string }>(
        KV.graphProjections,
        `observation:${result.observationId}`,
      ),
    ).toMatchObject({ status: "succeeded", sourceKind: "observation" });
  });

  it("routes a newly saved memory through the same graph projector", async () => {
    getSearchIndex().clear();
    setIndexPersistence(null);
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerGraphPipeline(sdk, kv);
    registerRememberFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::remember", {
      content: "Use the shared auth middleware",
      concepts: ["authentication"],
      files: ["src/auth.ts"],
      project: "agentmemory",
    })) as { memory: { id: string } };
    expect(
      await kv.get<{ status: string; sourceKind: string }>(
        KV.graphProjections,
        `memory:${result.memory.id}`,
      ),
    ).toMatchObject({ status: "succeeded", sourceKind: "memory" });
  });
});

describe("api::graph-build common backfill", () => {
  it("backfills observations and sessionless memories idempotently", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerGraphPipeline(sdk, kv);
    registerApiTriggers(sdk as never, kv as never);
    await kv.set(KV.sessions, "ses_graph_source", session());
    await kv.set(
      KV.observations("ses_graph_source"),
      "obs_graph_source",
      observation(),
    );
    await kv.set(KV.memories, "mem_sessionless", memory("mem_sessionless"));

    const first = (await sdk.trigger("api::graph-build", {
      body: { batchSize: 1 },
    })) as {
      status_code: number;
      body: { nodes: number; sources: number; memories: number };
    };
    expect(first.status_code).toBe(200);
    expect(first.body.nodes).toBe(3);
    expect(first.body.sources).toBe(2);
    expect(first.body.memories).toBe(1);

    const second = (await sdk.trigger("api::graph-build", {
      body: { batchSize: 1 },
    })) as { status_code: number; body: { nodes: number; edges: number } };
    expect(second.body).toMatchObject({ nodes: 0, edges: 0 });
  });
});
