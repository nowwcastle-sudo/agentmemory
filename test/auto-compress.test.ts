import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RawObservation } from "../src/types.js";
import { KV } from "../src/state/schema.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import { registerObservationProjectionFunction } from "../src/functions/observation-projection.js";
import { ProjectionCoordinator } from "../src/functions/projection-coordinator.js";
import { buildSyntheticCompression } from "../src/functions/compress-synthetic.js";
import { mockKV, mockSdk as baseMockSdk } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function mockSdk() {
  const sdk = baseMockSdk({ looseTrigger: true });
  const triggered: Array<{ id: string; data: unknown }> = [];
  const trigger = sdk.trigger.bind(sdk);
  sdk.trigger = async (
    idOrInput:
      | string
      | { function_id: string; payload: unknown; action?: unknown },
    data?: unknown,
  ) => {
    const id =
      typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
    const payload =
      typeof idOrInput === "string" ? data : idOrInput.payload;
    triggered.push({ id, data: payload });
    return trigger(idOrInput as never, data);
  };
  return Object.assign(sdk, { triggered });
}

function validPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sessionId: "ses_test",
    hookType: "post_tool_use",
    timestamp: new Date().toISOString(),
    data: {
      tool_name: "Read",
      tool_input: { file_path: "src/foo.ts" },
      tool_output: "file contents here",
    },
    ...overrides,
  };
}

function registerCapturePipeline(
  sdk: ReturnType<typeof mockSdk>,
  kv: ReturnType<typeof mockKV>,
): void {
  registerObservationProjectionFunction(
    sdk as never,
    kv as never,
    undefined,
    undefined,
    new ProjectionCoordinator(),
  );
  registerObserveFunction(sdk as never, kv as never);
}

describe("mem::observe auto-compress gate (#138)", () => {
  beforeEach(() => {
    delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
  });
  afterEach(() => {
    delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
  });

  it("default (AGENTMEMORY_AUTO_COMPRESS unset): does NOT fire mem::compress", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerCapturePipeline(sdk, kv);

    const result = (await sdk.trigger(
      "mem::observe",
      validPayload(),
    )) as { observationId: string };

    expect(result.observationId).toBeTruthy();
    const compressCalls = sdk.triggered.filter((t) => t.id === "mem::compress");
    expect(compressCalls).toHaveLength(0);
  });

  it("default: stores a synthetic CompressedObservation with the raw-derived fields", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerCapturePipeline(sdk, kv);

    const payload = validPayload();
    await sdk.trigger("mem::observe", payload);

    const rawScope = KV.rawObservations(payload.sessionId);
    const rawStored = kv.store.get(rawScope);
    expect(rawStored).toBeDefined();
    expect(rawStored!.size).toBe(1);
    expect(Array.from(rawStored!.values())[0]).toMatchObject({
      hookType: "post_tool_use",
      raw: payload.data,
    });

    const scope = `mem:obs:${payload.sessionId}`;
    await vi.waitFor(() => expect(kv.store.get(scope)?.size).toBe(1));
    const stored = kv.store.get(scope);
    expect(stored).toBeDefined();
    expect(stored!.size).toBe(1);
    const [entry] = Array.from(stored!.values());
    const obs = entry as {
      type: string;
      title: string;
      files: string[];
      confidence: number;
    };
    expect(obs.type).toBe("file_read");
    expect(obs.title).toBe("Read");
    expect(obs.files).toContain("src/foo.ts");
    expect(obs.confidence).toBe(0.3);
  });

  it("AGENTMEMORY_AUTO_COMPRESS=true: fires mem::compress exactly once", async () => {
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "true";
    const sdk = mockSdk();
    const kv = mockKV();
    registerCapturePipeline(sdk, kv);

    await sdk.trigger("mem::observe", validPayload());

    await vi.waitFor(() =>
      expect(sdk.triggered.filter((t) => t.id === "mem::compress")).toHaveLength(
        1,
      ),
    );
  });

  it("AGENTMEMORY_AUTO_COMPRESS=false explicitly: does NOT fire mem::compress", async () => {
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "false";
    const sdk = mockSdk();
    const kv = mockKV();
    registerCapturePipeline(sdk, kv);

    await sdk.trigger("mem::observe", validPayload());

    const compressCalls = sdk.triggered.filter((t) => t.id === "mem::compress");
    expect(compressCalls).toHaveLength(0);
  });
});

describe("buildSyntheticCompression", () => {
  it("maps common tool names to the right ObservationType", async () => {
    const base: RawObservation = {
      id: "obs_1",
      sessionId: "ses_1",
      timestamp: new Date().toISOString(),
      hookType: "post_tool_use",
      raw: {},
    };
    const cases: Array<[string, string]> = [
      ["Read", "file_read"],
      ["Write", "file_write"],
      ["Edit", "file_edit"],
      ["Bash", "command_run"],
      ["Grep", "search"],
      ["WebFetch", "web_fetch"],
      ["Task", "subagent"],
      ["UnknownTool", "other"],
    ];
    for (const [name, expectedType] of cases) {
      const synthetic = buildSyntheticCompression({ ...base, toolName: name });
      expect(synthetic.type, `${name} -> ${expectedType}`).toBe(expectedType);
    }
  });

  it("extracts file paths from tool_input into the files array", async () => {
    const synth = buildSyntheticCompression({
      id: "obs_2",
      sessionId: "ses_1",
      timestamp: new Date().toISOString(),
      hookType: "post_tool_use",
      toolName: "Edit",
      toolInput: { file_path: "/app/src/bar.ts", pattern: "foo" },
      raw: {},
    });
    expect(synth.files).toContain("/app/src/bar.ts");
    expect(synth.files).toContain("foo");
    expect(synth.type).toBe("file_edit");
  });

  it("truncates long narratives so it can't blow up the index", async () => {
    const longInput = "x".repeat(2000);
    const synth = buildSyntheticCompression({
      id: "obs_3",
      sessionId: "ses_1",
      timestamp: new Date().toISOString(),
      hookType: "post_tool_use",
      toolName: "Bash",
      toolInput: { command: longInput },
      toolOutput: longInput,
      raw: {},
    });
    expect(synth.narrative.length).toBeLessThanOrEqual(400);
  });

  it("maps post_tool_failure to the error type even with no tool name", async () => {
    const synth = buildSyntheticCompression({
      id: "obs_4",
      sessionId: "ses_1",
      timestamp: new Date().toISOString(),
      hookType: "post_tool_failure",
      raw: {},
    });
    expect(synth.type).toBe("error");
  });
});
