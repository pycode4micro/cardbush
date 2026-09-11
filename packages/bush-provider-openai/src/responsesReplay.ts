import type { Response, ResponseInputItem } from "openai/resources/responses/responses";
import type { ModelMessage, ModelReplayData, ModelRequest } from "@cardbush/bush-protocol";
import { modelReplayMatches } from "@cardbush/bush-runtime";
import { responseToolName } from "./responsesToolNames.js";

const REPLAY_FORMAT = "openai.responses.output.v1";
export type ResponsesToolSearchMode = "native" | "function";

/** Store output items and their projection mode, never transport or credentials. */
export function responsesReplayData(response: Response, toolSearchMode?: ResponsesToolSearchMode): ModelReplayData | undefined {
  const items = Array.isArray(response.output) && response.output.every(isReplayItem) ? response.output : [];
  if (!items.length && !toolSearchMode) return undefined;
  return { format: REPLAY_FORMAT, data: { items: structuredClone(items),
    ...(toolSearchMode ? { toolSearchMode } : {}) } };
}

export function replayResponsesOutput(
  message: Extract<ModelMessage, { role: "assistant" }>,
  request: Pick<ModelRequest, "model" | "providerBinding">,
): ResponseInputItem[] | undefined {
  const replay = message.providerReplay;
  if (replay?.format !== REPLAY_FORMAT || !modelReplayMatches(message, request)) return undefined;
  const items = replay.data.items;
  if (!Array.isArray(items) || items.length === 0 || !items.every(isReplayItem)) return undefined;

  // Some compatible endpoints return incomplete terminal snapshots. Replaying
  // them must not omit streamed text or resurrect an unexecuted function call.
  const text = items.filter((item) => item.type === "message")
    .flatMap((item) => item.content)
    .map((part) => part.type === "output_text" ? part.text : part.refusal)
    .join("");
  const calls = items.flatMap((item) => item.type === "function_call"
    ? [[item.call_id, item.name, item.arguments]]
    : isClientToolSearchCall(item) ? [[item.call_id, "mcp_search", clientToolSearchArguments(item)]] : []);
  const reasoningItems = items.filter(item => item.type === "reasoning");
  const reasoningText = reasoningItems.flatMap(item => [
    ...(Array.isArray(item.content) ? item.content : []).map(part => typeof part?.text === "string" ? part.text : ""),
    ...item.summary.map(part => typeof part?.text === "string" ? part.text : ""),
  ]).join("");
  // A terminal snapshot can omit an entire reasoning item while retaining
  // every call and text item. Do not let that snapshot erase streamed facts.
  // Encrypted reasoning remains opaque and must be replayed intact.
  if (message.reasoningContent && reasoningText.length !== message.reasoningContent.length &&
    !reasoningItems.some(item => item.encrypted_content)) return undefined;
  if (text !== message.content || JSON.stringify(calls) !== JSON.stringify(
    message.toolCalls.map((call) => [call.id, responseToolName(call.name), call.argumentsText]),
  )) return undefined;
  return structuredClone(items) as ResponseInputItem[];
}

/** The mode is bound to the same immutable output as the rest of provider replay. */
export function replayToolSearchMode(message: Extract<ModelMessage, { role: "assistant" }>,
  request: Pick<ModelRequest, "model" | "providerBinding">): ResponsesToolSearchMode | undefined {
  if (message.providerReplay?.format !== REPLAY_FORMAT || !modelReplayMatches(message, request)) return undefined;
  const mode = message.providerReplay?.data.toolSearchMode;
  if (mode === "native" || mode === "function") return mode;
  return replayResponsesOutput(message, request)?.some(isClientToolSearchCall) ? "native" : undefined;
}

export function isClientToolSearchCall(value: unknown): value is Extract<Response["output"][number], { type: "tool_search_call" }> & { call_id: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.type === "tool_search_call" && item.execution === "client" && item.status === "completed" &&
    typeof item.call_id === "string" && item.call_id.length > 0 &&
    !!item.arguments && typeof item.arguments === "object" && !Array.isArray(item.arguments);
}

export function clientToolSearchArguments(item: { arguments: unknown }): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)])) : value;
  return JSON.stringify(canonical(item.arguments));
}

type ReplayItem = Extract<Response["output"][number],
  { type: "message" | "reasoning" | "function_call" | "tool_search_call" }>;

function isReplayItem(value: unknown): value is ReplayItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.type === "tool_search_call") return isClientToolSearchCall(item);
  if (item.type === "reasoning") {
    return typeof item.id === "string" && Array.isArray(item.summary);
  }
  if (item.type === "function_call") {
    return typeof item.call_id === "string" && typeof item.name === "string" &&
      typeof item.arguments === "string";
  }
  return item.type === "message" && item.role === "assistant" &&
    Array.isArray(item.content) && item.content.every((part: unknown) => {
      if (!part || typeof part !== "object") return false;
      const content = part as Record<string, unknown>;
      return (content.type === "output_text" && typeof content.text === "string") ||
        (content.type === "refusal" && typeof content.refusal === "string");
    });
}
