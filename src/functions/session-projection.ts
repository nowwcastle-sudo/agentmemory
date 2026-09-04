import { TriggerAction, type ISdk } from "iii-sdk";
import type {
  CompressedObservation,
  ObservationProjection,
  Session,
  SessionProjection,
  SessionSummary,
} from "../types.js";
import {
  isAutoSummarizeEnabled,
  isConsolidationEnabled,
} from "../config.js";
import { logger } from "../logger.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { summarySourceFingerprint } from "../state/source-fingerprint.js";
import { isReflectEnabled } from "./slots.js";
import { queueMaintenanceProjection } from "./maintenance-projection.js";
import { stripPrivateData } from "./privacy.js";
import {
  markProjectionFailed,
  markProjectionPending,
  markProjectionSucceeded,
} from "../health/pipeline.js";
import type {
  SummarizeSessionCore,
  SummarizeSessionResult,
} from "./summarize.js";
import type {
  ProjectGraphSourcesCore,
  GraphSourceProjectionRequest,
  GraphSourceProjectionResult,
} from "./graph-source-projection.js";
import { ProjectionCoordinator } from "./projection-coordinator.js";

type SessionProjectionRequest = {
  sessionId: string;
  evictAfterSuccess?: boolean;
};

export const SESSION_PROJECTION_TOPIC = "agentmemory.session.projection";

export type SessionProjectionRecoveryController = {
  startRecovery: () => void;
};

function projectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    stripPrivateData(message).replace(/\s+/g, " ").trim().slice(0, 300) ||
    "session_projection_failed"
  );
}

async function runTerminalPostProcessing(
  sdk: ISdk,
  kv: StateKV,
  sessionId: string,
): Promise<void> {
  if (isReflectEnabled()) {
    await sdk
      .trigger({ function_id: "mem::slot-reflect", payload: { sessionId } })
      .catch((error) =>
        logger.warn("mem::slot-reflect trigger failed", {
          sessionId,
          error: projectionError(error),
        }),
      );
  }
  if (isConsolidationEnabled()) await queueMaintenanceProjection(kv);
}

async function compressedObservations(
  kv: StateKV,
  sessionId: string,
): Promise<CompressedObservation[]> {
  const observations = await kv.list<CompressedObservation>(
    KV.observations(sessionId),
  );
  return observations.filter(
    (observation) =>
      typeof observation.title === "string" && observation.title.length > 0,
  );
}

