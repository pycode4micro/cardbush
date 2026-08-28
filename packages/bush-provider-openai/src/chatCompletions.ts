import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import {
  BUSH_MODEL_EVENT_PROTOCOL,
  type ModelEvent,
  type ModelMessage,
  type ModelRequest,
} from "@cardbush/bush-protocol";
import type { ModelProvider, ModelStreamOptions } from "@cardbush/bush-runtime";

export interface OpenAICompatibleProviderConfig {
  apiKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
  reasoningDelta?: (chunk: unknown) => string;
}

export interface ChunkNormalizationState {
  requestId: string;
  sequence: number;
  started: boolean;
}

type EventBaseKeys = "protocol" | "requestId" | "sequence" | "createdAt";
type ModelEventPayload = ModelEvent extends infer Event
  ? Event extends ModelEvent
    ? Omit<Event, EventBaseKeys>
    : never
  : never;

function timestampFromChunk(chunk: ChatCompletionChunk): string {
  if (typeof chunk.created === "number" && Number.isFinite(chunk.created)) {
    return new Date(chunk.created * 1000).toISOString();
  }
  return new Date().toISOString();
}

function defaultReasoningDelta(chunk: unknown): string {
  if (!chunk || typeof chunk !== "object") {
    return "";
  }
  const choices = (chunk as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) {
    return "";
  }
  const delta = (choices[0] as { delta?: unknown } | undefined)?.delta;
  if (!delta || typeof delta !== "object") {
    return "";
  }
  const record = delta as Record<string, unknown>;
  for (const key of ["reasoning_content", "reasoning"]) {
    if (typeof record[key] === "string") {
      return record[key];
    }
  }
  return "";
}

export function normalizeChatCompletionChunk(
  chunk: ChatCompletionChunk,
  state: ChunkNormalizationState,
  reasoningDelta: (chunk: unknown) => string = defaultReasoningDelta,
): ModelEvent[] {
  const events: ModelEvent[] = [];
  const createdAt = timestampFromChunk(chunk);
  const append = (event: ModelEventPayload): void => {
    events.push({
      protocol: BUSH_MODEL_EVENT_PROTOCOL,
      requestId: state.requestId,
      sequence: state.sequence++,
      createdAt,
      ...event,
    } as ModelEvent);
  };

  if (!state.started) {
    state.started = true;
    append({ kind: "response_started", providerResponseId: chunk.id || undefined });
  }

  const choice = chunk.choices[0];
  const content = choice?.delta?.content;
  if (typeof content === "string" && content) {
    append({ kind: "text_delta", delta: content });
  }

  const reasoning = reasoningDelta(chunk);
  if (reasoning) {
    append({ kind: "reasoning_delta", delta: reasoning });
  }

  for (const toolCall of choice?.delta?.tool_calls ?? []) {
    append({
      kind: "tool_call_delta",
      index: toolCall.index,
      toolCallId: toolCall.id || undefined,
      nameDelta: toolCall.function?.name || undefined,
      argumentsDelta: toolCall.function?.arguments || undefined,
    });
  }

  const usage = chunk.usage;
  if (usage) {
    const details = usage.prompt_tokens_details;
    append({
      kind: "usage",
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      cachedInputTokens: details?.cached_tokens ?? undefined,
    });
  }

  if (choice?.finish_reason) {
    append({ kind: "response_completed", finishReason: choice.finish_reason });
  }
  return events;
}

function toOpenAIMessage(message: ModelMessage): ChatCompletionMessageParam {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId,
    };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.length
        ? message.toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: call.argumentsText },
          }))
        : undefined,
    };
  }
  return {
    role: message.role,
    content: message.content,
    name: message.name,
  } as ChatCompletionMessageParam;
}

function toOpenAITools(request: ModelRequest): ChatCompletionTool[] | undefined {
  if (!request.tools.length) {
    return undefined;
  }
  return request.tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function retryableStatus(status: number | undefined): boolean {
  return status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
}

function providerFailureEvent(
  requestId: string,
  sequence: number,
  error: unknown,
  aborted: boolean,
): ModelEvent {
  if (aborted) {
    return {
      protocol: BUSH_MODEL_EVENT_PROTOCOL,
      requestId,
      sequence,
      createdAt: new Date().toISOString(),
      kind: "response_failed",
      code: "request_aborted",
      message: "The model request was aborted.",
      retryable: false,
    };
  }
  if (error instanceof OpenAI.APIError) {
    return {
      protocol: BUSH_MODEL_EVENT_PROTOCOL,
      requestId,
      sequence,
      createdAt: new Date().toISOString(),
      kind: "response_failed",
      code: typeof error.code === "string" && error.code ? error.code : error.name,
      message: error.message,
      retryable: retryableStatus(error.status),
      status: error.status,
      providerRequestId: error.requestID ?? undefined,
    };
  }
  return {
    protocol: BUSH_MODEL_EVENT_PROTOCOL,
    requestId,
    sequence,
    createdAt: new Date().toISOString(),
    kind: "response_failed",
    code: "provider_connection_error",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly #client: OpenAI;
  readonly #reasoningDelta: (chunk: unknown) => string;

  constructor(config: OpenAICompatibleProviderConfig) {
    this.#client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      defaultHeaders: config.defaultHeaders,
      timeout: config.timeoutMs,
      maxRetries: 0,
    });
    this.#reasoningDelta = config.reasoningDelta ?? defaultReasoningDelta;
  }

  async *stream(
    request: ModelRequest,
    options: ModelStreamOptions = {},
  ): AsyncIterable<ModelEvent> {
    const state: ChunkNormalizationState = {
      requestId: request.requestId,
      sequence: 0,
      started: false,
    };
    let completed = false;
    try {
      const stream = await this.#client.chat.completions.create(
        {
          model: request.model,
          messages: request.messages.map(toOpenAIMessage),
          tools: toOpenAITools(request),
          tool_choice: request.tools.length ? request.toolChoice : undefined,
          temperature: request.temperature,
          top_p: request.topP,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: options.signal },
      );
      for await (const chunk of stream) {
        for (const event of normalizeChatCompletionChunk(
          chunk,
          state,
          this.#reasoningDelta,
        )) {
          if (event.kind === "response_completed") {
            completed = true;
          }
          yield event;
        }
      }
      if (!completed) {
        yield {
          protocol: BUSH_MODEL_EVENT_PROTOCOL,
          requestId: request.requestId,
          sequence: state.sequence++,
          createdAt: new Date().toISOString(),
          kind: "response_failed",
          code: "provider_stream_incomplete",
          message: "The provider stream ended without a terminal finish reason.",
          retryable: true,
        };
      }
    } catch (error) {
      yield providerFailureEvent(
        request.requestId,
        state.sequence++,
        error,
        options.signal?.aborted === true,
      );
    }
  }
}
