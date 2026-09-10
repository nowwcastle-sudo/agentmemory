import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { describe, it, expect, beforeEach, vi } from "vitest";

const gitMock = vi.hoisted(() => ({
  showState: "",
}));

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, { stdout: "abc1234\n", stderr: "" });
    },
  ),
}));

vi.mock("node:util", async () => {
  const actual = (await vi.importActual("node:util")) as Record<
    string,
    unknown
  >;
  return {
    ...actual,
    promisify:
      () =>
      async (_cmd: string, args: string[]) => ({
        stdout:
          args[0] === "show" ? gitMock.showState : "abc1234\n",
        stderr: "",
      }),
  };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi
    .fn()
    .mockReturnValue('{"version":"0.4.0","sessions":[],"memories":[]}'),
}));

import { registerSnapshotFunction } from "../src/functions/snapshot.js";
import { registerGraphFunction } from "../src/functions/graph.js";
import {
  getSearchIndex,
  rebuildIndex,
} from "../src/functions/search.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import type { Session, Memory, SnapshotMeta } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

describe("Snapshot Functions", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  const snapshotDir = "/tmp/agentmemory-snapshots";

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    vi.clearAllMocks();
    gitMock.showState = "";
    registerSnapshotFunction(sdk as never, kv as never, snapshotDir);

    const session: Session = {
      id: "ses_1",
      project: "test",
      cwd: "/tmp",
      startedAt: "2026-02-01T00:00:00Z",
      status: "completed",
      observationCount: 1,
    };
    await kv.set("mem:sessions", "ses_1", session);

    const mem: Memory = {
      id: "mem_1",
      createdAt: "2026-02-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
      type: "pattern",
      title: "Test pattern",
      content: "Always test",
      concepts: [],
      files: [],
      sessionIds: ["ses_1"],
      strength: 5,
      version: 1,
      isLatest: true,
    };
    await kv.set("mem:memories", "mem_1", mem);
  });

  it("snapshot-create serializes state and returns meta", async () => {
    const result = (await sdk.trigger("mem::snapshot-create", {
      message: "Test snapshot",
    })) as { success: boolean; snapshot: SnapshotMeta };

    expect(result.success).toBe(true);
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot.commitHash).toBe("abc1234");
    expect(result.snapshot.message).toBe("Test snapshot");
    expect(result.snapshot.stats.sessions).toBe(1);
    expect(result.snapshot.stats.memories).toBe(1);
  });

  it("snapshot-create preserves canonical capture and projection state with a valid digest", async () => {
    await kv.set("mem:raw-obs:ses_1", "obs_raw_1", {
      id: "obs_raw_1",
      captureId: "cap_1",
      sessionId: "ses_1",
      timestamp: "2026-02-01T00:00:01Z",
      hookType: "PostToolUse",
      raw: { tool_name: "Read" },
    });
    await kv.set("mem:summaries", "ses_1", {
      sessionId: "ses_1",
      project: "test",
      createdAt: "2026-02-01T00:00:02Z",
      title: "요약",
      narrative: "작업 요약",
      keyDecisions: [],
      filesModified: [],
      concepts: [],
      observationCount: 1,
    });
    await kv.set("mem:profiles", "test", {
      project: "test",
      updatedAt: "2026-02-01T00:00:03Z",
      topConcepts: [],
      topFiles: [],
      conventions: [],
      commonErrors: [],
      recentActivity: [],
      sessionCount: 1,
      totalObservations: 1,
    });
    await kv.set("mem:graph:edges", "edge_1", {
      id: "edge_1",
      type: "related_to",
      sourceNodeId: "node_1",
      targetNodeId: "node_2",
      weight: 1,
      sourceObservationIds: ["obs_raw_1"],
      createdAt: "2026-02-01T00:00:04Z",
    });
    await kv.set("mem:obs:projections", "obs_raw_1", {
      observationId: "obs_raw_1",
      captureId: "cap_1",
      sessionId: "ses_1",
      status: "succeeded",
      attempts: 1,
      updatedAt: "2026-02-01T00:00:05Z",
    });
    await kv.set("mem:graph:projections", "observation:obs_raw_1", {
      sourceKind: "observation",
      sourceId: "obs_raw_1",
      projectId: "test",
      visibility: "project",
      status: "failed",
      attempts: 2,
      updatedAt: "2026-02-01T00:00:06Z",
      lastError: "retry",
    });
    await kv.set("mem:pipeline:graph:failed", "observation:obs_raw_1", {
      id: "observation:obs_raw_1",
      stage: "graph",
      since: "2026-02-01T00:00:06Z",
      updatedAt: "2026-02-01T00:00:06Z",
      lastError: "retry",
    });

    const result = (await sdk.trigger("mem::snapshot-create", {
      message: "Canonical snapshot",
    })) as { success: boolean };
    expect(result.success).toBe(true);

    const stateWrite = vi
      .mocked(writeFileSync)
      .mock.calls.find((call) => String(call[0]).endsWith("state.json"));
    expect(stateWrite).toBeDefined();
    const envelope = JSON.parse(String(stateWrite![1])) as {
      formatVersion: number;
      payload: Record<string, unknown>;
      integrity: { algorithm: string; digest: string };
    };
    expect(envelope.formatVersion).toBe(2);
    expect(envelope.payload.rawObservations).toMatchObject({
      ses_1: [{ id: "obs_raw_1", captureId: "cap_1" }],
    });
    expect(envelope.payload.summaries).toHaveLength(1);
    expect(envelope.payload.profiles).toHaveLength(1);
    expect(envelope.payload.graphEdges).toHaveLength(1);
    expect(envelope.payload.observationProjections).toHaveLength(1);
    expect(envelope.payload.graphProjections).toHaveLength(1);
    expect(envelope.payload.projectionBacklogs).toMatchObject({
      graph: { failed: [{ id: "observation:obs_raw_1" }] },
    });
    expect(envelope.integrity).toEqual({
      algorithm: "sha256",
      digest: createHash("sha256")
        .update(JSON.stringify(envelope.payload))
        .digest("hex"),
    });
  });

  it("snapshot-create excludes graph rows from a prior reset generation", async () => {
    await kv.set("mem:graph:snapshot", "current", {
      version: 1,
      graphGeneration: "ggen_current",
      topNodes: [],
      topEdges: [],
      topDegrees: {},
      stats: {
        totalNodes: 1,
        totalEdges: 0,
        nodesByType: { concept: 1 },
        edgesByType: {},
      },
      updatedAt: "2026-02-01T00:00:00Z",
      dirty: false,
    });
    for (const [id, graphGeneration] of [
      ["node_old", "ggen_old"],
      ["node_current", "ggen_current"],
    ]) {
      await kv.set("mem:graph:nodes", id, {
        id,
        type: "concept",
        name: id,
        properties: {},
        sourceObservationIds: [],
        graphGeneration,
        createdAt: "2026-02-01T00:00:00Z",
      });
    }

    const result = (await sdk.trigger("mem::snapshot-create", {
      message: "Generation filter",
    })) as { success: boolean };
    expect(result.success).toBe(true);
    const stateWrite = vi
      .mocked(writeFileSync)
      .mock.calls.find((call) => String(call[0]).endsWith("state.json"));
    const envelope = JSON.parse(String(stateWrite![1])) as {
      payload: {
        graphGeneration?: string;
        graphNodes: Array<{ id: string }>;
      };
    };
    expect(envelope.payload.graphGeneration).toBe("ggen_current");
    expect(envelope.payload.graphNodes.map((node) => node.id)).toEqual([
      "node_current",
    ]);
  });

  it("snapshot-list returns snapshots from git log", async () => {
    const result = (await sdk.trigger("mem::snapshot-list", {})) as {
      snapshots: Array<{
        commitHash: string;
        createdAt: string;
        message: string;
      }>;
    };

    expect(result.snapshots).toBeDefined();
    expect(Array.isArray(result.snapshots)).toBe(true);
  });

  it("snapshot-restore requires commitHash", async () => {
    const result = (await sdk.trigger("mem::snapshot-restore", {})) as {
      success: boolean;
      error: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toContain("commitHash");
  });

  it("snapshot-restore restores only into an empty target and rebuilds derived state", async () => {
    await kv.set("mem:insights", "ins_restore", {
        id: "ins_restore",
        title: "restored-insight",
        content: "index rows must survive this path",
        confidence: 0.9,
        reinforcements: 0,
        sourceConceptCluster: ["graph"],
        sourceMemoryIds: [],
        sourceLessonIds: [],
        sourceCrystalIds: [],
        tags: [],
        createdAt: "2026-09-10T00:00:00Z",
        updatedAt: "2026-09-10T00:00:00Z",
        decayRate: 0.05,
      });
    await sdk.trigger("mem::snapshot-create", { message: "Restore source" });
    const stateWrite = vi
      .mocked(writeFileSync)
      .mock.calls.find((call) => String(call[0]).endsWith("state.json"));
    gitMock.showState = String(stateWrite![1]);

    const targetKv = mockKV();
    const targetSdk = mockSdk();
    const graphRebuild = vi.fn().mockResolvedValue({ success: true });
    const indexReconcile = vi.fn().mockResolvedValue({ success: true });
    targetSdk.registerFunction("mem::graph-snapshot-rebuild", graphRebuild);
    targetSdk.registerFunction("mem::index-reconcile", indexReconcile);
    registerSnapshotFunction(
      targetSdk as never,
      targetKv as never,
      snapshotDir,
    );

    const result = (await targetSdk.trigger("mem::snapshot-restore", {
      commitHash: "abc1234",
    })) as {
      success: boolean;
      commitHash: string;
      verified?: boolean;
    };

    expect(result.success).toBe(true);
    expect(result.commitHash).toBe("abc1234");
    expect(result.verified).toBe(true);
    expect(await targetKv.get("mem:sessions", "ses_1")).toMatchObject({
      id: "ses_1",
    });
    expect(await targetKv.get("mem:memories", "mem_1")).toMatchObject({
      id: "mem_1",
    });
    expect(graphRebuild).toHaveBeenCalledWith({ force: true });
    expect(indexReconcile).toHaveBeenCalledTimes(1);
    // The insight index is derived state too: a restored store must not
    // leave mem::context falling back to the full scope until someone
    // remembers to rebuild it.
    const rows = await targetKv.list<{ id: string }>("mem:insight:index");
    expect(rows.map((r) => r.id)).toEqual(["ins_restore"]);
  });

  it("round-trips pending, failed, and succeeded session projections", async () => {
    const projections = [
      {
        sessionId: "ses_pending",
        status: "pending",
        attempts: 0,
        observationCount: 2,
        sourceFingerprint: "fp-pending",
        updatedAt: "2026-02-01T00:10:00Z",
      },
      {
        sessionId: "ses_failed",
        status: "failed",
        attempts: 2,
        observationCount: 3,
        sourceFingerprint: "fp-failed",
        updatedAt: "2026-02-01T00:11:00Z",
        lastError: "provider_unavailable",
      },
      {
        sessionId: "ses_succeeded",
        status: "succeeded",
        attempts: 1,
        observationCount: 4,
        sourceFingerprint: "fp-succeeded",
        updatedAt: "2026-02-01T00:12:00Z",
        evictAfterSuccess: true,
      },
    ] as const;
    for (const projection of projections) {
      await kv.set("mem:sessions", projection.sessionId, {
        id: projection.sessionId,
        project: "test",
        cwd: "/tmp",
        startedAt: "2026-02-01T00:00:00Z",
        status: "completed",
        observationCount: projection.observationCount,
      });
      await kv.set(
        "mem:session:projections",
        projection.sessionId,
        projection,
      );
    }

    await sdk.trigger("mem::snapshot-create", { message: "Projection source" });
    const stateWrite = vi
      .mocked(writeFileSync)
      .mock.calls.find((call) => String(call[0]).endsWith("state.json"));
    const envelope = JSON.parse(String(stateWrite![1])) as {
      payload: { sessionProjections?: Array<Record<string, unknown>> };
    };
    expect(envelope.payload.sessionProjections).toEqual(projections);
    gitMock.showState = String(stateWrite![1]);

    const targetKv = mockKV();
    const targetSdk = mockSdk();
    targetSdk.registerFunction("mem::graph-snapshot-rebuild", async () => ({
      success: true,
    }));
    targetSdk.registerFunction("mem::index-reconcile", async () => ({
      success: true,
    }));
    registerSnapshotFunction(targetSdk as never, targetKv as never, snapshotDir);

    const result = (await targetSdk.trigger("mem::snapshot-restore", {
      commitHash: "abc1234",
    })) as { success: boolean };
    expect(result.success).toBe(true);
    expect(await targetKv.list("mem:session:projections")).toEqual(projections);
  });

  it("restores a legacy snapshot without session projection fields", async () => {
    await sdk.trigger("mem::snapshot-create", { message: "Legacy source" });
    const stateWrite = vi
      .mocked(writeFileSync)
      .mock.calls.find((call) => String(call[0]).endsWith("state.json"));
    const envelope = JSON.parse(String(stateWrite![1])) as {
      payload: Record<string, unknown> & {
        projectionBacklogs: Record<string, unknown>;
      };
      integrity: { digest: string };
    };
    delete envelope.payload.sessionProjections;
    delete envelope.payload.projectionBacklogs.summary;
    envelope.integrity.digest = createHash("sha256")
      .update(JSON.stringify(envelope.payload))
      .digest("hex");
    gitMock.showState = JSON.stringify(envelope);

    const targetKv = mockKV();
    const targetSdk = mockSdk();
    targetSdk.registerFunction("mem::graph-snapshot-rebuild", async () => ({
      success: true,
    }));
    targetSdk.registerFunction("mem::index-reconcile", async () => ({
      success: true,
    }));
    registerSnapshotFunction(targetSdk as never, targetKv as never, snapshotDir);

    const result = (await targetSdk.trigger("mem::snapshot-restore", {
      commitHash: "abc1234",
    })) as { success: boolean };
    expect(result.success).toBe(true);
    expect(await targetKv.list("mem:session:projections")).toEqual([]);
  });

  it("snapshot-restore refuses a non-empty canonical target before writing", async () => {
    await sdk.trigger("mem::snapshot-create", { message: "Non-empty guard" });
    const stateWrite = vi
      .mocked(writeFileSync)
      .mock.calls.find((call) => String(call[0]).endsWith("state.json"));
    gitMock.showState = String(stateWrite![1]);

    const setSpy = vi.spyOn(kv, "set");
    setSpy.mockClear();
    const result = (await sdk.trigger("mem::snapshot-restore", {
      commitHash: "abc1234",
    })) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/empty|비어/i);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("snapshot-restore rejects a tampered payload before writing", async () => {
    await sdk.trigger("mem::snapshot-create", { message: "Integrity source" });
    const stateWrite = vi
      .mocked(writeFileSync)
      .mock.calls.find((call) => String(call[0]).endsWith("state.json"));
    const envelope = JSON.parse(String(stateWrite![1])) as {
      payload: { sessions: Array<Record<string, unknown>> };
    };
    envelope.payload.sessions[0]!.project = "tampered";
    gitMock.showState = JSON.stringify(envelope);

    const targetKv = mockKV();
    const setSpy = vi.spyOn(targetKv, "set");
    const targetSdk = mockSdk();
    registerSnapshotFunction(
      targetSdk as never,
      targetKv as never,
      snapshotDir,
    );
    const result = (await targetSdk.trigger("mem::snapshot-restore", {
      commitHash: "abc1234",
    })) as { success: boolean; error: string; targetState?: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/integrity|digest/i);
    expect(result.targetState).toBe("unchanged");
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("snapshot-restore never reports success when a derived rebuild fails", async () => {
    await sdk.trigger("mem::snapshot-create", { message: "Rebuild failure" });
    const stateWrite = vi
      .mocked(writeFileSync)
      .mock.calls.find((call) => String(call[0]).endsWith("state.json"));
    gitMock.showState = String(stateWrite![1]);

    const targetKv = mockKV();
    const targetSdk = mockSdk();
    targetSdk.registerFunction("mem::graph-snapshot-rebuild", async () => ({
      success: false,
      error: "graph rebuild failed",
    }));
    const indexReconcile = vi.fn().mockResolvedValue({ success: true });
    targetSdk.registerFunction("mem::index-reconcile", indexReconcile);
    registerSnapshotFunction(
      targetSdk as never,
      targetKv as never,
      snapshotDir,
    );

    const result = (await targetSdk.trigger("mem::snapshot-restore", {
      commitHash: "abc1234",
    })) as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain("graph rebuild failed");
    expect(indexReconcile).not.toHaveBeenCalled();
  });

  it("snapshot-restore never reports success when index reconciliation fails", async () => {
    await sdk.trigger("mem::snapshot-create", { message: "Index failure" });
    const stateWrite = vi
      .mocked(writeFileSync)
      .mock.calls.find((call) => String(call[0]).endsWith("state.json"));
    gitMock.showState = String(stateWrite![1]);

    const targetKv = mockKV();
    const targetSdk = mockSdk();
    targetSdk.registerFunction("mem::graph-snapshot-rebuild", async () => ({
      success: true,
    }));
    targetSdk.registerFunction("mem::index-reconcile", async () => ({
      success: false,
      error: "index persistence failed",
    }));
    registerSnapshotFunction(
      targetSdk as never,
      targetKv as never,
      snapshotDir,
    );

    const result = (await targetSdk.trigger("mem::snapshot-restore", {
      commitHash: "abc1234",
    })) as { success: boolean; error: string; targetState?: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain("index persistence failed");
    expect(result.targetState).toBe("discard_required");
  });

  it("snapshot-restore marks a target disposable after a canonical write failure", async () => {
    await sdk.trigger("mem::snapshot-create", { message: "Write failure" });
    const stateWrite = vi
      .mocked(writeFileSync)
      .mock.calls.find((call) => String(call[0]).endsWith("state.json"));
    gitMock.showState = String(stateWrite![1]);

    const baseKv = mockKV();
    const targetKv = {
      ...baseKv,
      set: async <T,>(scope: string, key: string, value: T): Promise<T> => {
        if (scope === "mem:memories") throw new Error("memory write failed");
        return baseKv.set(scope, key, value);
      },
    };
    const targetSdk = mockSdk();
    const graphRebuild = vi.fn().mockResolvedValue({ success: true });
    targetSdk.registerFunction("mem::graph-snapshot-rebuild", graphRebuild);
    targetSdk.registerFunction("mem::index-reconcile", async () => ({
      success: true,
    }));
    registerSnapshotFunction(
      targetSdk as never,
      targetKv as never,
      snapshotDir,
    );

    const result = (await targetSdk.trigger("mem::snapshot-restore", {
      commitHash: "abc1234",
    })) as { success: boolean; error: string; targetState?: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain("memory write failed");
    expect(result.targetState).toBe("discard_required");
    expect(graphRebuild).not.toHaveBeenCalled();
  });

  it("snapshot-restore rejects validly hashed malformed records before writing", async () => {
    await sdk.trigger("mem::snapshot-create", { message: "Schema failure" });
    const stateWrite = vi
      .mocked(writeFileSync)
      .mock.calls.find((call) => String(call[0]).endsWith("state.json"));
    const envelope = JSON.parse(String(stateWrite![1])) as {
      payload: { sessions: Array<Record<string, unknown>> };
      integrity: { digest: string };
    };
    delete envelope.payload.sessions[0]!.id;
    envelope.integrity.digest = createHash("sha256")
      .update(JSON.stringify(envelope.payload))
      .digest("hex");
    gitMock.showState = JSON.stringify(envelope);

    const targetKv = mockKV();
    const setSpy = vi.spyOn(targetKv, "set");
    const targetSdk = mockSdk();
    registerSnapshotFunction(
      targetSdk as never,
      targetKv as never,
      snapshotDir,
    );
    const result = (await targetSdk.trigger("mem::snapshot-restore", {
      commitHash: "abc1234",
    })) as { success: boolean; error: string; targetState?: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain("sessions entries require id");
    expect(result.targetState).toBe("unchanged");
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("snapshot-create fails closed when a canonical scope cannot be read", async () => {
    const baseKv = mockKV();
    const failingKv = {
      ...baseKv,
      list: async <T,>(scope: string): Promise<T[]> => {
        if (scope === "mem:graph:edges") throw new Error("graph read failed");
        return baseKv.list<T>(scope);
      },
    };
    const localSdk = mockSdk();
    registerSnapshotFunction(
      localSdk as never,
      failingKv as never,
      snapshotDir,
    );
    vi.mocked(writeFileSync).mockClear();

    const result = (await localSdk.trigger("mem::snapshot-create", {})) as {
      success: boolean;
      error: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toContain("graph read failed");
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("snapshot round-trip rebuilds queryable graph and search state", async () => {
    await kv.set("mem:obs:ses_1", "obs_1", {
      id: "obs_1",
      sessionId: "ses_1",
      timestamp: "2026-02-01T00:00:01Z",
      type: "file_edit",
      title: "Graph restore canary",
      facts: ["restored"],
      narrative: "A searchable restored observation",
      concepts: ["restore"],
      files: ["src/restore.ts"],
      importance: 8,
    });
    await kv.set("mem:graph:nodes", "node_a", {
      id: "node_a",
      type: "concept",
      name: "restore",
      properties: {},
      sourceObservationIds: ["obs_1"],
      createdAt: "2026-02-01T00:00:01Z",
    });
    await kv.set("mem:graph:nodes", "node_b", {
      id: "node_b",
      type: "file",
      name: "src/restore.ts",
      properties: {},
      sourceObservationIds: ["obs_1"],
      createdAt: "2026-02-01T00:00:01Z",
    });
    await kv.set("mem:graph:edges", "edge_restore", {
      id: "edge_restore",
      type: "modifies",
      sourceNodeId: "node_a",
      targetNodeId: "node_b",
      weight: 1,
      sourceObservationIds: ["obs_1"],
      createdAt: "2026-02-01T00:00:01Z",
    });
    await sdk.trigger("mem::snapshot-create", { message: "Round trip" });
    const stateWrite = vi
      .mocked(writeFileSync)
      .mock.calls.find((call) => String(call[0]).endsWith("state.json"));
    gitMock.showState = String(stateWrite![1]);

    const targetKv = mockKV();
    const targetSdk = mockSdk();
    registerGraphFunction(
      targetSdk as never,
      targetKv as never,
      { name: "test", compress: vi.fn(), summarize: vi.fn() } as never,
    );
    getSearchIndex().clear();
    targetSdk.registerFunction("mem::index-reconcile", async () => ({
      success: true,
      indexed: await rebuildIndex(targetKv as never),
    }));
    registerSnapshotFunction(
      targetSdk as never,
      targetKv as never,
      snapshotDir,
    );

    const result = (await targetSdk.trigger("mem::snapshot-restore", {
      commitHash: "abc1234",
    })) as { success: boolean; verified?: boolean };
    expect(result).toMatchObject({ success: true, verified: true });

    const graph = (await targetSdk.trigger("mem::graph-query", {})) as {
      nodes: Array<{ id: string }>;
      edges: Array<{ id: string }>;
    };
    expect(graph.nodes.map((node) => node.id).sort()).toEqual([
      "node_a",
      "node_b",
    ]);
    expect(graph.edges.map((edge) => edge.id)).toEqual(["edge_restore"]);
    expect(getSearchIndex().has("obs_1")).toBe(true);
    expect(getSearchIndex().has("mem_1")).toBe(true);
  });


  it("snapshot round-trips graph-schema rejected assertions", async () => {
    const rejected = { id: "rej:node:n9", kind: "node", reason: "unknown_node_type", record: { id: "n9", type: "metric", name: "p95" }, capturedAt: "2026-09-03T00:00:00.000Z" };
    await kv.set("mem:graph:rejected", rejected.id, rejected);
    const result = (await sdk.trigger("mem::snapshot-create", { message: "with rejected" })) as { success: boolean };
    expect(result.success).toBe(true);
    const stateWrite = vi
      .mocked(writeFileSync)
      .mock.calls.find((call) => String(call[0]).endsWith("state.json"));
    const envelope = JSON.parse(String(stateWrite![1]));
    expect(envelope.payload.graphRejected).toHaveLength(1);
    expect(envelope.payload.graphRejected[0].id).toBe("rej:node:n9");
    gitMock.showState = String(stateWrite![1]);

    const targetKv = mockKV();
    const targetSdk = mockSdk();
    targetSdk.registerFunction("mem::graph-snapshot-rebuild", vi.fn().mockResolvedValue({ success: true }));
    targetSdk.registerFunction("mem::index-reconcile", vi.fn().mockResolvedValue({ success: true }));
    registerSnapshotFunction(targetSdk as never, targetKv as never, snapshotDir);
    const restored = (await targetSdk.trigger("mem::snapshot-restore", { commitHash: "abc1234" })) as { success: boolean };
    expect(restored.success).toBe(true);
    expect(await targetKv.get("mem:graph:rejected", "rej:node:n9")).toMatchObject({ reason: "unknown_node_type" });
  });

  it("snapshot-create records an audit entry", async () => {
    await sdk.trigger("mem::snapshot-create", { message: "Audit test" });

    const audits = await kv.list("mem:audit");
    expect(audits.length).toBe(1);
  });

  it("POST /agentmemory/graph/type-backfill passes the body through to mem::graph-type-backfill", async () => {
    const backfill = vi.fn().mockResolvedValue({ success: true, candidates: 3, asked: 3, typed: 2 });
    sdk.registerFunction("mem::graph-type-backfill", backfill);
    registerApiTriggers(sdk as never, kv as never);

    const res = (await sdk.trigger("api::graph-type-backfill", {
      body: { minBacking: 5, batchSize: 3, skipEdgeIds: ["e_done"] },
      headers: {},
    })) as { status_code: number; body: unknown };
    expect(res.status_code).toBe(200);
    expect(res.body).toEqual({ success: true, candidates: 3, asked: 3, typed: 2 });
    expect(backfill).toHaveBeenCalledWith({ minBacking: 5, batchSize: 3, skipEdgeIds: ["e_done"] });
  });

  it("POST /agentmemory/insight-index/rebuild triggers mem::insight-index-rebuild", async () => {
    const rebuild = vi.fn().mockResolvedValue({ success: true, rows: 3 });
    sdk.registerFunction("mem::insight-index-rebuild", rebuild);
    registerApiTriggers(sdk as never, kv as never);

    const res = (await sdk.trigger("api::insight-index-rebuild", {
      body: {},
      headers: {},
    })) as { status_code: number; body: unknown };
    expect(res.status_code).toBe(200);
    expect(res.body).toEqual({ success: true, rows: 3 });
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it("snapshot REST endpoints do not wrap failed operations in 2xx", async () => {
    sdk.registerFunction("mem::snapshot-create", async () => ({
      success: false,
      error: "snapshot read failed",
    }));
    sdk.registerFunction("mem::snapshot-restore", async () => ({
      success: false,
      error: "index rebuild failed",
      targetState: "discard_required",
    }));
    registerApiTriggers(sdk as never, kv as never);

    const create = (await sdk.trigger("api::snapshot-create", {
      body: {},
      headers: {},
    })) as { status_code: number };
    const restore = (await sdk.trigger("api::snapshot-restore", {
      body: { commitHash: "abc1234" },
      headers: {},
    })) as { status_code: number };
    expect(create.status_code).toBe(500);
    expect(restore.status_code).toBe(500);
  });
});

describe("snapshot-create reentrancy guard", () => {
  // Regression (P2): mem::snapshot-create is triggered by the periodic timer,
  // REST (api::snapshot-create), and MCP. Two runs writing state.json and
  // committing in the same git repo at once race on the index lock. An
  // overlapping call must be a no-op success while the first run finishes.
  it("skips an overlapping call and releases the guard on completion", async () => {
    let releaseFirst!: () => void;
    const firstListGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let listCalls = 0;
    const store = new Map<string, Map<string, unknown>>();
    const gatedKv = {
      get: async () => null,
      set: async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (!store.has(scope)) store.set(scope, new Map());
        store.get(scope)!.set(key, data);
        return data;
      },
      delete: async () => {},
      list: async <T>(scope: string): Promise<T[]> => {
        listCalls++;
        // Park the first snapshot inside its initial list() so a second
        // snapshot-create observes the in-flight guard.
        if (listCalls === 1) await firstListGate;
        return (Array.from(store.get(scope)?.values() ?? []) as T[]) ?? [];
      },
    };
    const localSdk = mockSdk();
    registerSnapshotFunction(localSdk as never, gatedKv as never, "/tmp/reentrant");

    // Start the first snapshot; it parks inside kv.list with the guard held.
    const p1 = localSdk.trigger("mem::snapshot-create", { message: "first" });
    await Promise.resolve();
    await Promise.resolve();

    // Overlapping call: must be rejected as already-in-progress, NOT run git.
    const r2 = (await localSdk.trigger("mem::snapshot-create", {
      message: "second",
    })) as { success: boolean; message?: string; snapshot?: unknown };
    expect(r2).toEqual({
      success: true,
      message: "Snapshot already in progress",
    });
    expect(r2.snapshot).toBeUndefined();

    // Release the first run; it completes normally.
    releaseFirst();
    const r1 = (await p1) as { success: boolean; snapshot?: unknown };
    expect(r1.success).toBe(true);
    expect(r1.snapshot).toBeDefined();

    // Guard is released: a fresh call runs the full body again.
    const r3 = (await localSdk.trigger("mem::snapshot-create", {
      message: "third",
    })) as { success: boolean; snapshot?: unknown };
    expect(r3.success).toBe(true);
    expect(r3.snapshot).toBeDefined();
  });
});