export function registerSessionProjectionFunction(
  sdk: ISdk,
  kv: StateKV,
  summarizeSessionCore?: SummarizeSessionCore,
  projectGraphSourcesCore?: ProjectGraphSourcesCore,
  coordinator = new ProjectionCoordinator(),
): SessionProjectionRecoveryController {
  let drainRequested = false;
  let drainRunning = false;

  const requestDrain = (): void => {
    drainRequested = true;
    if (drainRunning) return;
    drainRunning = true;
    const timer = setTimeout(() => {
      void drainPendingProjections();
    }, 0);
    timer.unref?.();
  };

  async function drainPendingProjections(): Promise<void> {
    const attempted = new Set<string>();
    try {
      while (drainRequested) {
        drainRequested = false;
        const pending = (
          await kv.list<SessionProjection>(KV.sessionProjections)
        )
          .filter(
            (projection) =>
              projection.status === "pending" &&
              !attempted.has(projection.sessionId),
          )
          .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
        for (const projection of pending) {
          attempted.add(projection.sessionId);
          await projectSession({ sessionId: projection.sessionId }).catch(
            (error) =>
              logger.warn("Session projection drain failed", {
                sessionId: projection.sessionId,
                error: projectionError(error),
              }),
          );
        }
      }
    } catch (error) {
      logger.warn("Session projection drain stopped", {
        error: projectionError(error),
      });
    } finally {
      drainRunning = false;
      if (drainRequested) requestDrain();
    }
  }

  const projectSession = async (data: SessionProjectionRequest) => {
    let completed = false;
    const admitted = await coordinator.run(
      { stage: "summary", sourceId: data.sessionId },
      () => withKeyedLock(
        `session-projection:${data.sessionId}`,
        async () => {
        const previous = await kv.get<SessionProjection>(
          KV.sessionProjections,
          data.sessionId,
        );
        if (!previous) {
          return { success: false, error: "projection_state_missing" };
        }
        const observations = await compressedObservations(kv, data.sessionId);
        const sourceFingerprint = summarySourceFingerprint(observations);
        const currentSummary = await kv.get<SessionSummary>(
          KV.summaries,
          data.sessionId,
        );
        const summaryMatches =
          currentSummary?.sourceFingerprint === sourceFingerprint;
        const skippedOutcome =
          previous.terminalOutcome === "skipped_automatic_enrichment" ||
          previous.terminalOutcome === "skipped_no_provider";
        if (
          previous.status === "succeeded" &&
          previous.sourceFingerprint === sourceFingerprint &&
          previous.terminalOutcome === "summary_written" &&
          summaryMatches
        ) {
          if (previous.terminalReason !== undefined) {
            const succeeded = { ...previous };
            delete succeeded.terminalReason;
            await kv.set(KV.sessionProjections, data.sessionId, succeeded);
          }
          await markProjectionSucceeded(kv, "summary", data.sessionId);
          return { success: true, deduplicated: true };
        }
        if (
          previous.status === "succeeded" &&
          previous.sourceFingerprint === sourceFingerprint &&
          skippedOutcome &&
          !summaryMatches
        ) {
          const terminalReason =
            previous.terminalOutcome === "skipped_no_provider"
              ? "no_provider"
              : "automatic_enrichment_disabled";
          if (previous.terminalReason !== terminalReason) {
            await kv.set(KV.sessionProjections, data.sessionId, {
              ...previous,
              terminalReason,
              updatedAt: new Date().toISOString(),
            });
          }
          await markProjectionSucceeded(kv, "summary", data.sessionId);
          return {
            success: true,
            skipped: true,
            reason: terminalReason,
            deduplicated: true,
          };
        }

        const running: SessionProjection = {
          ...previous,
          status: "running",
          attempts: previous.attempts + 1,
          observationCount: observations.length,
          sourceFingerprint,
          updatedAt: new Date().toISOString(),
        };
        delete running.lastError;
        delete running.terminalOutcome;
        delete running.terminalReason;
        await kv.set(KV.sessionProjections, data.sessionId, running);
        await markProjectionPending(
          kv,
          "summary",
          data.sessionId,
          previous.updatedAt,
        );

        const persistSkipped = async (
          terminalOutcome:
            | "skipped_automatic_enrichment"
            | "skipped_no_provider",
          terminalReason: "automatic_enrichment_disabled" | "no_provider",
        ) => {
          const succeeded: SessionProjection = {
            ...previous,
            status: "succeeded",
            attempts: running.attempts,
            observationCount: running.observationCount,
            sourceFingerprint,
            terminalOutcome,
            terminalReason,
            updatedAt: new Date().toISOString(),
          };
          delete succeeded.lastError;
          await kv.set(KV.sessionProjections, data.sessionId, succeeded);
          await markProjectionSucceeded(kv, "summary", data.sessionId);
          return { success: true, skipped: true, reason: terminalReason };
        };

        try {
          let summary = summaryMatches ? currentSummary : null;
          if (!summary) {
            if (!isAutoSummarizeEnabled()) {
              return await persistSkipped(
                "skipped_automatic_enrichment",
                "automatic_enrichment_disabled",
              );
            }
            const summaryResult = summarizeSessionCore
              ? await summarizeSessionCore({ sessionId: data.sessionId })
              : ((await sdk.trigger({
                  function_id: "mem::summarize",
                  payload: { sessionId: data.sessionId },
                })) as SummarizeSessionResult | null);
            if (
              summaryResult?.success === false &&
              summaryResult.error === "no_provider"
            ) {
              return await persistSkipped("skipped_no_provider", "no_provider");
            }
            if (!summaryResult?.success) {
              throw new Error(
                summaryResult?.error || "summary did not report success",
              );
            }
            summary = await kv.get<SessionSummary>(
              KV.summaries,
              data.sessionId,
            );
            if (summary?.sourceFingerprint !== sourceFingerprint) {
              throw new Error("successful summary state fingerprint mismatch");
            }
          }

          const graphRequest: GraphSourceProjectionRequest = {
              mode: "semantic",
              sources: [
                {
                  sourceKind: "summary",
                  sourceId: data.sessionId,
                  sessionId: data.sessionId,
                },
              ],
            };
          const graphResult = projectGraphSourcesCore
            ? await projectGraphSourcesCore(graphRequest)
            : ((await sdk.trigger({
                function_id: "mem::project-graph-sources",
                payload: graphRequest,
              })) as GraphSourceProjectionResult | null);
          if (!graphResult?.success) {
            throw new Error(
              graphResult?.error || "semantic graph did not report success",
            );
          }

          const succeeded: SessionProjection = {
            ...running,
            status: "succeeded",
            observationCount: summary.observationCount,
            sourceFingerprint: summary.sourceFingerprint,
            terminalOutcome: "summary_written",
            updatedAt: new Date().toISOString(),
          };
          await kv.set(KV.sessionProjections, data.sessionId, succeeded);
          await markProjectionSucceeded(kv, "summary", data.sessionId);
          completed = true;
          return { success: true };
        } catch (error) {
          const lastError = projectionError(error);
          if (lastError === "provider_capacity_timeout") {
            const deferred: SessionProjection = {
              ...running,
              status: "pending",
              updatedAt: new Date().toISOString(),
              lastError,
            };
            await kv.set(KV.sessionProjections, data.sessionId, deferred);
            await markProjectionPending(kv, "summary", data.sessionId);
            return {
              success: false,
              deferred: true,
              error: lastError,
            };
          }
          const failed: SessionProjection = {
            ...running,
            status: "failed",
            updatedAt: new Date().toISOString(),
            lastError,
          };
          await kv.set(KV.sessionProjections, data.sessionId, failed);
          await markProjectionFailed(kv, "summary", data.sessionId, lastError);
          logger.warn("Session projection failed", {
            sessionId: data.sessionId,
            error: lastError,
          });
          return { success: false, error: "session_projection_failed" };
        }
        },
      ),
    );
    if (!admitted.accepted) {
      coordinator.request("summary", requestDrain);
      return {
        success: false,
        deferred: true,
        error: admitted.error,
      };
    }
    const result = admitted.value;
    if (completed) {
      await runTerminalPostProcessing(sdk, kv, data.sessionId);
    }
    return result;
  };

  sdk.registerFunction("mem::project-session", projectSession);
  sdk.registerFunction(
    "mem::queue-session-projection",
    async (data: SessionProjectionRequest) =>
      withKeyedLock(`session-projection:${data.sessionId}`, async () => {
        const session = await kv.get<Session>(KV.sessions, data.sessionId);
        if (!session) return { success: false, error: "session_not_found" };
        const observations = await compressedObservations(kv, data.sessionId);
        const observationProjectionStates = await Promise.all(
          observations.map((observation) =>
            kv.get<ObservationProjection>(
              KV.observationProjections,
              observation.id,
            ),
          ),
        );
        if (
          observationProjectionStates.some(
            (projection) => projection && projection.status !== "succeeded",
          )
        ) {
          return {
            success: true,
            deferred: true,
            reason: "observation_projections_pending",
          };
        }
        if (observations.length === 0) {
          return { success: true, skipped: true, reason: "no_observations" };
        }
        const sourceFingerprint = summarySourceFingerprint(observations);
        const previous = await kv.get<SessionProjection>(
          KV.sessionProjections,
          data.sessionId,
        );
        const summary = await kv.get<SessionSummary>(KV.summaries, data.sessionId);
        const summaryMatches = summary?.sourceFingerprint === sourceFingerprint;
        const skippedOutcome =
          previous?.terminalOutcome === "skipped_automatic_enrichment" ||
          previous?.terminalOutcome === "skipped_no_provider";
        const evictAfterSuccess =
          previous?.evictAfterSuccess === true ||
          data.evictAfterSuccess === true;

        if (
          previous?.status === "succeeded" &&
          previous.sourceFingerprint === sourceFingerprint &&
          ((skippedOutcome && !summaryMatches) ||
            (previous.terminalOutcome === "summary_written" && summaryMatches))
        ) {
          if (
            evictAfterSuccess !== previous.evictAfterSuccess ||
            (!skippedOutcome && previous.terminalReason !== undefined)
          ) {
            const deduplicated = {
              ...previous,
              evictAfterSuccess,
              updatedAt: new Date().toISOString(),
            };
            if (!skippedOutcome) delete deduplicated.terminalReason;
            await kv.set(KV.sessionProjections, data.sessionId, deduplicated);
          }
          await markProjectionSucceeded(kv, "summary", data.sessionId);
          if (skippedOutcome) {
            return {
              success: true,
              skipped: true,
              reason:
                previous.terminalOutcome === "skipped_no_provider"
                  ? "no_provider"
                  : "automatic_enrichment_disabled",
              deduplicated: true,
            };
          }
          return { success: true, deduplicated: true };
        }
        if (
          (previous?.status === "pending" || previous?.status === "running") &&
          previous.sourceFingerprint === sourceFingerprint
        ) {
          if (evictAfterSuccess !== previous.evictAfterSuccess) {
            await kv.set(KV.sessionProjections, data.sessionId, {
              ...previous,
              evictAfterSuccess,
              updatedAt: new Date().toISOString(),
            });
          }
          await markProjectionPending(
            kv,
            "summary",
            data.sessionId,
            previous.updatedAt,
          );
          requestDrain();
          return { success: true, deduplicated: true };
        }

        const pending: SessionProjection = {
          sessionId: data.sessionId,
          status: "pending",
          attempts: previous?.attempts ?? 0,
          observationCount: observations.length,
          sourceFingerprint,
          updatedAt: new Date().toISOString(),
          ...(evictAfterSuccess ? { evictAfterSuccess: true } : {}),
        };
        await kv.set(KV.sessionProjections, data.sessionId, pending);
        await markProjectionPending(
          kv,
          "summary",
          data.sessionId,
          pending.updatedAt,
        );
        try {
          await sdk.trigger({
            function_id: "iii::durable::publish",
            payload: {
              topic: SESSION_PROJECTION_TOPIC,
              data: { sessionId: data.sessionId },
            },
            action: TriggerAction.Void(),
          });
        } catch (error) {
          logger.warn("Session projection durable dispatch failed", {
            sessionId: data.sessionId,
            error: projectionError(error),
          });
        }
        requestDrain();
        return { success: true, projectionQueued: true };
      }),
  );
  sdk.registerFunction(
    "mem::nudge-session-projection",
    async () => {
      requestDrain();
      return { success: true, queued: true };
    },
  );
  if (typeof sdk.registerTrigger === "function") {
    sdk.registerTrigger({
      type: "durable:subscriber",
      function_id: "mem::nudge-session-projection",
      config: {
        topic: SESSION_PROJECTION_TOPIC,
        queue_config: {
          type: "fifo",
          maxRetries: 10,
          backoffDelayMs: 1000,
        },
      },
    });
  }
  return { startRecovery: requestDrain };
}
