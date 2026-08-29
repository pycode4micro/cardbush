import OpenAI from "openai";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
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
  const content = message.role === "user" && message.images?.length
    ? [
        { type: "text" as const, text: message.content },
        ...message.images.map((image) => ({
          type: "image_url" as const,
          image_url: { url: image.url, ...(image.detail ? { detail: image.detail } : {}) },
        })),
      ]
    : message.content;
  return {
    // `developer` is an internal Bush protocol role. OpenAI-compatible Chat
    // Completions providers do not agree on whether that newer role exists,
    // while all of them accept `system`. Keep the distinction inside Runtime
    // and project it mechanically at the provider boundary.
    role: message.role === "developer" ? "system" : message.role,
    content,
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

export async function resolveLocalImageInputs(request: ModelRequest): Promise<ModelRequest> {
  const messages = await Promise.all(request.messages.map(async (message) => {
    if (!("images" in message) || !message.images?.length) return message;
    return {
      ...message,
      images: await Promise.all(message.images.map(async (image) => ({
        ...image,
        url: await resolvedImageUrl(image.url),
      }))),
    };
  }));
  return { ...request, messages };
}

async function resolvedImageUrl(source: string): Promise<string> {
  const value = source.trim();
  if (/^https?:\/\//i.test(value) || /^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) {
    return value;
  }
  if (!isAbsolute(value)) throw new Error("Model image path must be absolute.");
  const info = await stat(value);
  if (!info.isFile()) throw new Error(`Model image is not a file: ${value}`);
  const maxBytes = 9_000_000;
  if (info.size > maxBytes) throw new Error(`Model image exceeds ${maxBytes} bytes: ${value}`);
  const content = await readFile(value);
  return `data:${imageMime(content)};base64,${content.toString("base64")}`;
}

function imageMime(content: Buffer): string {
  if (
    content.length >= 32 &&
    content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    content.subarray(-12, -8).readUInt32BE(0) === 0 &&
    content.subarray(-8, -4).toString("ascii") === "IEND"
  ) {
    return "image/png";
  }
  if (
    content.length >= 4 &&
    content[0] === 0xff && content[1] === 0xd8 &&
    content.at(-2) === 0xff && content.at(-1) === 0xd9
  ) {
    return "image/jpeg";
  }
  if (
    content.length >= 14 &&
    ["GIF87a", "GIF89a"].includes(content.subarray(0, 6).toString("ascii")) &&
    content.at(-1) === 0x3b
  ) {
    return "image/gif";
  }
  if (
    content.length >= 12 &&
    content.subarray(0, 4).toString("ascii") === "RIFF" &&
    content.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    content.length >= 26 &&
    content.subarray(0, 2).toString("ascii") === "BM" &&
    content.readUInt32LE(2) <= content.length
  ) {
    return "image/bmp";
  }
  throw new Error("Model image content is not a supported raster image.");
}

export function toChatCompletionCreateParams(
  request: ModelRequest,
): ChatCompletionCreateParamsStreaming {
  return {
    model: request.model,
    messages: request.messages.map(toOpenAIMessage),
    tools: toOpenAITools(request),
    tool_choice: request.tools.length ? request.toolChoice : undefined,
    max_completion_tokens: request.maxOutputTokens,
    temperature: request.temperature,
    top_p: request.topP,
    reasoning_effort: request.reasoningEffort,
    stream: true,
    stream_options: { include_usage: true },
  };
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
        toChatCompletionCreateParams(await resolveLocalImageInputs(request)),
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
