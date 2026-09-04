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

export class ProjectionCoordinator {
  private active?: ActiveProjection;
  private requested = new Map<ProjectionStage, () => void>();

  async run<T>(
    work: ProjectionWork,
    task: () => Promise<T>,
  ): Promise<ProjectionRunResult<T>> {
    if (this.active) {
      return {
        accepted: false,
        deferred: true,
        error: "projection_coordinator_busy",
        activeStage: this.active.stage,
      };
    }

    this.active = {
      stage: work.stage,
      activeSince: new Date().toISOString(),
    };
    try {
      return { accepted: true, value: await task() };
    } finally {
      this.active = undefined;
      this.wakeNext();
    }
  }

  request(stage: ProjectionStage, wake: () => void): void {
    if (!this.active) {
      queueMicrotask(wake);
      return;
    }
    this.requested.set(stage, wake);
  }

  status(): ProjectionCoordinatorStatus {
    return {
      ...(this.active?.stage ? { activeStage: this.active.stage } : {}),
      ...(this.active?.activeSince
        ? { activeSince: this.active.activeSince }
        : {}),
      deferredStages: PROJECTION_PRIORITY.filter((stage) =>
        this.requested.has(stage),
      ),
    };
  }

  private wakeNext(): void {
    for (const stage of PROJECTION_PRIORITY) {
      const wake = this.requested.get(stage);
      if (!wake) continue;
      this.requested.delete(stage);
      queueMicrotask(wake);
      break;
    }
  }
}
