import type { ISdk } from "../iii-compat.js";
import { logger } from "../logger.js";

// Live-update publishing to the engine's streams (stream::set / stream::send),
// which the viewer reads. The engine this fork runs on (iii 0.23.1) does not
// register those functions in the default namespace while the SDK (0.11.2)
// still calls them, so every projection used to log "Non-fatal stream publish
// failure … [object Object]" -- the rejection is a plain {code, message}
// object -- and the next projection tried again (problem 20, 2026-09-11).
// The first function_not_found turns publishing off for the life of the
// process with one line; any other failure is named, once per item.

type StreamItem = {
  function_id: string;
  payload: Record<string, unknown>;
  action?: unknown;
};

type PublishContext = {
  where: string;
  sessionId?: string;
  observationId?: string;
};

let unavailable = false;

export function resetStreamPublisherForTests(): void {
  unavailable = false;
}

function describeReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

function isFunctionNotFound(reason: unknown): boolean {
  return (
    !!reason &&
    typeof reason === "object" &&
    (reason as { code?: unknown }).code === "function_not_found"
  );
}

export async function publishStreamItems(
  sdk: ISdk,
  items: StreamItem[],
  context: PublishContext,
): Promise<void> {
  if (unavailable || items.length === 0) return;
  const results = await Promise.allSettled(
    items.map((item) => sdk.trigger(item as never)),
  );
  for (const result of results) {
    if (result.status !== "rejected") continue;
    if (isFunctionNotFound(result.reason)) {
      if (!unavailable) {
        unavailable = true;
        logger.info("Engine has no stream functions; live viewer updates are off for this process", {
          where: context.where,
          detail: describeReason(result.reason),
        });
      }
      continue;
    }
    logger.warn(`Non-fatal stream publish failure after ${context.where}`, {
      sessionId: context.sessionId,
      observationId: context.observationId,
      error: describeReason(result.reason),
    });
  }
}
