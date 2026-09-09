import type { ISdk } from "../iii-compat.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { KV } from "../state/schema.js";
import type { MaintenanceProjection } from "../types.js";
import { ProjectionCoordinator } from "./projection-coordinator.js";

export const MAINTENANCE_PROJECTION_ID = "global";

type StageResult = {
  success?: boolean;
  error?: string;
  sourceFingerprint?: string;
  nextOffset?: number;
  remainingGroups?: number;
};

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

async function runStage(
  sdk: ISdk,
  projection: MaintenanceProjection,
): Promise<StageResult> {
  if (projection.stage === "semantic" || projection.stage === "procedural") {
    const previousSourceFingerprint =
      projection.stageFingerprints?.[projection.stage];
    return (await sdk.trigger({
      function_id: "mem::consolidate-pipeline",
      payload: {
        tier: projection.stage,
        force: true,
        strict: true,
        ...(previousSourceFingerprint ? { previousSourceFingerprint } : {}),
      },
    })) as StageResult;
  }
  if (projection.stage === "reflect") {
    const previousSourceFingerprint =
      projection.stageCursor === undefined
        ? projection.stageFingerprints?.reflect
        : undefined;
    return (await sdk.trigger({
      function_id: "mem::reflect",
      payload: {
        maxClusters: 1,
        offset: projection.stageCursor ?? 0,
        strict: true,
        ...(previousSourceFingerprint ? { previousSourceFingerprint } : {}),
      },
    })) as StageResult;
  }
  if (projection.stage === "crystallize") {
    return (await sdk.trigger({
      function_id: "mem::auto-crystallize",
      payload: { olderThanDays: 0, maxGroups: 1 },
    })) as StageResult;
  }
  return (await sdk.trigger({
    function_id: "mem::consolidate-pipeline",
    payload: { tier: "decay", force: true, strict: true },
  })) as StageResult;
}

function advanceSuccessfulStage(
  projection: MaintenanceProjection,
  result: StageResult,
): MaintenanceProjection {
  const next = { ...projection };
  if (result.sourceFingerprint) {
    next.stageFingerprints = {
      ...next.stageFingerprints,
      [projection.stage]: result.sourceFingerprint,
    };
  }
  if (projection.stage === "semantic") {
    next.stage = "reflect";
  } else if (projection.stage === "reflect") {
    if (typeof result.nextOffset === "number") {
      next.stageCursor = result.nextOffset;
      return next;
    }
    delete next.stageCursor;
    next.stage = "procedural";
  } else if (projection.stage === "procedural") {
    next.stage = "crystallize";
  } else if (projection.stage === "crystallize") {
    if ((result.remainingGroups ?? 0) > 0) return next;
    next.stage = "decay";
  }
  return next;
}

export async function queueMaintenanceProjection(
  kv: StateKV,
): Promise<MaintenanceProjection> {
  return withKeyedLock(
    `maintenance-projection:${MAINTENANCE_PROJECTION_ID}`,
    async () => {
      const existing = await kv.get<MaintenanceProjection>(
        KV.maintenanceProjections,
        MAINTENANCE_PROJECTION_ID,
      );
      const now = new Date().toISOString();
      const next: MaintenanceProjection = existing
        ? {
            ...existing,
            status: existing.status === "running" ? "running" : "pending",
            requestedGeneration: existing.requestedGeneration + 1,
            updatedAt: now,
          }
        : {
            id: MAINTENANCE_PROJECTION_ID,
            status: "pending",
            requestedGeneration: 1,
            processedGeneration: 0,
            stage: "semantic",
            attempts: 0,
            requestedAt: now,
            updatedAt: now,
          };
      delete next.lastError;
      await kv.set(
        KV.maintenanceProjections,
        MAINTENANCE_PROJECTION_ID,
        next,
      );
      return next;
    },
  );
}

