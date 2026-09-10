import { TriggerAction, type ISdk } from "../iii-compat.js";
import type {
  RawObservation,
  HookPayload,
  ObservationProjection,
  Origin,
  Session,
} from "../types.js";

const TOOL_HOOKS = new Set(["pre_tool_use", "post_tool_use", "post_tool_failure"]);
import { KV, STREAM, fingerprintId, generateId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { DedupMap } from "./dedup.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { writeObservationProjection } from "./observation-projection-index.js";
import { isAutoCompressEnabled } from "../config.js";
import { getAgentId } from "../config.js";
import { logger } from "../logger.js";
import { markProjectionPending } from "../health/pipeline.js";
import { saveImageToDisk } from "../utils/image-store.js";
import { observationProjectionQueue } from "./observation-projection.js";
import {
  buildCaptureFingerprintInputV1,
  CAPTURE_FINGERPRINT_VERSION,
  hashCaptureFingerprintV1,
  sanitizeObservationData,
} from "./capture-fingerprint.js";

export function extractImage(d: unknown): string | undefined {
  if (!d) return undefined;
  if (typeof d === "string") {
    if (d.startsWith("data:image/") || d.startsWith("iVBORw0KGgo") || d.startsWith("/9j/")) {
      return d;
    }
    return undefined;
  }
  if (typeof d === "object" && d !== null) {
    const obj = d as Record<string, unknown>;
    if (typeof obj["image_data"] === "string") return obj["image_data"];
    if (typeof obj["image_path"] === "string") return obj["image_path"];
    if (typeof obj["imageBase64"] === "string") return obj["imageBase64"];
    if (typeof obj["imagePath"] === "string") return obj["imagePath"];

    for (const key of Object.keys(obj)) {
      const match = extractImage(obj[key]);
      if (match) return match;
    }
  }
  return undefined;
}

export function registerObserveFunction(
  sdk: ISdk,
  kv: StateKV,
  dedupMap?: DedupMap,
  maxObservationsPerSession?: number,
): void {
  sdk.registerFunction("mem::observe", async (payload: HookPayload) => {
    if (
      !payload?.sessionId ||
      typeof payload.sessionId !== "string" ||
      !payload.hookType ||
      typeof payload.hookType !== "string" ||
      !payload.timestamp ||
      typeof payload.timestamp !== "string"
    ) {
      return {
        success: false,
        error:
          "Invalid payload: sessionId, hookType, and timestamp are required",
      };
    }
    if (
      payload.captureId !== undefined &&
      (typeof payload.captureId !== "string" || !payload.captureId.trim())
    ) {
      return {
        success: false,
        error: "Invalid payload: captureId must be a non-empty string",
      };
    }
    if (
      payload.sourceClient !== undefined &&
      (typeof payload.sourceClient !== "string" || !payload.sourceClient.trim())
    ) {
      return {
        success: false,
        error: "Invalid payload: sourceClient must be a non-empty string",
      };
    }

    const requestedCaptureId = payload.captureId?.trim();
    let obsId = requestedCaptureId
      ? fingerprintId("obs", `${payload.sessionId}:${requestedCaptureId}`)
      : generateId("obs");

    let dedupHash: string | undefined;
    if (dedupMap) {
      const dataIsObject =
        typeof payload.data === "object" && payload.data !== null;
      const d = dataIsObject
        ? (payload.data as Record<string, unknown>)
        : {};
      const toolName = (d["tool_name"] as string) || payload.hookType;
      const dedupInput =
        d["tool_input"] !== undefined
          ? d["tool_input"]
          : dataIsObject
            ? d
            : payload.data;
      dedupHash = dedupMap.computeHash(
        payload.sessionId,
        toolName,
        dedupInput,
      );
      if (!requestedCaptureId) {
        obsId = dedupMap.getObservationId(dedupHash) ?? obsId;
      }
    }

    const sanitizedRaw = sanitizeObservationData(payload.data);

    let originChannel: Origin["channel"] = "agent";
    if (payload.hookType === "prompt_submit") originChannel = "user";
    else if (TOOL_HOOKS.has(payload.hookType)) originChannel = "tool";
    const captureId = requestedCaptureId ?? obsId;
    const rawCandidate: RawObservation = {
      id: obsId,
      captureId,
      sessionId: payload.sessionId,
      timestamp: payload.timestamp,
      hookType: payload.hookType,
      raw: sanitizedRaw,
      ...(typeof payload.project === "string" && payload.project.trim()
        ? { projectId: payload.project.trim() }
        : {}),
      ...(typeof payload.projectName === "string" && payload.projectName.trim()
        ? { projectName: payload.projectName.trim() }
        : {}),
      visibility: "project",
      origin: {
        channel: originChannel,
        capturedAt: payload.timestamp,
      },
    };

    let extractedImage: string | undefined;
    if (typeof sanitizedRaw === "object" && sanitizedRaw !== null) {
      const d = sanitizedRaw as Record<string, unknown>;
      if (
        payload.hookType === "post_tool_use" ||
        payload.hookType === "post_tool_failure"
      ) {
        rawCandidate.toolName = d["tool_name"] as string | undefined;
        rawCandidate.toolInput = d["tool_input"];
        rawCandidate.toolOutput = d["tool_output"] || d["error"];
        if (rawCandidate.origin && rawCandidate.toolName) {
          rawCandidate.origin.detail = rawCandidate.toolName;
        }
      }
      if (payload.hookType === "prompt_submit") {
        rawCandidate.userPrompt = d["prompt"] as string | undefined;
      }
      extractedImage = extractImage(sanitizedRaw);
      if (extractedImage) {
        rawCandidate.modality =
          rawCandidate.toolInput ||
          rawCandidate.toolOutput ||
          rawCandidate.userPrompt
            ? "mixed"
            : "image";
      }
    } else if (typeof sanitizedRaw === "string") {
      extractedImage = extractImage(sanitizedRaw);
      if (extractedImage) rawCandidate.modality = "image";
    }

    return withKeyedLock(`obs:${payload.sessionId}`, async () => {
      const rawScope = KV.rawObservations(payload.sessionId);
      const existingRaw = await kv.get<RawObservation>(rawScope, obsId);
      const isNewCapture = !existingRaw;
      const existingSession = await kv.get<Session>(
        KV.sessions,
        payload.sessionId,
      );
      const configuredAgentId = getAgentId();
      const captureFingerprint = hashCaptureFingerprintV1(
        buildCaptureFingerprintInputV1({
          payload,
          captureId,
          sanitizedRaw,
          inheritedSession: existingSession,
          configuredAgentId,
        }),
      );
      if (existingRaw && requestedCaptureId) {
        if (
          existingRaw.captureFingerprintVersion !== CAPTURE_FINGERPRINT_VERSION ||
          !/^[a-f0-9]{64}$/.test(existingRaw.captureFingerprint ?? "")
        ) {
          return { success: false, error: "legacy_identity_unverified" };
        }
        if (existingRaw.captureFingerprint !== captureFingerprint) {
          return { success: false, error: "capture_id_conflict" };
        }
      }
      let previousObservationCount =
        typeof existingSession?.observationCount === "number" &&
        Number.isFinite(existingSession.observationCount) &&
        existingSession.observationCount >= 0
          ? existingSession.observationCount
          : undefined;

      if (previousObservationCount === undefined) {
        const [rawRows, derivedRows] = await Promise.all([
          kv.list<{ id?: string }>(rawScope),
          kv.list<{ id?: string }>(KV.observations(payload.sessionId)),
        ]);
        previousObservationCount = new Set(
          [...rawRows, ...derivedRows]
            .map((row) => row.id)
            .filter((id): id is string => typeof id === "string"),
        ).size;
      }

      if (
        isNewCapture &&
        maxObservationsPerSession &&
        maxObservationsPerSession > 0
      ) {
        if (previousObservationCount >= maxObservationsPerSession) {
          return {
            success: false,
            error: `Session observation limit reached (${maxObservationsPerSession})`,
          };
        }
      }

      const eventAgentId =
        (typeof payload.agentId === "string" && payload.agentId.trim().length > 0
          ? payload.agentId.trim().slice(0, 128)
          : undefined) ?? existingSession?.agentId ?? configuredAgentId;
      const eventSourceClient =
        existingSession?.sourceClient ??
        (typeof payload.sourceClient === "string" && payload.sourceClient.trim()
          ? payload.sourceClient.trim().slice(0, 64)
          : undefined);

      let raw = existingRaw ?? rawCandidate;
      if (isNewCapture) {
        raw.captureFingerprintVersion = CAPTURE_FINGERPRINT_VERSION;
        raw.captureFingerprint = captureFingerprint;
        if (eventAgentId) raw.agentId = eventAgentId;
        if (eventSourceClient) raw.sourceClient = eventSourceClient;
        if (!raw.projectId && existingSession?.project) {
          raw.projectId = existingSession.project;
        }
        if (!raw.projectName && existingSession?.projectName) {
          raw.projectName = existingSession.projectName;
        }
        if (
          extractedImage &&
          (extractedImage.startsWith("data:image/") ||
            extractedImage.startsWith("iVBORw0KGgo") ||
            extractedImage.startsWith("/9j/"))
        ) {
          const { filePath, bytesWritten } =
            await saveImageToDisk(extractedImage);
          raw.imageData = filePath;
          const { incrementImageRef } = await import("./image-refs.js");
          await incrementImageRef(kv, filePath);
          await Promise.allSettled([
            sdk.trigger({
              function_id: "mem::disk-size-delta",
              payload: { deltaBytes: bytesWritten },
              action: TriggerAction.Void(),
            }),
            ...(process.env["AGENTMEMORY_IMAGE_EMBEDDINGS"] === "true"
              ? [
                  sdk.trigger({
                    function_id: "mem::vision-embed",
                    payload: {
                      imageRef: filePath,
                      sessionId: payload.sessionId,
                      observationId: obsId,
                    },
                    action: TriggerAction.Void(),
                  }),
                ]
              : []),
          ]);
        }

        try {
          await kv.set(rawScope, obsId, raw);
        } catch (error) {
          if (raw.imageData) {
            try {
              const { decrementImageRef } = await import("./image-refs.js");
              await decrementImageRef(kv, sdk, raw.imageData);
            } catch (rollbackError) {
              logger.error(
                "Failed to roll back image ref after observation write failure",
                {
                  imageRef: raw.imageData,
                  error:
                    rollbackError instanceof Error
                      ? rollbackError.message
                      : String(rollbackError),
                },
              );
            }
          }
          throw error;
        }
      }

      if (dedupMap && dedupHash) {
        dedupMap.record(dedupHash, obsId);
      }

      const observationCount = previousObservationCount + (isNewCapture ? 1 : 0);

      if (existingSession && isNewCapture) {
        const updatedSession = {
          ...existingSession,
          updatedAt: new Date().toISOString(),
          observationCount,
          ...(eventSourceClient ? { sourceClient: eventSourceClient } : {}),
        };
        if (existingSession.status === "completed") {
          updatedSession.status = "active";
          delete updatedSession.endedAt;
        }
        if (!existingSession.firstPrompt && typeof raw.userPrompt === "string") {
          const trimmed = raw.userPrompt.replace(/\s+/g, " ").trim();
          if (trimmed.length > 0) {
            updatedSession.firstPrompt = trimmed.slice(0, 200);
          }
        }
        if (
          !existingSession.projectName &&
          typeof payload.projectName === "string" &&
          payload.projectName.trim()
        ) {
          updatedSession.projectName = payload.projectName.trim();
        }
        await kv.set(KV.sessions, payload.sessionId, updatedSession);
      } else if (
        !existingSession &&
        typeof payload.project === "string" &&
        payload.project.trim().length > 0 &&
        typeof payload.cwd === "string" &&
        payload.cwd.trim().length > 0
      ) {
        const trimmedPrompt =
          typeof raw.userPrompt === "string"
            ? raw.userPrompt.replace(/\s+/g, " ").trim().slice(0, 200)
            : undefined;
        const ts = new Date().toISOString();
        await kv.set(KV.sessions, payload.sessionId, {
          id: payload.sessionId,
          project: payload.project,
          ...(typeof payload.projectName === "string" && payload.projectName.trim()
            ? { projectName: payload.projectName.trim() }
            : {}),
          cwd: payload.cwd,
          startedAt: payload.timestamp ?? ts,
          updatedAt: ts,
          status: "active",
          observationCount,
          ...(eventAgentId ? { agentId: eventAgentId } : {}),
          ...(eventSourceClient ? { sourceClient: eventSourceClient } : {}),
          ...(trimmedPrompt && trimmedPrompt.length > 0
            ? { firstPrompt: trimmedPrompt }
            : {}),
        });
      }

      let projection = await kv.get<ObservationProjection>(
        KV.observationProjections,
        obsId,
      );
      const projectionWasMissing = !projection;
      if (!projection) {
        projection = {
          observationId: obsId,
          captureId: raw.captureId ?? captureId,
          sessionId: payload.sessionId,
          status: "pending",
          attempts: 0,
          updatedAt: new Date().toISOString(),
        };
        await writeObservationProjection(kv, projection);
      }

      if (!isNewCapture && !projectionWasMissing) {
        return {
          observationId: obsId,
          captureId: projection.captureId,
          deduplicated: true,
          sessionId: payload.sessionId,
          projectionStatus: projection.status,
        };
      }

      if (projection.status === "succeeded") {
        return {
          observationId: obsId,
          captureId: projection.captureId,
          deduplicated: true,
          sessionId: payload.sessionId,
        };
      }

      await markProjectionPending(
        kv,
        "compression",
        obsId,
        projection.updatedAt,
      );

      if (isNewCapture) {
        void Promise.allSettled([
          sdk.trigger({
            function_id: "stream::set",
            payload: {
              stream_name: STREAM.name,
              group_id: STREAM.group(payload.sessionId),
              item_id: obsId,
              data: { type: "raw", observation: raw },
            },
          }),
          sdk.trigger({
            function_id: "stream::send",
            payload: {
              stream_name: STREAM.name,
              group_id: STREAM.viewerGroup,
              id: `raw-${obsId}`,
              type: "raw_observation",
              data: {
                type: "raw",
                observation: raw,
                sessionId: payload.sessionId,
              },
            },
            action: TriggerAction.Void(),
          }),
        ]).then((streamResults) => {
          for (const result of streamResults) {
            if (result.status === "rejected") {
              logger.warn("Non-fatal raw observation stream publish failure", {
                observationId: obsId,
                sessionId: payload.sessionId,
                error:
                  result.reason instanceof Error
                    ? result.reason.message
                    : String(result.reason),
              });
            }
          }
        });
      }

      void sdk
        .trigger({
          function_id: "iii::durable::publish",
          payload: {
            topic: observationProjectionQueue(obsId),
            data: {
              observationId: obsId,
              sessionId: payload.sessionId,
            },
          },
          action: TriggerAction.Void(),
        })
        .catch((error) => {
          logger.warn("Observation projection dispatch failed", {
            observationId: obsId,
            sessionId: payload.sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });

      logger.info("Observation captured", {
        obsId,
        sessionId: payload.sessionId,
        hook: payload.hookType,
        compress: isAutoCompressEnabled() ? "llm" : "synthetic",
      });
      return {
        observationId: obsId,
        captureId: projection.captureId,
        ...(isNewCapture
          ? {}
          : { deduplicated: true, projectionQueued: true }),
      };
    });
  });
}
