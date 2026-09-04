import type { ISdk } from "iii-sdk";
import type {
  CompressedObservation,
  GraphExtractionLevel,
  GraphProjection,
  GraphProjectionMode,
  GraphSnapshot,
  GraphSource,
  GraphSourceLocator,
  Memory,
  Session,
  SessionSummary,
} from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import {
  GLOBAL_GRAPH_PROJECT_ID,
  graphSourceToObservation,
  memoryToGraphSource,
  observationToGraphSource,
  summaryToGraphSource,
} from "../state/memory-utils.js";
import { stripPrivateData } from "./privacy.js";
import { logger } from "../logger.js";
import { graphSourceFingerprint } from "../state/source-fingerprint.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import {
  markProjectionFailed,
  markProjectionPending,
  markProjectionSucceeded,
} from "../health/pipeline.js";
import type {
  GraphExtractCore,
  GraphExtractionResult,
} from "./graph.js";
import { ProjectionCoordinator } from "./projection-coordinator.js";

export type GraphSourceProjectionRequest = {
  sources?: GraphSourceLocator[];
  mode?: GraphProjectionMode;
};

export type GraphSourceProjectionResult = {
  success: boolean;
  sourcesProjected?: number;
  sourcesDeduplicated?: number;
  sourcesInProgress?: number;
  sourcesFailed?: number;
  nodesAdded?: number;
  edgesAdded?: number;
  error?: string;
  deferred?: boolean;
};

export type ProjectGraphSourcesCore = (
  data: GraphSourceProjectionRequest,
) => Promise<GraphSourceProjectionResult>;

const GRAPH_PROJECTION_LEASE_MS = 4 * 60 * 1000;

type PreparedProjection =
  | { kind: "deduplicated" }
  | { kind: "in_progress" }
  | { kind: "failed" }
  | {
      kind: "pending";
      item: {
        key: string;
        source: GraphSource;
        projection: GraphProjection;
      };
    };

function projectionKey(locator: GraphSourceLocator): string {
  return `${locator.sourceKind}:${locator.sourceId}`;
}

function projectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    stripPrivateData(message).replace(/\s+/g, " ").trim().slice(0, 300) ||
    "graph_projection_failed"
  );
}

async function resolveSource(
  kv: StateKV,
  locator: GraphSourceLocator,
): Promise<GraphSource> {
  if (locator.sourceKind === "memory") {
    const memory = await kv.get<Memory>(KV.memories, locator.sourceId);
    if (!memory) throw new Error("memory source missing");
    return memoryToGraphSource(memory);
  }

  if (locator.sourceKind === "summary") {
    const sessionId = locator.sessionId ?? locator.sourceId;
    const summary = await kv.get<SessionSummary>(KV.summaries, locator.sourceId);
    if (!summary) throw new Error("summary source missing");
    const session = await kv.get<Session>(KV.sessions, sessionId);
    if (!session) throw new Error("summary session missing");
    return summaryToGraphSource(summary, session);
  }

  if (!locator.sessionId) throw new Error("observation sessionId is required");
  const observation = await kv.get<CompressedObservation>(
    KV.observations(locator.sessionId),
    locator.sourceId,
  );
  if (!observation) throw new Error("observation source missing");
  const session = await kv.get<Session>(KV.sessions, locator.sessionId);
  const projectId =
    typeof session?.project === "string" && session.project.trim()
      ? session.project.trim()
      : GLOBAL_GRAPH_PROJECT_ID;
  return observationToGraphSource(observation, projectId);
}

function runningProjection(
  source: GraphSource,
  previous: GraphProjection | null,
  sourceFingerprint: string,
  requestedExtractionLevel: GraphExtractionLevel | undefined,
  graphGeneration?: string,
): GraphProjection {
  const previousExtractionLevel =
    previous?.sourceFingerprint === sourceFingerprint &&
    previous.graphGeneration === graphGeneration
      ? previous.extractionLevel
      : undefined;
  return {
    sourceKind: source.sourceKind,
    sourceId: source.sourceId,
    ...(source.sessionId ? { sessionId: source.sessionId } : {}),
    projectId: source.projectId,
    ...(source.actorAgentId ? { actorAgentId: source.actorAgentId } : {}),
    visibility: source.visibility,
    status: "running",
    attempts: (previous?.attempts ?? 0) + 1,
    updatedAt: new Date().toISOString(),
    ...(graphGeneration ? { graphGeneration } : {}),
    sourceFingerprint,
    ...(previousExtractionLevel ? { extractionLevel: previousExtractionLevel } : {}),
    ...(requestedExtractionLevel ? { requestedExtractionLevel } : {}),
  };
}

function requestedLevel(
  mode: GraphProjectionMode,
): GraphExtractionLevel | undefined {
  if (mode === "structural" || mode === "semantic") return mode;
  return undefined;
}

