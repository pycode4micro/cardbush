import type { Response, ResponseInputItem } from "openai/resources/responses/responses";
import type { ModelMessage, ModelReplayData, ModelRequest } from "@cardbush/bush-protocol";
import { modelReplayMatches } from "@cardbush/bush-runtime";

const REPLAY_FORMAT = "openai.responses.output.v1";

/** Store output items only, never a whole response, transport, or credentials. */
export function responsesReplayData(response: Response): ModelReplayData | undefined {
  if (!Array.isArray(response.output) || response.output.length === 0) return undefined;
  if (!response.output.every(isReplayItem)) return undefined;
  return { format: REPLAY_FORMAT, data: { items: structuredClone(response.output) } };
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
  const calls = items.filter((item) => item.type === "function_call")
    .map((item) => [item.call_id, item.name, item.arguments]);
  if (text !== message.content || JSON.stringify(calls) !== JSON.stringify(
    message.toolCalls.map((call) => [call.id, call.name, call.argumentsText]),
  )) return undefined;
  return structuredClone(items) as ResponseInputItem[];
}

type ReplayItem = Extract<Response["output"][number],
  { type: "message" | "reasoning" | "function_call" }>;

function isReplayItem(value: unknown): value is ReplayItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
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
