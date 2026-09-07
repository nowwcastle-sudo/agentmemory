import { describe, expect, it, vi } from "vitest";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import {
  MAINTENANCE_PROJECTION_ID,
  queueMaintenanceProjection,
  registerMaintenanceProjectionFunction,
} from "../src/functions/maintenance-projection.js";
import { ProjectionCoordinator } from "../src/functions/projection-coordinator.js";

async function registerMaintenance(
  sdk: ReturnType<typeof mockSdk>,
  kv: ReturnType<typeof mockKV>,
): Promise<boolean> {
  const module = (await import(
    "../src/functions/maintenance-projection.js"
  )) as Record<string, unknown>;
  const register = module.registerMaintenanceProjectionFunction;
  expect(register).toBeTypeOf("function");
  if (typeof register !== "function") return false;
  register(sdk as never, kv as never);
  return true;
}

describe("durable maintenance projection", () => {
  it("defers while another projection stage is active without spending an attempt", async () => {
    const kv = mockKV();
    const sdk = mockSdk({ looseTrigger: true });
    const coordinator = new ProjectionCoordinator(1);
    let release!: () => void;
    const active = coordinator.run(
      { stage: "compression", sourceId: "obs-active" },
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await queueMaintenanceProjection(kv as never);
    registerMaintenanceProjectionFunction(
      sdk as never,
      kv as never,
      coordinator,
    );

    await expect(
      sdk.trigger("mem::project-maintenance", {
        projectionId: MAINTENANCE_PROJECTION_ID,
      }),
    ).resolves.toEqual({
      success: false,
      deferred: true,
      error: "projection_coordinator_busy",
    });
    expect(
      await kv.get(KV.maintenanceProjections, MAINTENANCE_PROJECTION_ID),
    ).toMatchObject({ status: "pending", attempts: 0, stage: "semantic" });

    release();
    await active;
  });

  it("coalesces new requests without resetting an in-flight stage", async () => {
    const kv = mockKV();

    const first = await queueMaintenanceProjection(kv as never);
    const second = await queueMaintenanceProjection(kv as never);
    expect(first).toMatchObject({
      status: "pending",
      requestedGeneration: 1,
      processedGeneration: 0,
      stage: "semantic",
    });
    expect(second).toMatchObject({
      status: "pending",
      requestedGeneration: 2,
      processedGeneration: 0,
      stage: "semantic",
    });

    await kv.set(KV.maintenanceProjections, MAINTENANCE_PROJECTION_ID, {
      ...second,
      status: "running",
      stage: "reflect",
      processingGeneration: 2,
      stageCursor: 3,
    });
    const queuedDuringRun = await queueMaintenanceProjection(kv as never);

    expect(queuedDuringRun).toMatchObject({
      status: "running",
      requestedGeneration: 3,
      processedGeneration: 0,
      processingGeneration: 2,
      stage: "reflect",
      stageCursor: 3,
    });
  });

  it("runs one provider-bearing stage per invocation and persists the next stage", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    const semantic = vi.fn(async () => ({
      success: true,
      results: { semantic: { newFacts: 1 } },
      sourceFingerprint: "semantic-fp",
    }));
    const reflect = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        sourceFingerprint: "reflect-fp",
        nextOffset: 1,
      })
      .mockResolvedValueOnce({
        success: true,
        sourceFingerprint: "reflect-fp",
      });
    sdk.registerFunction("mem::consolidate-pipeline", semantic);
    sdk.registerFunction("mem::reflect", reflect);
    sdk.registerFunction("mem::auto-crystallize", async () => ({
      success: true,
      remainingGroups: 0,
    }));
    if (!(await registerMaintenance(sdk, kv))) return;
    await queueMaintenanceProjection(kv as never);

    const semanticResult = await sdk.trigger("mem::project-maintenance", {
      projectionId: MAINTENANCE_PROJECTION_ID,
    });
    expect(semanticResult).toMatchObject({ success: true, stage: "semantic" });
    expect(semantic).toHaveBeenCalledTimes(1);
    expect(semantic).toHaveBeenCalledWith({
      tier: "semantic",
      force: true,
      strict: true,
    });
    expect(reflect).not.toHaveBeenCalled();
    expect(
      await kv.get(KV.maintenanceProjections, MAINTENANCE_PROJECTION_ID),
    ).toMatchObject({
      status: "pending",
      stage: "reflect",
      processingGeneration: 1,
      attempts: 1,
      stageFingerprints: { semantic: "semantic-fp" },
    });

    const firstReflect = await sdk.trigger("mem::project-maintenance", {
      projectionId: MAINTENANCE_PROJECTION_ID,
    });
    expect(firstReflect).toMatchObject({ success: true, stage: "reflect" });
    expect(reflect).toHaveBeenNthCalledWith(1, {
      maxClusters: 1,
      offset: 0,
      strict: true,
    });
    expect(
      await kv.get(KV.maintenanceProjections, MAINTENANCE_PROJECTION_ID),
    ).toMatchObject({
      status: "pending",
      stage: "reflect",
      stageCursor: 1,
      attempts: 2,
    });

    await sdk.trigger("mem::project-maintenance", {
      projectionId: MAINTENANCE_PROJECTION_ID,
    });
    expect(reflect).toHaveBeenNthCalledWith(2, {
      maxClusters: 1,
      offset: 1,
      strict: true,
    });
    expect(
      await kv.get(KV.maintenanceProjections, MAINTENANCE_PROJECTION_ID),
    ).toMatchObject({
      status: "pending",
      stage: "procedural",
      attempts: 3,
      stageFingerprints: {
        semantic: "semantic-fp",
        reflect: "reflect-fp",
      },
    });
  });

  it("keeps provider capacity exhaustion pending at the same stage", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    sdk.registerFunction("mem::consolidate-pipeline", async () => ({
      success: false,
      error: "provider_capacity_timeout",
    }));
    if (!(await registerMaintenance(sdk, kv))) return;
    await queueMaintenanceProjection(kv as never);

    const result = await sdk.trigger("mem::project-maintenance", {
      projectionId: MAINTENANCE_PROJECTION_ID,
    });

    expect(result).toMatchObject({
      success: false,
      deferred: true,
      error: "provider_capacity_timeout",
    });
    expect(
      await kv.get(KV.maintenanceProjections, MAINTENANCE_PROJECTION_ID),
    ).toMatchObject({
      status: "pending",
      stage: "semantic",
      attempts: 1,
      lastError: "provider_capacity_timeout",
    });
  });

  it("preserves a non-capacity failure for later diagnosis", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    sdk.registerFunction("mem::consolidate-pipeline", async () => ({
      success: false,
      error: "provider_rejected_request",
    }));
    if (!(await registerMaintenance(sdk, kv))) return;
    await queueMaintenanceProjection(kv as never);

    const result = await sdk.trigger("mem::project-maintenance", {
      projectionId: MAINTENANCE_PROJECTION_ID,
    });

    expect(result).toMatchObject({
      success: false,
      error: "provider_rejected_request",
    });
    expect(
      await kv.get(KV.maintenanceProjections, MAINTENANCE_PROJECTION_ID),
    ).toMatchObject({
      status: "failed",
      stage: "semantic",
      attempts: 1,
      lastError: "provider_rejected_request",
    });
  });
});