function projectionSatisfiesMode(
  previous: GraphProjection | null,
  sourceFingerprint: string,
  graphGeneration: string | undefined,
  mode: GraphProjectionMode,
): boolean {
  if (
    previous?.status !== "succeeded" ||
    previous.sourceFingerprint !== sourceFingerprint ||
    previous.graphGeneration !== graphGeneration
  ) {
    return false;
  }
  if (mode === "configured") return true;
  if (mode === "semantic") return previous.extractionLevel === "semantic";
  return (
    previous.extractionLevel === "structural" ||
    previous.extractionLevel === "semantic"
  );
}

function projectionIsActive(
  previous: GraphProjection | null,
  sourceFingerprint: string,
  graphGeneration?: string,
): boolean {
  if (
    previous?.status !== "running" ||
    previous.sourceFingerprint !== sourceFingerprint ||
    previous.graphGeneration !== graphGeneration
  ) {
    return false;
  }
  const updatedAt = Date.parse(previous.updatedAt);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt < GRAPH_PROJECTION_LEASE_MS;
}

export function registerGraphSourceProjectionFunction(
  sdk: ISdk,
  kv: StateKV,
  graphExtractCore?: GraphExtractCore,
  coordinator = new ProjectionCoordinator(),
): ProjectGraphSourcesCore {
  const core: ProjectGraphSourcesCore = async (data) => {
      if (!Array.isArray(data?.sources) || data.sources.length === 0) {
        return { success: false, error: "sources array is required" };
      }
      const mode = data.mode ?? "configured";
      if (!(["configured", "structural", "semantic"] as const).includes(mode)) {
        return { success: false, error: "invalid graph projection mode" };
      }

      const graphGeneration = (
        await kv.get<GraphSnapshot>(KV.graphSnapshot, "current")
      )?.graphGeneration;
      const pending: Array<{
        key: string;
        source: GraphSource;
        projection: GraphProjection;
      }> = [];
      let sourcesDeduplicated = 0;
      let sourcesInProgress = 0;
      let sourcesFailed = 0;

      for (const locator of data.sources) {
        if (
          !locator ||
          (locator.sourceKind !== "observation" &&
            locator.sourceKind !== "memory" &&
            locator.sourceKind !== "summary") ||
          typeof locator.sourceId !== "string" ||
          !locator.sourceId.trim()
        ) {
          sourcesFailed += 1;
          continue;
        }
        const normalized: GraphSourceLocator = {
          sourceKind: locator.sourceKind,
          sourceId: locator.sourceId.trim(),
          ...(typeof locator.sessionId === "string" && locator.sessionId.trim()
            ? { sessionId: locator.sessionId.trim() }
            : {}),
        };
        const key = projectionKey(normalized);
        const prepared = await withKeyedLock<PreparedProjection>(
          `graph-source-prepare:${key}`,
          async () => {
            const previous = await kv.get<GraphProjection>(
              KV.graphProjections,
              key,
            );

            try {
              const source = await resolveSource(kv, normalized);
              const sourceFingerprint = graphSourceFingerprint(source);
              if (
                projectionSatisfiesMode(
                  previous,
                  sourceFingerprint,
                  graphGeneration,
                  mode,
                )
              ) {
                await markProjectionSucceeded(kv, "graph", key);
                return { kind: "deduplicated" };
              }
              if (
                projectionIsActive(
                  previous,
                  sourceFingerprint,
                  graphGeneration,
                )
              ) {
                return { kind: "in_progress" };
              }
              const projection = runningProjection(
                source,
                previous,
                sourceFingerprint,
                requestedLevel(mode),
                graphGeneration,
              );
              await markProjectionPending(
                kv,
                "graph",
                key,
                previous?.updatedAt ?? projection.updatedAt,
              );
              await kv.set(KV.graphProjections, key, projection);
              return {
                kind: "pending",
                item: { key, source, projection },
              };
            } catch (error) {
              const failed: GraphProjection = {
                sourceKind: normalized.sourceKind,
                sourceId: normalized.sourceId,
                ...(normalized.sessionId
                  ? { sessionId: normalized.sessionId }
                  : {}),
                projectId: previous?.projectId ?? GLOBAL_GRAPH_PROJECT_ID,
                visibility: previous?.visibility ?? "project",
                status: "failed",
                attempts: (previous?.attempts ?? 0) + 1,
                updatedAt: new Date().toISOString(),
                ...(graphGeneration ? { graphGeneration } : {}),
                ...(previous?.sourceFingerprint
                  ? { sourceFingerprint: previous.sourceFingerprint }
                  : {}),
                lastError: projectionError(error),
              };
              await kv.set(KV.graphProjections, key, failed);
              await markProjectionFailed(
                kv,
                "graph",
                key,
                failed.lastError ?? "graph_projection_failed",
              );
              return { kind: "failed" };
            }
          },
        );

        if (prepared.kind === "pending") pending.push(prepared.item);
        if (prepared.kind === "deduplicated") sourcesDeduplicated += 1;
        if (prepared.kind === "in_progress") sourcesInProgress += 1;
        if (prepared.kind === "failed") sourcesFailed += 1;
      }

      if (pending.length === 0) {
        return {
          success: sourcesFailed === 0,
          sourcesProjected: 0,
          sourcesDeduplicated,
          sourcesInProgress,
          sourcesFailed,
          nodesAdded: 0,
          edgesAdded: 0,
        };
      }

      const groups = new Map<string, typeof pending>();
      for (const item of pending) {
        const owner =
          item.source.visibility === "agent_private"
            ? item.source.actorAgentId ?? ""
            : "";
        const groupKey = `${item.source.projectId}|${item.source.visibility}|${owner}`;
        const group = groups.get(groupKey) ?? [];
        group.push(item);
        groups.set(groupKey, group);
      }

      let sourcesProjected = 0;
      let nodesAdded = 0;
      let edgesAdded = 0;
      for (const group of groups.values()) {
        try {
          const request = {
              observations: group.map(({ source }) =>
                graphSourceToObservation(source),
              ),
              mode,
            };
          const result = graphExtractCore
            ? await graphExtractCore(request)
            : ((await sdk.trigger({
                function_id: "mem::graph-extract",
                payload: request,
              })) as GraphExtractionResult | null);
          const extractionLevel: GraphExtractionLevel =
            result?.semanticApplied === true ? "semantic" : "structural";
          for (const item of group) {
            item.projection.extractionLevel = extractionLevel;
          }
          if (!result?.success) {
            throw new Error(
              result?.error || "graph extraction did not report success",
            );
          }

          const groupNodesAdded = Number(result.nodesAdded) || 0;
          const groupEdgesAdded = Number(result.edgesAdded) || 0;
          nodesAdded += groupNodesAdded;
          edgesAdded += groupEdgesAdded;
          sourcesProjected += group.length;
          const outcome =
            group.length === 1
              ? groupNodesAdded > 0 || groupEdgesAdded > 0
                ? "graph"
                : "no_structure"
              : undefined;
          for (const item of group) {
            await withKeyedLock(`graph-source-prepare:${item.key}`, async () => {
              const current = await kv.get<GraphProjection>(
                KV.graphProjections,
                item.key,
              );
              if (
                current?.status !== "running" ||
                current.updatedAt !== item.projection.updatedAt
              ) {
                return;
              }
              const succeeded: GraphProjection = {
                ...item.projection,
                status: "succeeded",
                extractionLevel,
                ...(outcome ? { outcome } : {}),
                updatedAt: new Date().toISOString(),
              };
              await kv.set(KV.graphProjections, item.key, succeeded);
              await markProjectionSucceeded(kv, "graph", item.key);
            });
          }
        } catch (error) {
          const lastError = projectionError(error);
          sourcesFailed += group.length;
          for (const item of group) {
            await withKeyedLock(`graph-source-prepare:${item.key}`, async () => {
              const current = await kv.get<GraphProjection>(
                KV.graphProjections,
                item.key,
              );
              if (
                current?.status !== "running" ||
                current.updatedAt !== item.projection.updatedAt
              ) {
                return;
              }
              const failed: GraphProjection = {
                ...item.projection,
                status: "failed",
                updatedAt: new Date().toISOString(),
                lastError,
              };
              await kv.set(KV.graphProjections, item.key, failed);
              await markProjectionFailed(
                kv,
                "graph",
                item.key,
                lastError,
              );
            });
          }
          logger.warn("Graph source projection failed", {
            sources: group.map(({ source }) => source.sourceId),
            error: lastError,
          });
        }
      }

      return {
        success: sourcesFailed === 0,
        sourcesProjected,
        sourcesDeduplicated,
        sourcesInProgress,
        sourcesFailed,
        nodesAdded,
        edgesAdded,
        ...(sourcesFailed > 0 ? { error: "graph_projection_failed" } : {}),
      };
  };

  sdk.registerFunction(
    "mem::project-graph-sources",
    async (data: GraphSourceProjectionRequest) => {
      const sourceId = Array.isArray(data?.sources)
        ? data.sources
            .map((source) => `${source.sourceKind}:${source.sourceId}`)
            .join(",")
        : "invalid-sources";
      const run = await coordinator.run(
        { stage: "graph", sourceId },
        () => core(data),
      );
      return run.accepted
        ? run.value
        : { success: false, deferred: true, error: run.error };
    },
  );
  return core;
}