export function registerMaintenanceProjectionFunction(
  sdk: ISdk,
  kv: StateKV,
  coordinator = new ProjectionCoordinator(),
): void {
  const requestDrain = (): void => {
    void projectMaintenance({ projectionId: MAINTENANCE_PROJECTION_ID }).catch(
      () => {},
    );
  };

  async function projectMaintenance(data?: { projectionId?: string }) {
    const projectionId = data?.projectionId ?? MAINTENANCE_PROJECTION_ID;
    if (projectionId !== MAINTENANCE_PROJECTION_ID) {
      return { success: false, error: "maintenance_projection_not_found" };
    }
    const admitted = await coordinator.run(
      { stage: "maintenance", sourceId: projectionId },
      () => withKeyedLock("maintenance-projection:run", async () => {
        const claimed = await withKeyedLock(
          `maintenance-projection:${projectionId}`,
          async () => {
            const current = await kv.get<MaintenanceProjection>(
              KV.maintenanceProjections,
              projectionId,
            );
            if (!current) return null;
            if (
              current.status === "succeeded" &&
              current.requestedGeneration === current.processedGeneration
            ) {
              return current;
            }
            const running: MaintenanceProjection = {
              ...current,
              status: "running",
              processingGeneration:
                current.processingGeneration ?? current.requestedGeneration,
              attempts: current.attempts + 1,
              updatedAt: new Date().toISOString(),
            };
            delete running.lastError;
            await kv.set(KV.maintenanceProjections, projectionId, running);
            return running;
          },
        );
        if (!claimed) {
          return { success: false, error: "maintenance_projection_not_found" };
        }
        if (
          claimed.status === "succeeded" &&
          claimed.requestedGeneration === claimed.processedGeneration
        ) {
          return { success: true, skipped: true, reason: "already_succeeded" };
        }

        try {
          const result = await runStage(sdk, claimed);
          if (!result?.success) {
            throw new Error(result?.error || "maintenance_stage_failed");
          }
          const finishedStage = claimed.stage;
          const updated = await withKeyedLock(
            `maintenance-projection:${projectionId}`,
            async () => {
              const latest =
                (await kv.get<MaintenanceProjection>(
                  KV.maintenanceProjections,
                  projectionId,
                )) ?? claimed;
              let next = advanceSuccessfulStage(
                { ...latest, ...claimed, requestedGeneration: latest.requestedGeneration },
                result,
              );
              if (finishedStage === "decay") {
                const processedGeneration =
                  claimed.processingGeneration ?? claimed.requestedGeneration;
                const hasNewerRequest =
                  latest.requestedGeneration > processedGeneration;
                next = {
                  ...next,
                  status: hasNewerRequest ? "pending" : "succeeded",
                  requestedGeneration: latest.requestedGeneration,
                  processedGeneration,
                  stage: "semantic",
                  updatedAt: new Date().toISOString(),
                };
                delete next.processingGeneration;
                delete next.stageCursor;
              } else {
                next = {
                  ...next,
                  status: "pending",
                  requestedGeneration: latest.requestedGeneration,
                  updatedAt: new Date().toISOString(),
                };
              }
              delete next.lastError;
              await kv.set(KV.maintenanceProjections, projectionId, next);
              return next;
            },
          );
          return {
            success: true,
            stage: finishedStage,
            nextStage: updated.stage,
            status: updated.status,
          };
        } catch (error) {
          const lastError = errorMessage(error) || "maintenance_stage_failed";
          const deferred = lastError === "provider_capacity_timeout";
          await withKeyedLock(
            `maintenance-projection:${projectionId}`,
            async () => {
              const latest =
                (await kv.get<MaintenanceProjection>(
                  KV.maintenanceProjections,
                  projectionId,
                )) ?? claimed;
              await kv.set(KV.maintenanceProjections, projectionId, {
                ...latest,
                status: deferred ? "pending" : "failed",
                stage: claimed.stage,
                stageCursor: claimed.stageCursor,
                attempts: claimed.attempts,
                processingGeneration: claimed.processingGeneration,
                updatedAt: new Date().toISOString(),
                lastError,
              } satisfies MaintenanceProjection);
            },
          );
          return {
            success: false,
            ...(deferred ? { deferred: true } : {}),
            error: lastError,
          };
        }
      }),
    );
    if (!admitted.accepted) {
      coordinator.request("maintenance", requestDrain);
      return {
        success: false,
        deferred: true,
        error: admitted.error,
      };
    }
    return admitted.value;
  }

  sdk.registerFunction("mem::project-maintenance", projectMaintenance);
}
