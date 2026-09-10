import { TriggerAction, type ISdk } from "../iii-compat.js";
import type {
  ObservationProjection,
  RawObservation,
  Session,
  SessionProjection,
} from "../types.js";
import { KV, STREAM } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import {
  listActiveProjections,
  writeObservationProjection,
} from "./observation-projection-index.js";
import { isAutoCompressEnabled } from "../config.js";
import { buildSyntheticCompression } from "./compress-synthetic.js";
import {
  getSearchIndex,
  scheduleIndexSave,
  vectorIndexAddGuarded,
} from "./search.js";
import { stripPrivateData } from "./privacy.js";
import { logger } from "../logger.js";
import { observationRetrievalMetadata } from "../state/retrieval-scope.js";
import {
  markProjectionFailed,
  markProjectionPending,
  markProjectionSucceeded,
} from "../health/pipeline.js";
import type { CompressionCore, CompressionResult } from "./compress.js";
import type {
  ProjectGraphSourcesCore,
  GraphSourceProjectionRequest,
  GraphSourceProjectionResult,
} from "./graph-source-projection.js";
import { ProjectionCoordinator } from "./projection-coordinator.js";

type ProjectionRequest = {
  observationId: string;
  sessionId: string;
};

export const OBSERVATION_PROJECTION_QUEUES = [
  "agentmemory.observation.projection.0",
  "agentmemory.observation.projection.1",
] as const;

export type ProjectionRecoveryController = {
  startRecovery: () => void;
  /**
   * Hands the drain one credit per tick so a historical backlog clears without
   * ever holding more than one worker slot. `startRecovery` stays capped at a
   * single projection — that cap is what keeps liveness a slot at boot — so a
   * backlog only moves once this pacer runs. Returns a stop function.
   */
  startPacedRecovery: (options?: { intervalMs?: number }) => () => void;
};

/** Floor for the paced recovery tick, so a bad env value cannot busy-loop. */
const MIN_RECOVERY_INTERVAL_MS = 50;
/** Default pace: one historical projection every 2 s (~30/min). */
const DEFAULT_RECOVERY_INTERVAL_MS = 2_000;
/** How long to stop re-scanning the projection scope after finding it drained. */
const EMPTY_BACKLOG_RESCAN_MS = 30_000;

/** `0` disables paced recovery, matching the *_ENABLED switches in index.ts. */
function configuredRecoveryIntervalMs(): number {
  const configured = process.env["AGENTMEMORY_PROJECTION_RECOVERY_INTERVAL_MS"];
  if (configured === undefined || configured.trim() === "") {
    return DEFAULT_RECOVERY_INTERVAL_MS;
  }
  const raw = Number(configured);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_RECOVERY_INTERVAL_MS;
  return raw;
}

export function observationProjectionQueue(observationId: string): string {
  let hash = 0;
  for (const character of observationId) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return OBSERVATION_PROJECTION_QUEUES[
    hash % OBSERVATION_PROJECTION_QUEUES.length
  ];
}

function projectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    stripPrivateData(message).replace(/\s+/g, " ").trim().slice(0, 300) ||
    "projection_failed"
  );
}

