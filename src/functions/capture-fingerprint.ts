import { createHash } from "node:crypto";
import type { HookPayload, Session } from "../types.js";
import { stripPrivateData } from "./privacy.js";

export const CAPTURE_FINGERPRINT_VERSION = 1 as const;

type IdentityField =
  | { source: "payload"; value: string }
  | { source: "inherited"; value: string }
  | { source: "explicit_empty" }
  | { source: "omitted" };

type InheritedIdentity = Partial<
  Pick<Session, "project" | "projectName" | "cwd" | "agentId" | "sourceClient">
>;

export type CaptureFingerprintInputV1 = {
  sessionId: string;
  captureId: string;
  hookType: string;
  timestamp: string;
  project: IdentityField;
  projectName: IdentityField;
  cwd: IdentityField;
  agentId: IdentityField;
  sourceClient: IdentityField;
  sanitizedRawJson: string;
};

export function sanitizeObservationData(data: unknown): unknown {
  try {
    const json = JSON.stringify(data);
    return JSON.parse(stripPrivateData(json));
  } catch {
    return stripPrivateData(String(data));
  }
}

function normalizeIdentity(value: unknown, maxLength?: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return maxLength ? normalized.slice(0, maxLength) : normalized;
}

function identityField(
  payload: HookPayload,
  key: keyof InheritedIdentity,
  inherited: unknown,
  maxLength?: number,
): IdentityField {
  if (Object.prototype.hasOwnProperty.call(payload, key)) {
    const value = normalizeIdentity(payload[key], maxLength);
    return value
      ? { source: "payload", value }
      : { source: "explicit_empty" };
  }
  const value = normalizeIdentity(inherited, maxLength);
  return value ? { source: "inherited", value } : { source: "omitted" };
}

export function buildCaptureFingerprintInputV1(args: {
  payload: HookPayload;
  captureId: string;
  sanitizedRaw: unknown;
  inheritedSession?: InheritedIdentity | null;
  configuredAgentId?: string;
}): CaptureFingerprintInputV1 {
  const inherited = args.inheritedSession;
  return {
    sessionId: args.payload.sessionId,
    captureId: args.captureId,
    hookType: args.payload.hookType,
    timestamp: args.payload.timestamp,
    project: identityField(args.payload, "project", inherited?.project),
    projectName: identityField(
      args.payload,
      "projectName",
      inherited?.projectName,
    ),
    cwd: identityField(args.payload, "cwd", inherited?.cwd),
    agentId: identityField(
      args.payload,
      "agentId",
      inherited?.agentId ?? args.configuredAgentId,
      128,
    ),
    sourceClient: identityField(
      args.payload,
      "sourceClient",
      inherited?.sourceClient,
      64,
    ),
    sanitizedRawJson: JSON.stringify(args.sanitizedRaw) ?? "undefined",
  };
}

export function hashCaptureFingerprintV1(
  input: CaptureFingerprintInputV1,
): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}
