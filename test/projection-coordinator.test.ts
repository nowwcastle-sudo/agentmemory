import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  ProjectionCoordinator,
  resolveProjectionCapacity,
} from "../src/functions/projection-coordinator.js";

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
    const coordinator = new ProjectionCoordinator(1);
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
    const coordinator = new ProjectionCoordinator(1);
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
      active: 1,
      capacity: 1,
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
    const coordinator = new ProjectionCoordinator(1);
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
    expect(coordinator.status()).toEqual({
      deferredStages: [],
      active: 0,
      capacity: 1,
    });
  });

  it("schedules an idle stage request without retaining it", async () => {
    const coordinator = new ProjectionCoordinator();
    const wake = vi.fn();

    coordinator.request("compression", wake);
    expect(coordinator.status()).toEqual({
      deferredStages: [],
      active: 0,
      capacity: 6,
    });
    expect(wake).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(wake).toHaveBeenCalledOnce();
  });
  it("runs independent sources at the same time up to the capacity", async () => {
    const coordinator = new ProjectionCoordinator(3);
    const releases: Array<() => void> = [];
    const hold = (stage: "compression" | "summary" | "graph", sourceId: string) =>
      coordinator.run({ stage, sourceId }, () =>
        new Promise<string>((resolve) => {
          releases.push(() => resolve(sourceId));
        }));

    const first = hold("compression", "obs-1");
    const second = hold("compression", "obs-2");
    const third = hold("summary", "ses-1");
    await Promise.resolve();

    expect(coordinator.status()).toMatchObject({ active: 3, capacity: 3 });

    // The fourth is refused because every slot is taken, not because it shares
    // a source with anything already running.
    await expect(
      coordinator.run({ stage: "graph", sourceId: "obs-9" }, async () => "no"),
    ).resolves.toMatchObject({
      accepted: false,
      deferred: true,
      error: "projection_coordinator_busy",
    });

    for (const release of releases) release();
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      { accepted: true, value: "obs-1" },
      { accepted: true, value: "obs-2" },
      { accepted: true, value: "ses-1" },
    ]);
  });

  it("never overlaps one source with itself even with capacity to spare", async () => {
    const coordinator = new ProjectionCoordinator(4);
    let release!: () => void;
    const active = coordinator.run(
      { stage: "compression", sourceId: "obs-1" },
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();

    await expect(
      coordinator.run(
        { stage: "compression", sourceId: "obs-1" },
        async () => "second",
      ),
    ).resolves.toEqual({
      accepted: false,
      deferred: true,
      error: "projection_coordinator_busy",
      activeStage: "compression",
    });

    // The same source id under a different stage is independent work.
    await expect(
      coordinator.run({ stage: "graph", sourceId: "obs-1" }, async () => "graph"),
    ).resolves.toEqual({ accepted: true, value: "graph" });

    release();
    await active;
  });

  it("resolves the capacity from the environment and falls back to six", () => {
    expect(resolveProjectionCapacity({})).toBe(6);
    expect(resolveProjectionCapacity({ AGENTMEMORY_PROJECTION_CONCURRENCY: "12" })).toBe(12);
    expect(resolveProjectionCapacity({ AGENTMEMORY_PROJECTION_CONCURRENCY: "1" })).toBe(1);
    expect(resolveProjectionCapacity({ AGENTMEMORY_PROJECTION_CONCURRENCY: "" })).toBe(6);
    expect(resolveProjectionCapacity({ AGENTMEMORY_PROJECTION_CONCURRENCY: "   " })).toBe(6);
    expect(resolveProjectionCapacity({ AGENTMEMORY_PROJECTION_CONCURRENCY: "0" })).toBe(6);
    expect(resolveProjectionCapacity({ AGENTMEMORY_PROJECTION_CONCURRENCY: "nope" })).toBe(6);
  });
});
