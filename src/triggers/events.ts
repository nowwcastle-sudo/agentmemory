import { TriggerAction, type ISdk } from "iii-sdk";
import type {
  HookPayload,
  ObservationProjection,
  RawObservation,
  Session,
} from "../types.js";
import { KV, STREAM } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { getAgentId } from "../config.js";
import { logger } from "../logger.js";
import {
  completeActiveSession,
  isValidSessionRow,
} from "../state/session-lifecycle.js";

async function settleSessionObservationProjections(
  sdk: ISdk,
  kv: StateKV,
  sessionId: string,
): Promise<void> {
  const rawObservations = await kv.list<RawObservation>(
    KV.rawObservations(sessionId),
  );
  for (const raw of rawObservations) {
    const projection = await kv.get<ObservationProjection>(
      KV.observationProjections,
      raw.id,
    );
    if (!projection || projection.status === "succeeded") continue;
    try {
      await sdk.trigger({
        function_id: "mem::queue-observation-projection",
        payload: { observationId: raw.id, sessionId },
      });
    } catch (err) {
      logger.warn("Observation projection settle failed", {
        observationId: raw.id,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export function registerEventTriggers(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "event::session::started",
    async (data: {
      sessionId: string;
      project: string;
      cwd: string;
      agentId?: string;
      sourceClient?: string;
    }) => {
      const requestAgentId =
        typeof data.agentId === "string" && data.agentId.trim().length > 0
          ? data.agentId.trim().slice(0, 128)
          : undefined;
      const agentId = requestAgentId ?? getAgentId();
      const sourceClient =
        typeof data.sourceClient === "string" && data.sourceClient.trim().length > 0
          ? data.sourceClient.trim().slice(0, 64)
          : undefined;
      const session: Session = {
        id: data.sessionId,
        project: data.project,
        cwd: data.cwd,
        startedAt: new Date().toISOString(),
        status: "active",
        observationCount: 0,
        ...(agentId ? { agentId } : {}),
        ...(sourceClient ? { sourceClient } : {}),
      };
      await kv.set(KV.sessions, data.sessionId, session);
      const contextResult = await sdk.trigger<
        { sessionId: string; project: string; agentId?: string },
        { context: string }
      >({
        function_id: "mem::context",
        payload: {
          sessionId: data.sessionId,
          project: data.project,
          ...(agentId ? { agentId } : {}),
        },
      });
      return { session, context: contextResult.context };
    },
  );
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::session::started",
    config: { topic: "agentmemory.session.started" },
  });

  sdk.registerFunction("event::observation", async (data: HookPayload) =>
    sdk.trigger({ function_id: "mem::observe", payload: data }),
  );
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::observation",
    config: { topic: "agentmemory.observation" },
  });

  sdk.registerFunction("event::session::stopped", async (data: { sessionId: string }) => {
    await settleSessionObservationProjections(sdk, kv, data.sessionId);
    return { success: true, checkpointed: true };
  });
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::session::stopped",
    config: { topic: "agentmemory.session.stopped" },
  });

  sdk.registerFunction(
    "event::session::ended",
    async (data: {
      sessionId: string;
      transitionConfirmed?: boolean;
      evictAfterSuccess?: boolean;
    }) => {
      let completion;
      if (data.transitionConfirmed === true) {
        const session = await kv.get<Session>(KV.sessions, data.sessionId);
        completion = isValidSessionRow(session) && session.status === "completed"
          ? { transitioned: true as const, session }
          : { transitioned: false as const, reason: "session_not_found" as const };
      } else {
        completion = await completeActiveSession(kv, data.sessionId);
      }
      const recoverCompletedEviction =
        data.evictAfterSuccess === true &&
        !completion.transitioned &&
        completion.reason === "already_completed";
      if (!completion.transitioned && !recoverCompletedEviction) {
        return { success: true, ...completion };
      }

      await settleSessionObservationProjections(sdk, kv, data.sessionId);
      const projection = (await sdk.trigger({
        function_id: "mem::queue-session-projection",
        payload: {
          sessionId: data.sessionId,
          ...(data.evictAfterSuccess ? { evictAfterSuccess: true } : {}),
        },
      })) as { success?: boolean; error?: string } | null;
      if (!projection?.success) {
        return {
          success: false,
          ...completion,
          error: projection?.error || "session_projection_queue_failed",
        };
      }
      return { success: true, ...completion, ...projection };
    },
  );
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::session::ended",
    config: { topic: "agentmemory.session.ended" },
  });

  // React to observation count changes and emit a lightweight live event for dashboards/viewer.
  sdk.registerFunction(
    "event::session::observation-count-changed",
    async (payload: {
      key: string;
      event_type: string;
      old_value?: Session;
      new_value?: Session;
    }) => {
      if (payload.event_type === "delete") return { skipped: true };
      const oldCount = payload.old_value?.observationCount ?? 0;
      const newCount = payload.new_value?.observationCount ?? 0;
      if (newCount <= oldCount) return { skipped: true };

      await sdk.trigger({
        function_id: "stream::send",
        payload: {
          stream_name: STREAM.name,
          group_id: STREAM.viewerGroup,
          id: `session-activity-${payload.key}-${Date.now()}`,
          type: "session.activity",
          data: {
            sessionId: payload.key,
            observationCount: newCount,
            delta: newCount - oldCount,
            updatedAt: payload.new_value?.updatedAt ?? new Date().toISOString(),
          },
        },
        action: TriggerAction.Void(),
      });

      return { emitted: true };
    },
  );
  sdk.registerTrigger({
    type: "state",
    function_id: "event::session::observation-count-changed",
    config: { scope: KV.sessions },
  });
}
