import type { Session } from "../types.js";
import type { StateKV } from "./kv.js";
import { withKeyedLock } from "./keyed-mutex.js";
import { KV } from "./schema.js";

export type SessionCompletionResult =
  | { transitioned: true; session: Session }
  | {
      transitioned: false;
      reason: "session_not_found" | "already_completed" | "session_not_active";
      session?: Session;
    };

export type SessionCheckpointResult =
  | { checkpointed: true; session: Session }
  | {
      checkpointed: false;
      reason: "session_not_found" | "already_completed" | "session_not_active";
      session?: Session;
    };

function isSession(value: unknown, sessionId: string): value is Session {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Session>;
  return (
    candidate.id === sessionId &&
    typeof candidate.project === "string" &&
    typeof candidate.cwd === "string" &&
    typeof candidate.startedAt === "string" &&
    typeof candidate.observationCount === "number" &&
    (candidate.status === "active" ||
      candidate.status === "completed" ||
      candidate.status === "abandoned")
  );
}

export async function completeActiveSession(
  kv: StateKV,
  sessionId: string,
): Promise<SessionCompletionResult> {
  return withKeyedLock(`obs:${sessionId}`, async () => {
    const current = await kv.get<Session>(KV.sessions, sessionId);
    if (!isSession(current, sessionId)) {
      return { transitioned: false, reason: "session_not_found" };
    }
    if (current.status === "completed") {
      return {
        transitioned: false,
        reason: "already_completed",
        session: current,
      };
    }
    if (current.status !== "active") {
      return {
        transitioned: false,
        reason: "session_not_active",
        session: current,
      };
    }

    const session: Session = {
      ...current,
      endedAt: new Date().toISOString(),
      status: "completed",
    };
    await kv.set(KV.sessions, sessionId, session);
    return { transitioned: true, session };
  });
}

export async function checkpointActiveSession(
  kv: StateKV,
  sessionId: string,
): Promise<SessionCheckpointResult> {
  return withKeyedLock(`obs:${sessionId}`, async () => {
    const current = await kv.get<Session>(KV.sessions, sessionId);
    if (!isSession(current, sessionId)) {
      return { checkpointed: false, reason: "session_not_found" };
    }
    if (current.status === "completed") {
      return {
        checkpointed: false,
        reason: "already_completed",
        session: current,
      };
    }
    if (current.status !== "active") {
      return {
        checkpointed: false,
        reason: "session_not_active",
        session: current,
      };
    }
    return { checkpointed: true, session: current };
  });
}

export function isValidSessionRow(value: unknown): value is Session {
  if (!value || typeof value !== "object") return false;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 && isSession(value, id);
}
