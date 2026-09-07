export type ProjectionStage =
  | "compression"
  | "summary"
  | "graph"
  | "maintenance";

export type ProjectionWork = {
  stage: ProjectionStage;
  sourceId: string;
};

export type ProjectionCoordinatorStatus = {
  activeStage?: ProjectionStage;
  activeSince?: string;
  deferredStages: ProjectionStage[];
  active: number;
  capacity: number;
};

export type ProjectionRunResult<T> =
  | { accepted: true; value: T }
  | {
      accepted: false;
      deferred: true;
      error: "projection_coordinator_busy";
      activeStage: ProjectionStage;
    };

type ActiveProjection = {
  stage: ProjectionStage;
  activeSince: string;
};

const PROJECTION_PRIORITY = [
  "compression",
  "summary",
  "graph",
  "maintenance",
] as const;

const DEFAULT_PROJECTION_CAPACITY = 6;

/**
 * How many projections may run at once. One slot for the whole worker made the
 * end-to-end service rate `1 / mean projection duration`, so a single LLM call
 * inside a projection stalled every other stage and provider concurrency below
 * it could never take effect.
 */
export function resolveProjectionCapacity(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = (env.AGENTMEMORY_PROJECTION_CONCURRENCY ?? "").trim();
  const configured = raw === "" ? Number.NaN : Number(raw);
  return Number.isFinite(configured) && configured >= 1
    ? Math.floor(configured)
    : DEFAULT_PROJECTION_CAPACITY;
}

export class ProjectionCoordinator {
  private active = new Map<string, ActiveProjection>();
  private requested = new Map<ProjectionStage, () => void>();
  private readonly capacity: number;

  constructor(capacity: number = resolveProjectionCapacity()) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  /**
   * Admission is per `stage` + `sourceId`, so the same source never overlaps
   * itself and independent sources proceed together. Correctness of the shared
   * stores does not rest on this gate: graph writes serialise through their own
   * keyed mutex, and each projection owns its own observation row.
   */
  async run<T>(
    work: ProjectionWork,
    task: () => Promise<T>,
  ): Promise<ProjectionRunResult<T>> {
    const key = `${work.stage} ${work.sourceId}`;
    const sameSource = this.active.get(key);
    const blocking = sameSource ??
      (this.active.size >= this.capacity ? this.oldestActive() : undefined);
    if (blocking) {
      return {
        accepted: false,
        deferred: true,
        error: "projection_coordinator_busy",
        activeStage: blocking.stage,
      };
    }

    this.active.set(key, {
      stage: work.stage,
      activeSince: new Date().toISOString(),
    });
    try {
      return { accepted: true, value: await task() };
    } finally {
      this.active.delete(key);
      this.wakeNext();
    }
  }

  request(stage: ProjectionStage, wake: () => void): void {
    if (this.active.size < this.capacity) {
      queueMicrotask(wake);
      return;
    }
    this.requested.set(stage, wake);
  }

  status(): ProjectionCoordinatorStatus {
    const oldest = this.oldestActive();
    return {
      ...(oldest ? { activeStage: oldest.stage } : {}),
      ...(oldest ? { activeSince: oldest.activeSince } : {}),
      deferredStages: PROJECTION_PRIORITY.filter((stage) =>
        this.requested.has(stage),
      ),
      active: this.active.size,
      capacity: this.capacity,
    };
  }

  private oldestActive(): ActiveProjection | undefined {
    let oldest: ActiveProjection | undefined;
    for (const entry of this.active.values()) {
      if (!oldest || entry.activeSince < oldest.activeSince) oldest = entry;
    }
    return oldest;
  }

  private wakeNext(): void {
    let free = this.capacity - this.active.size;
    for (const stage of PROJECTION_PRIORITY) {
      if (free <= 0) return;
      const wake = this.requested.get(stage);
      if (!wake) continue;
      this.requested.delete(stage);
      free -= 1;
      queueMicrotask(wake);
    }
  }
}
