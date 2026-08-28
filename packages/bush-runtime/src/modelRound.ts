import {
  BUSH_MODEL_EVENT_PROTOCOL,
  modelEventSchema,
  modelRequestSchema,
  type ModelEvent,
  type ModelRequest,
  type ToolCall,
} from "@cardbush/bush-protocol";

import type { ModelProvider, ModelStreamOptions } from "./modelProvider.js";
import { ToolCallAccumulator } from "./toolCallAccumulator.js";

export interface ModelRoundUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

export interface CompletedModelRound {
  status: "completed";
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason?: string;
  usage: ModelRoundUsage;
}

export interface FailedModelRound {
  status: "failed";
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: ModelRoundUsage;
  error: Extract<ModelEvent, { kind: "response_failed" }>;
}

export type ModelRoundResult = CompletedModelRound | FailedModelRound;

export interface ModelRoundOptions extends ModelStreamOptions {
  onEvent?: (event: ModelEvent) => void | Promise<void>;
}

function localFailure(
  requestId: string,
  sequence: number,
  code: string,
  message: string,
): Extract<ModelEvent, { kind: "response_failed" }> {
  return {
    protocol: BUSH_MODEL_EVENT_PROTOCOL,
    requestId,
    sequence,
    createdAt: new Date().toISOString(),
    kind: "response_failed",
    code,
    message,
    retryable: true,
  };
}

export async function executeModelRound(
  provider: ModelProvider,
  input: ModelRequest,
  options: ModelRoundOptions = {},
): Promise<ModelRoundResult> {
  const request = modelRequestSchema.parse(input);
  const accumulator = new ToolCallAccumulator();
  let text = "";
  let reasoning = "";
  let finishReason: string | undefined;
  let completed = false;
  let failure: Extract<ModelEvent, { kind: "response_failed" }> | undefined;
  let lastSequence = -1;
  const usage: ModelRoundUsage = {};

  for await (const candidate of provider.stream(request, { signal: options.signal })) {
    const event = modelEventSchema.parse(candidate);
    if (event.requestId !== request.requestId) {
      failure = localFailure(
        request.requestId,
        Math.max(lastSequence + 1, event.sequence),
        "provider_request_identity_mismatch",
        `Provider event belongs to ${event.requestId}, expected ${request.requestId}.`,
      );
      break;
    }
    if (event.sequence <= lastSequence) {
      failure = localFailure(
        request.requestId,
        lastSequence + 1,
        "provider_event_sequence_regression",
        `Provider event sequence ${event.sequence} is not greater than ${lastSequence}.`,
      );
      break;
    }
    lastSequence = event.sequence;
    await options.onEvent?.(event);

    if (completed && event.kind !== "usage") {
      failure = localFailure(
        request.requestId,
        lastSequence + 1,
        "provider_event_after_completion",
        `Provider emitted ${event.kind} after response completion.`,
      );
      break;
    }
    switch (event.kind) {
      case "text_delta":
        text += event.delta;
        break;
      case "reasoning_delta":
        reasoning += event.delta;
        break;
      case "tool_call_delta":
        accumulator.accept(event);
        break;
      case "usage":
        usage.inputTokens = event.inputTokens;
        usage.outputTokens = event.outputTokens;
        usage.cachedInputTokens = event.cachedInputTokens;
        break;
      case "response_completed":
        completed = true;
        finishReason = event.finishReason;
        break;
      case "response_failed":
        failure = event;
        break;
      case "response_started":
        break;
    }
    if (failure) {
      break;
    }
  }

  let toolCalls: ToolCall[] = [];
  try {
    toolCalls = accumulator.completed();
  } catch (error) {
    failure ??= localFailure(
      request.requestId,
      lastSequence + 1,
      "incomplete_tool_call",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (!failure && !completed) {
    failure = localFailure(
      request.requestId,
      lastSequence + 1,
      "provider_terminal_event_missing",
      "Provider stream ended without a completed or failed terminal event.",
    );
  }
  if (failure) {
    return { status: "failed", text, reasoning, toolCalls, usage, error: failure };
  }
  return {
    status: "completed",
    text,
    reasoning,
    toolCalls,
    finishReason,
    usage,
  };
}
