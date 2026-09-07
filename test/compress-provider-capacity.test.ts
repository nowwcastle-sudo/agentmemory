import { describe, expect, it } from "vitest";

import { registerCompressFunction } from "../src/functions/compress.js";
import { ProjectionCoordinator } from "../src/functions/projection-coordinator.js";
import { KV } from "../src/state/schema.js";
import type {
  CompressedObservation,
  MemoryProvider,
  RawObservation,
} from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("mem::compress provider capacity", () => {
  it("returns one core whose persisted result matches the public wrapper", async () => {
    const provider: MemoryProvider = {
      name: "core-parity",
      compress: async () => `<type>conversation</type>
<title>Shared compression core</title>
<facts><fact>one implementation serves both paths</fact></facts>
<narrative>Projection uses a shared typed core.</n+<concepts><concept>projection</concept></concepts>
<files></files>
<importance>6</importance>`,
      summarize: async () => "unused",
    };
    const raw: RawObservation = {
      id: "obs_core_parity",
      sessionId: "ses_core_parity",
      timestamp: "2026-09-01T00:00:00.000Z",
      hookType: "conversation",
      userPrompt: "share one compression core",
      raw: { prompt: "share one compression core" },
    };
    const directSdk = mockSdk({ looseTrigger: true });
    const directKv = mockKV();
    const directCore = registerCompressFunction(
      directSdk as never,
      directKv as never,
      provider,
      undefined,
      new ProjectionCoordinator(),
    );
    const wrapperSdk = mockSdk({ looseTrigger: true });
    const wrapperKv = mockKV();
    registerCompressFunction(
      wrapperSdk as never,
      wrapperKv as never,
      provider,
      undefined,
      new ProjectionCoordinator(),
    );

    const direct = await directCore({
      observationId: raw.id,
      sessionId: raw.sessionId,
      raw,
    });
    const wrapped = await wrapperSdk.trigger("mem::compress", {
      observationId: raw.id,
      sessionId: raw.sessionId,
      raw,
    });

    expect(direct).toMatchObject({
      success: true,
      qualityScore: expect.any(Number),
      compressed: { id: raw.id, title: "Shared compression core" },
    });
    expect(wrapped).toMatchObject(direct);
    expect(
      await directKv.get(KV.observations(raw.sessionId), raw.id),
    ).toEqual(await wrapperKv.get(KV.observations(raw.sessionId), raw.id));
  });

  it("defers the public wrapper without mutating observations while another stage is active", async () => {
    const coordinator = new ProjectionCoordinator(1);
    let release!: () => void;
    const active = coordinator.run(
      { stage: "graph", sourceId: "graph-source" },
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const provider: MemoryProvider = {
      name: "must-not-run",
      compress: async () => {
        throw new Error("compression core must not run while busy");
      },
      summarize: async () => "unused",
    };
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerCompressFunction(
      sdk as never,
      kv as never,
      provider,
      undefined,
      coordinator,
    );
    const raw: RawObservation = {
      id: "obs_busy",
      sessionId: "ses_busy",
      timestamp: "2026-09-01T00:00:00.000Z",
      hookType: "conversation",
      raw: { prompt: "busy" },
    };

    await expect(
      sdk.trigger("mem::compress", {
        observationId: raw.id,
        sessionId: raw.sessionId,
        raw,
      }),
    ).resolves.toEqual({
      success: false,
      deferred: true,
      error: "projection_coordinator_busy",
    });
    expect(await kv.list(KV.observations(raw.sessionId))).toHaveLength(0);

    release();
    await active;
  });

  it("inherits immutable sourceClient provenance from raw input", async () => {
    const provider: MemoryProvider = {
      name: "source-provenance",
      compress: async () => `<type>tool_use</type>
<title>Codex observation</title>
<facts><fact>source provenance survives compression</fact></facts>
<narrative>A host observation was compressed.</narrative>
<concepts><concept>provenance</concept></concepts>
<files></files>
<importance>5</importance>`,
      summarize: async () => "unused",
    };
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerCompressFunction(sdk as never, kv as never, provider);
    const raw: RawObservation = {
      id: "obs_source_client",
      sessionId: "ses_source_client",
      timestamp: "2026-08-31T00:00:00.000Z",
      hookType: "post_tool_use",
      raw: { tool_name: "read" },
      sourceClient: "codex",
    };

    const result = (await sdk.trigger("mem::compress", {
      observationId: raw.id,
      sessionId: raw.sessionId,
      raw,
    })) as { success: boolean; compressed: CompressedObservation };

    expect(result.success).toBe(true);
    expect(result.compressed.sourceClient).toBe("codex");
    expect(
      await kv.get<CompressedObservation>(
        KV.observations(raw.sessionId),
        raw.id,
      ),
    ).toMatchObject({ sourceClient: "codex" });
  });

  it("reports local provider saturation as retryable", async () => {
    const capacityError = Object.assign(
      new Error("provider_capacity_timeout"),
      { code: "provider_capacity_timeout" },
    );
    const provider: MemoryProvider = {
      name: "capacity-limited",
      compress: async () => {
        throw capacityError;
      },
      summarize: async () => "unused",
    };
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerCompressFunction(sdk as never, kv as never, provider);
    const raw: RawObservation = {
      id: "obs_capacity",
      sessionId: "ses_capacity",
      timestamp: "2026-08-31T00:00:00.000Z",
      hookType: "conversation",
      userPrompt: "remember this",
      raw: { prompt: "remember this" },
    };

    const result = await sdk.trigger("mem::compress", {
      observationId: raw.id,
      sessionId: raw.sessionId,
      raw,
    });

    expect(result).toEqual({
      success: false,
      error: "provider_capacity_timeout",
      retryable: true,
    });
    expect(await kv.list(KV.observations(raw.sessionId))).toHaveLength(0);
  });
});
