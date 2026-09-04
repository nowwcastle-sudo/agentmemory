#!/usr/bin/env node
import { resolveProjectPayload, hookCwd } from "./_project.js";
import { defaultHookDelivery, hookSessionId, stableHookCaptureId } from "./_delivery.js";

function isSdkChildContext(payload: unknown): boolean {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (!payload || typeof payload !== "object") return false;
  return (payload as { entrypoint?: unknown }).entrypoint === "sdk-ts";
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    return;
  }

  if (!data || typeof data !== "object") return;
  if (isSdkChildContext(data)) return;

  const sessionId = hookSessionId(data);
  if (!sessionId) return;
  const toolName = data.tool_name ?? data.toolName;
  const toolInput = data.tool_input ?? data.toolArgs;

  const { imageData, cleanOutput } = extractImageData(toolOutput(data));
  const cwd = hookCwd(data) || process.cwd();

  const outputRecord = typeof cleanOutput === "object" && cleanOutput !== null
    ? cleanOutput as Record<string, unknown>
    : null;
  const hookType = outputRecord?.success === false ? "post_tool_failure" : "post_tool_use";
  const toolUseId = data.tool_use_id ?? data.toolUseId ?? data.call_id ?? data.turn_id ?? toolName;
  await defaultHookDelivery().deliver("/agentmemory/observe", {
    captureId: stableHookCaptureId(sessionId, "tool", toolUseId),
    hookType,
    sessionId,
    ...resolveProjectPayload(cwd),
    cwd,
    ...(typeof data.agent_id === "string" ? { agentId: data.agent_id } : {}),
    timestamp: new Date().toISOString(),
    data: {
      tool_name: toolName,
      tool_input: toolInput,
      tool_output: truncate(cleanOutput, 8000),
      call_id: toolUseId,
      ...(imageData ? { image_data: imageData } : {}),
    },
  });
}

function toolOutput(data: Record<string, unknown>): unknown {
  if (data.tool_response !== undefined) return data.tool_response;
  if (data.tool_output !== undefined) return data.tool_output;
  const result = data.tool_result ?? data.toolResult;
  if (typeof result === "object" && result !== null) {
    const obj = result as Record<string, unknown>;
    return obj.text_result_for_llm ?? obj.textResultForLlm ?? result;
  }
  return result;
}

function isBase64Image(val: unknown): val is string {
  return typeof val === "string" && (
    val.startsWith("data:image/") ||
    val.startsWith("iVBORw0KGgo") ||
    val.startsWith("/9j/")
  );
}

function extractImageData(output: unknown): { imageData: string | undefined; cleanOutput: unknown } {
  if (isBase64Image(output)) {
    return { imageData: output, cleanOutput: "[image data extracted]" };
  }

  if (typeof output === "object" && output !== null && !Array.isArray(output)) {
    const obj = output as Record<string, unknown>;
    let imageData: string | undefined;
    const clean: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(obj)) {
      if (!imageData && isBase64Image(val)) {
        imageData = val;
        clean[key] = "[image data extracted]";
      } else {
        clean[key] = val;
      }
    }

    return { imageData, cleanOutput: clean };
  }

  return { imageData: undefined, cleanOutput: output };
}

function truncate(value: unknown, max: number): unknown {
  if (typeof value === "string" && value.length > max) {
    return value.slice(0, max) + "\n[...truncated]";
  }
  if (typeof value === "object" && value !== null) {
    const str = JSON.stringify(value);
    if (str.length > max) return str.slice(0, max) + "...[truncated]";
    return value;
  }
  return value;
}

main().catch(() => process.exit(0));
