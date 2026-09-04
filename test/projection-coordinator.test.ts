import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ProjectionCoordinator } from "../src/functions/projection-coordinator.js";

describe("ProjectionCoordinator", () => {
  it("loads persisted indexes before starting health and projection recovery drains", () => {
    const source = readFileSync("src/index.ts", "utf8");
    const indexLoad = source.indexOf("const loaded = await indexPersistence.load");
    const healthRegistration = source.indexOf("registerHealthMonitor(");
    const observationRecovery = source.indexOf(
      "observationProjectionRecovery.startRecovery()",
    );
    const sessionRecovery = source.indexOf(
      "sessionProjectionRecovery.startRecovery()",
    );

    expect(indexLoad).toBeGreaterThan(-1);
    expect(healthRegistration).toBeGreaterThan(indexLoad);
    expect(observationRecovery).toBeGreaterThan(indexLoad);
    expect(sessionRecovery).toBeGreaterThan(indexLoad);
  });

  it("defers a second projection without waiting for the active task", async () => {
    const coordinator = new ProjectionCoordinator();
    let release!: () => void;
    const first = coordinator.run(
      { stage: "compression", sourceId: "obs-1" },
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve("first");
        }),
    );

    const second = await coordinator.run(
      { stage: "summary", sourceId: "ses-1" },
      async () => "second",
    );

    expect(second).toEqual({
      accepted: false,
      deferred: true,
      error: "projection_coordinator_busy",
      activeStage: "compression",
    });
    release();
    await expect(first).resolves.toEqual({ accepted: true, value: "first" });
  });

  it("reports only active timing and stage-level deferred work", async () => {
    const coordinator = new ProjectionCoordinator();
    let release!: () => void;
    const active = coordinator.run(
      { stage: "compression", sourceId: "obs-secret" },
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    coordinator.request("summary", vi.fn());

    expect(coordinator.status()).toEqual({
      activeStage: "compression",
      activeSince: expect.any(String),
      deferredStages: ["summary"],
    });
    expect(JSON.stringify(coordinator.status())).not.toContain("obs-secret");

    release();
    await active;
  });

  it("releases admission when an accepted task throws", async () => {
    const coordinator = new ProjectionCoordinator();

    await expect(
      coordinator.run(
        { stage: "graph", sourceId: "obs-1" },
        async () => {
          throw new Error("projection failed");
        },
      ),
    ).rejects.toThrow("projection failed");

    await expect(
      coordinator.run(
        { stage: "summary", sourceId: "ses-1" },
        async () => "recovered",
      ),
    ).resolves.toEqual({ accepted: true, value: "recovered" });
  });

  it("coalesces repeated stage requests and wakes stages by priority", async () => {
    const coordinator = new ProjectionCoordinator();
    const wakeOrder: string[] = [];
    const replacedCompressionWake = vi.fn();
    let release!: () => void;
    const active = coordinator.run(
      { stage: "maintenance", sourceId: "maintenance-projection" },
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    coordinator.request("maintenance", () => wakeOrder.push("maintenance"));
    coordinator.request("graph", () => wakeOrder.push("graph"));
    coordinator.request("compression", replacedCompressionWake);
    coordinator.request("summary", () => wakeOrder.push("summary"));
    coordinator.request("compression", () => wakeOrder.push("compression"));

    expect(coordinator.status().deferredStages).toEqual([
      "compression",
      "summary",
      "graph",
      "maintenance",
    ]);

    release();
    await active;
    await Promise.resolve();
    expect(wakeOrder).toEqual(["compression"]);
    expect(replacedCompressionWake).not.toHaveBeenCalled();

    await coordinator.run(
      { stage: "compression", sourceId: "obs-2" },
      async () => undefined,
    );
    await Promise.resolve();
    await coordinator.run(
      { stage: "summary", sourceId: "ses-2" },
      async () => undefined,
    );
    await Promise.resolve();
    await coordinator.run(
      { stage: "graph", sourceId: "obs-3" },
      async () => undefined,
    );
    await Promise.resolve();

    expect(wakeOrder).toEqual([
      "compression",
      "summary",
      "graph",
      "maintenance",
    ]);
    expect(coordinator.status()).toEqual({ deferredStages: [] });
  });

  it("schedules an idle stage request without retaining it", async () => {
    const coordinator = new ProjectionCoordinator();
    const wake = vi.fn();

    coordinator.request("compression", wake);
    expect(coordinator.status()).toEqual({ deferredStages: [] });
    expect(wake).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(wake).toHaveBeenCalledOnce();
  });
});