export function registerObservationProjectionFunction(
  sdk: ISdk,
  kv: StateKV,
  compressionCore?: CompressionCore,
  projectGraphSourcesCore?: ProjectGraphSourcesCore,
  coordinator = new ProjectionCoordinator(),
): ProjectionRecoveryController {
  let drainCredits = 0;
  let drainRunning = false;
  // While a pacer is running it keeps topping the credit pool up, so a lane
  // that runs out should wait for the next tick rather than ending the pass.
  let pacerIntervalMs = 0;

  const scheduleDrain = (): void => {
    if (drainRunning) return;
    drainRunning = true;
    const timer = setTimeout(() => {
      void drainPendingProjections();
    }, 0);
    timer.unref?.();
  };

  const requestDrain = (): void => {
    drainCredits += 1;
    // New work invalidates the "backlog is empty" cooldown immediately.
    refreshBlockedUntil = 0;
    scheduleDrain();
  };

  const startPacedRecovery = (options?: { intervalMs?: number }): (() => void) => {
    const configured = options?.intervalMs ?? configuredRecoveryIntervalMs();
    if (configured === 0) return () => {};
    const intervalMs = Math.max(MIN_RECOVERY_INTERVAL_MS, configured);
    pacerIntervalMs = intervalMs;
    const timer = setInterval(() => {
      // Top the credit pool up to the coordinator's capacity, whether or not a
      // drain is already running. Minting only while idle meant a pass that
      // never quite finishes — one slow projection is enough — was never
      // replenished, so the backlog moved at the rate new observations arrived
      // rather than at the rate projection could absorb. The pool is a ceiling,
      // not a queue: it never exceeds the capacity, and the coordinator remains
      // the thing that bounds concurrency.
      const capacity = Math.max(1, coordinator.status().capacity);
      if (drainCredits >= capacity) return;
      drainCredits = capacity;
      scheduleDrain();
    }, intervalMs);
    timer.unref?.();
    return () => {
      pacerIntervalMs = 0;
      clearInterval(timer);
    };
  };

  // The projection scope keeps succeeded rows, so listing it costs O(total)
  // however few rows are still pending. Listing once per drained item made a
  // backlog O(n^2): 1.1k pending cost ~2.7 s per item purely in scans. Cache
  // the sorted pending rows and serve one per credit instead — a credit still
  // buys exactly one projection, so the startup cap is unchanged.
  let pendingQueue: ObservationProjection[] = [];
  let refreshBlockedUntil = 0;

  // Several drain lanes share one queue, so a refresh is single-flighted:
  // otherwise each idle lane would scan the whole scope at the same moment.
  let refreshInFlight: Promise<boolean> | null = null;

  async function refreshPendingQueue(attempted: Set<string>): Promise<boolean> {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const rows = await listActiveProjections(kv)
        .catch((error: unknown) => {
          // A scan failure is not an empty backlog. Say so, and do not arm the
          // cooldown — otherwise a KV outage looks exactly like "all drained".
          logger.warn("Observation projection scan failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
      if (!rows) return false;
      pendingQueue = rows
        .filter(
          (projection) =>
            projection.status === "pending" &&
            !attempted.has(projection.observationId),
        )
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
      if (pendingQueue.length === 0) {
        // Nothing is waiting: stop re-scanning the whole scope on every tick.
        refreshBlockedUntil = Date.now() + EMPTY_BACKLOG_RESCAN_MS;
        return false;
      }
      return true;
    })();
    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  async function nextPendingProjection(
    attempted: Set<string>,
  ): Promise<ObservationProjection | undefined> {
    for (;;) {
      while (pendingQueue.length > 0) {
        const candidate = pendingQueue.shift();
        if (candidate && !attempted.has(candidate.observationId)) {
          // Claim it here, before any await, so two lanes cannot take the same
          // row out of the shared queue.
          attempted.add(candidate.observationId);
          return candidate;
        }
      }
      if (Date.now() < refreshBlockedUntil) return undefined;
      if (!(await refreshPendingQueue(attempted))) return undefined;
    }
  }

  async function drainPendingProjections(): Promise<void> {
    const attempted = new Set<string>();
    // One projection at a time made the drain rate 1 / projection duration no
    // matter how many slots the coordinator offered. Run a lane per slot.
    const lanes = Math.max(1, coordinator.status().capacity);
    const lane = async (): Promise<void> => {
      for (;;) {
        if (drainCredits <= 0) {
          // Without a pacer the pool is all the work this pass may do.
          if (pacerIntervalMs === 0) return;
          await new Promise((resolve) => setTimeout(resolve, pacerIntervalMs));
          if (drainCredits <= 0) continue;
        }
        drainCredits -= 1;
        const projection = await nextPendingProjection(attempted);
        if (!projection) return;
        // The cached row may have been projected by another path since the
        // scan, so confirm against the record before spending the slot.
        const current = await kv
          .get<ObservationProjection>(
            KV.observationProjections,
            projection.observationId,
          )
          .catch((error: unknown) => {
            logger.warn("Observation projection recheck failed", {
              observationId: projection.observationId,
              sessionId: projection.sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
            return null;
          });
        if (!current || current.status !== "pending") continue;
        await projectObservation({
          observationId: projection.observationId,
          sessionId: projection.sessionId,
        }).catch((error) =>
          logger.warn("Observation projection drain failed", {
            observationId: projection.observationId,
            sessionId: projection.sessionId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    };
    try {
      await Promise.all(Array.from({ length: lanes }, lane));
    } catch (error) {
      logger.warn("Observation projection drain stopped", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      drainRunning = false;
      if (drainCredits > 0) scheduleDrain();
    }
  }

  const projectObservation = async (data: ProjectionRequest) => {
    const admitted = await coordinator.run(
      { stage: "compression", sourceId: data.observationId },
      () => withKeyedLock(`projection:${data.observationId}`, async () => {
        const previous = await kv.get<ObservationProjection>(
          KV.observationProjections,
          data.observationId,
        );
        if (!previous) {
          return { success: false, error: "projection_state_missing" };
        }
        if (previous.status === "succeeded") {
          await markProjectionSucceeded(
            kv,
            "compression",
            data.observationId,
          );
          return { success: true, deduplicated: true };
        }

        const running: ObservationProjection = {
          ...previous,
          status: "running",
          attempts: previous.attempts + 1,
          updatedAt: new Date().toISOString(),
        };
        delete running.lastError;
        await markProjectionPending(
          kv,
          "compression",
          data.observationId,
          previous.updatedAt,
        );
        await writeObservationProjection(kv, running);

        try {
          const raw = await kv.get<RawObservation>(
            KV.rawObservations(data.sessionId),
            data.observationId,
          );
          if (!raw) throw new Error("raw observation missing");

          if (isAutoCompressEnabled()) {
            const request: GraphSourceProjectionRequest = {
                observationId: data.observationId,
                sessionId: data.sessionId,
                raw,
              };
            const result = compressionCore
              ? await compressionCore(request)
              : ((await sdk.trigger({
                  function_id: "mem::compress",
                  payload: request,
                })) as CompressionResult | null);
            if (!result?.success) {
              if (result?.retryable === true) {
                const pending: ObservationProjection = {
                  ...previous,
                  status: "pending",
                  attempts: previous.attempts,
                  updatedAt: new Date().toISOString(),
                };
                delete pending.lastError;
                await writeObservationProjection(kv, pending);
                await markProjectionPending(
                  kv,
                  "compression",
                  data.observationId,
                  previous.updatedAt,
                );
                return {
                  success: false,
                  deferred: true,
                  error: result.error || "provider_capacity_timeout",
                };
              }
              throw new Error(result?.error || "compression did not report success");
            }
          } else {
            const synthetic = buildSyntheticCompression(raw);
            await kv.set(
              KV.observations(data.sessionId),
              data.observationId,
              synthetic,
            );
            getSearchIndex().add(synthetic);
            await vectorIndexAddGuarded(
              synthetic.id,
              synthetic.sessionId,
              synthetic.title + " " + (synthetic.narrative || ""),
              { kind: "synthetic", logId: synthetic.id },
              observationRetrievalMetadata(synthetic),
            );
            scheduleIndexSave();

            const streamResults = await Promise.allSettled([
              sdk.trigger({
                function_id: "stream::set",
                payload: {
                  stream_name: STREAM.name,
                  group_id: STREAM.group(data.sessionId),
                  item_id: data.observationId,
                  data: { type: "compressed", observation: synthetic },
                },
              }),
              sdk.trigger({
                function_id: "stream::set",
                payload: {
                  stream_name: STREAM.name,
                  group_id: STREAM.viewerGroup,
                  item_id: data.observationId,
                  data: {
                    type: "compressed",
                    observation: synthetic,
                    sessionId: data.sessionId,
                  },
                },
                action: TriggerAction.Void(),
              }),
            ]);
            for (const result of streamResults) {
              if (result.status === "rejected") {
                logger.warn("Non-fatal stream publish failure after projection", {
                  sessionId: data.sessionId,
                  observationId: data.observationId,
                  error:
                    result.reason instanceof Error
                      ? result.reason.message
                      : String(result.reason),
                });
              }
            }
          }

          try {
            const request = {
                mode: "structural",
                sources: [
                  {
                    sourceKind: "observation",
                    sourceId: data.observationId,
                    sessionId: data.sessionId,
                  },
                ],
              };
            const graphResult = projectGraphSourcesCore
              ? await projectGraphSourcesCore(request)
              : ((await sdk.trigger({
                  function_id: "mem::project-graph-sources",
                  payload: request,
                })) as GraphSourceProjectionResult | null);
            if (graphResult && graphResult.success === false) {
              logger.warn("Graph projection did not report success", {
                observationId: data.observationId,
                sessionId: data.sessionId,
              });
            }
          } catch (error) {
            logger.warn("Non-fatal graph projection dispatch failure", {
              observationId: data.observationId,
              sessionId: data.sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          }

          const succeeded: ObservationProjection = {
            ...running,
            status: "succeeded",
            updatedAt: new Date().toISOString(),
          };
          await writeObservationProjection(kv, succeeded);
          await markProjectionSucceeded(
            kv,
            "compression",
            data.observationId,
          );
          const session = await kv.get<Session>(KV.sessions, data.sessionId);
          const terminalProjection = await kv.get<SessionProjection>(
            KV.sessionProjections,
            data.sessionId,
          );
          if (session?.status === "completed" && terminalProjection) {
            void sdk
              .trigger({
                function_id: "mem::queue-session-projection",
                payload: { sessionId: data.sessionId },
                action: TriggerAction.Void(),
              })
              .catch((error) =>
                logger.warn("Recovered terminal projection trigger failed", {
                  observationId: data.observationId,
                  sessionId: data.sessionId,
                  error:
                    error instanceof Error ? error.message : String(error),
                }),
              );
          }
          return { success: true };
        } catch (error) {
          const lastError = projectionError(error);
          const failed: ObservationProjection = {
            ...running,
            status: "failed",
            updatedAt: new Date().toISOString(),
            lastError,
          };
          await writeObservationProjection(kv, failed);
          await markProjectionFailed(
            kv,
            "compression",
            data.observationId,
            lastError,
          );
          logger.warn("Observation projection failed", {
            observationId: data.observationId,
            sessionId: data.sessionId,
            error: lastError,
          });
          return { success: false, error: "projection_failed" };
        }
      }),
    );
    if (!admitted.accepted) {
      coordinator.request("compression", requestDrain);
      return {
        success: false,
        deferred: true,
        error: admitted.error,
      };
    }
    return admitted.value;
  };
  sdk.registerFunction("mem::project-observation", projectObservation);
  sdk.registerFunction(
    "mem::queue-observation-projection",
    async (data: ProjectionRequest) => {
      const previous = await kv.get<ObservationProjection>(
        KV.observationProjections,
        data.observationId,
      );
      if (!previous) {
        return { success: false, error: "projection_state_missing" };
      }
      if (previous.status === "succeeded") {
        await markProjectionSucceeded(kv, "compression", data.observationId);
        return { success: true, deduplicated: true };
      }
      if (previous.status === "failed") {
        const pending: ObservationProjection = {
          ...previous,
          status: "pending",
          updatedAt: new Date().toISOString(),
        };
        delete pending.lastError;
        await writeObservationProjection(kv, pending);
        await markProjectionPending(
          kv,
          "compression",
          data.observationId,
          previous.updatedAt,
        );
      }
      requestDrain();
      return { success: true, queued: true };
    },
  );
  if (typeof sdk.registerTrigger === "function") {
    for (const topic of OBSERVATION_PROJECTION_QUEUES) {
      sdk.registerTrigger({
        type: "durable:subscriber",
        function_id: "mem::queue-observation-projection",
        config: {
          topic,
          queue_config: {
            type: "fifo",
            maxRetries: 10,
            backoffDelayMs: 1000,
          },
        },
      });
    }
  }
  return { startRecovery: requestDrain, startPacedRecovery };
}
