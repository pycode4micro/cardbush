import OpenAI from "openai";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseInputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";

import {
  BUSH_MODEL_EVENT_PROTOCOL,
  type ModelEvent,
  type ModelMessage,
  type ModelRequest,
} from "@cardbush/bush-protocol";
import type { ModelProvider, ModelStreamOptions } from "@cardbush/bush-runtime";

export interface OpenAIResponsesProviderConfig {
  apiKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
}

export interface ResponseCreateProjectionOptions {
  disableProviderState?: boolean;
}

export interface ResponseNormalizationState {
  requestId: string;
  sequence: number;
  started: boolean;
  terminal?: boolean;
  toolArguments?: Map<number, string>;
}

type EventBaseKeys = "protocol" | "requestId" | "sequence" | "createdAt";
type ModelEventPayload = ModelEvent extends infer Event
  ? Event extends ModelEvent
    ? Omit<Event, EventBaseKeys>
    : never
  : never;

export function normalizeResponseStreamEvent(
  event: ResponseStreamEvent,
  state: ResponseNormalizationState,
): ModelEvent[] {
  if (state.terminal) return [];
  const events: ModelEvent[] = [];
  const createdAt = responseEventTimestamp(event);
  const append = (payload: ModelEventPayload): void => {
    events.push({
      protocol: BUSH_MODEL_EVENT_PROTOCOL,
      requestId: state.requestId,
      sequence: state.sequence++,
      createdAt,
      ...payload,
    } as ModelEvent);
  };
  const start = (providerResponseId?: string): void => {
    if (state.started) return;
    state.started = true;
    append({ kind: "response_started", providerResponseId });
  };

  if (event.type === "response.created") {
    start(responseContinuationId(event.response));
    return events;
  }
  const response = responseFromEvent(event);
  start(response ? responseContinuationId(response) : undefined);

  switch (event.type) {
    case "response.output_text.delta":
    case "response.refusal.delta":
      if (event.delta) append({ kind: "text_delta", delta: event.delta });
      break;
    case "response.reasoning_text.delta":
    case "response.reasoning_summary_text.delta":
      if (event.delta) append({ kind: "reasoning_delta", delta: event.delta });
      break;
    case "response.output_item.added":
      if (event.item.type === "function_call") {
        append({
          kind: "tool_call_delta",
          index: event.output_index,
          toolCallId: event.item.call_id,
          nameDelta: event.item.name,
        });
      }
      break;
    case "response.function_call_arguments.delta": {
      const toolArguments = state.toolArguments ??= new Map<number, string>();
      toolArguments.set(
        event.output_index,
        `${toolArguments.get(event.output_index) ?? ""}${event.delta}`,
      );
      if (event.delta) {
        append({
          kind: "tool_call_delta",
          index: event.output_index,
          argumentsDelta: event.delta,
        });
      }
      break;
    }
    case "response.function_call_arguments.done": {
      const toolArguments = state.toolArguments ??= new Map<number, string>();
      const streamed = toolArguments.get(event.output_index) ?? "";
      const remaining = event.arguments.startsWith(streamed)
        ? event.arguments.slice(streamed.length)
        : streamed
          ? ""
          : event.arguments;
      if (remaining) {
        append({
          kind: "tool_call_delta",
          index: event.output_index,
          toolCallId: event.item_id,
          nameDelta: streamed ? undefined : event.name,
          argumentsDelta: remaining,
        });
      }
      toolArguments.set(event.output_index, event.arguments);
      break;
    }
    case "response.completed":
      appendResponseUsage(event.response, append);
      append({
        kind: "response_completed",
        finishReason: responseFinishReason(event.response),
      });
      state.terminal = true;
      break;
    case "response.incomplete":
      appendResponseUsage(event.response, append);
      append({
        kind: "response_completed",
        finishReason: incompleteFinishReason(event.response),
      });
      state.terminal = true;
      break;
    case "response.failed":
      append(responseFailurePayload(event.response));
      state.terminal = true;
      break;
    case "error":
      append({
        kind: "response_failed",
        code: event.code || "provider_response_error",
        message: event.message,
        retryable: retryableProviderCode(event.code),
      });
      state.terminal = true;
      break;
    default:
      break;
  }
  return events;
}

function responseEventTimestamp(event: ResponseStreamEvent): string {
  const response = responseFromEvent(event);
  return response && Number.isFinite(response.created_at)
    ? new Date(response.created_at * 1000).toISOString()
    : new Date().toISOString();
}

function responseFromEvent(event: ResponseStreamEvent): Response | undefined {
  return "response" in event && event.response && typeof event.response === "object"
    ? event.response
    : undefined;
}

function responseContinuationId(response: Response): string | undefined {
  return responseStore(response) === true ? response.id : undefined;
}

function responseStore(response: Response): boolean | undefined {
  return (response as Response & { store?: boolean }).store;
}

function appendResponseUsage(
  response: Response,
  append: (event: ModelEventPayload) => void,
): void {
  if (!response.usage) return;
  append({
    kind: "usage",
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cachedInputTokens: response.usage.input_tokens_details?.cached_tokens,
  });
}

function responseFinishReason(response: Response): string {
  return response.output.some((item) => item.type === "function_call")
    ? "tool_calls"
    : "stop";
}

function incompleteFinishReason(response: Response): string {
  const reason = response.incomplete_details?.reason ?? "incomplete";
  return reason === "max_output_tokens" ? "length" : reason;
}

function responseFailurePayload(response: Response): ModelEventPayload {
  const code = response.error?.code ?? "provider_response_failed";
  return {
    kind: "response_failed",
    code,
    message: response.error?.message ?? "The provider failed to generate a response.",
    retryable: retryableProviderCode(code),
    providerRequestId: response.id,
  };
}

function retryableProviderCode(code: string | null | undefined): boolean {
  return /(?:server|rate_limit|timeout|overload|temporar|unavailable)/i.test(code ?? "");
}

export function toResponsesCreateParams(
  request: ModelRequest,
  options: ResponseCreateProjectionOptions = {},
): ResponseCreateParamsStreaming {
  const providerState = options.disableProviderState
    ? undefined
    : request.providerState;
  const inputMessageOffset = providerState?.previousResponseId
    ? providerState.inputMessageOffset!
    : 0;
  if (inputMessageOffset > request.messages.length) {
    throw new Error(
      `Provider continuation offset ${inputMessageOffset} exceeds ${request.messages.length} messages.`,
    );
  }
  return {
    model: request.model,
    input: toResponseInput(request.messages.slice(inputMessageOffset)),
    tools: toResponseTools(request),
    max_output_tokens: request.maxOutputTokens,
    temperature: request.temperature,
    top_p: request.topP,
    reasoning: request.reasoningEffort
      ? { effort: request.reasoningEffort }
      : undefined,
    ...(providerState?.previousResponseId
      ? { previous_response_id: providerState.previousResponseId }
      : {}),
    store: Boolean(providerState),
    stream: true,
  } as ResponseCreateParamsStreaming;
}

function toResponseInput(messages: ModelMessage[]): ResponseInput {
  return messages.flatMap((message, index) => toResponseInputItems(message, index));
}

function toResponseInputItems(
  message: ModelMessage,
  messageIndex: number,
): ResponseInputItem[] {
  if (message.role === "tool") {
    return [{
      type: "function_call_output",
      call_id: message.toolCallId,
      output: message.content,
    }];
  }
  if (message.role === "assistant") {
    const items: ResponseInputItem[] = [];
    if (message.reasoningContent) {
      items.push({
        type: "reasoning",
        id: reasoningItemId(message, messageIndex),
        summary: [],
        content: [{ type: "reasoning_text", text: message.reasoningContent }],
      });
    }
    if (message.content) {
      items.push({ type: "message", role: "assistant", content: message.content });
    }
    items.push(...message.toolCalls.map((call) => ({
      type: "function_call" as const,
      call_id: call.id,
      name: call.name,
      arguments: call.argumentsText,
    })));
    return items;
  }
  const content = namedMessageContent(message.name, message.content);
  if (message.role === "user" && message.images?.length) {
    return [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: content },
        ...message.images.map((image) => ({
          type: "input_image" as const,
          image_url: image.url,
          detail: image.detail ?? "auto",
        })),
      ],
    }];
  }
  return [{
    type: "message",
    role: message.role,
    content,
  }];
}

function namedMessageContent(name: string | undefined, content: string): string {
  return name ? `[${name}]\n${content}` : content;
}

function reasoningItemId(message: Extract<ModelMessage, { role: "assistant" }>, index: number) {
  const identity = JSON.stringify([
    index,
    message.content,
    message.reasoningContent,
    message.toolCalls.map((call) => call.id),
  ]);
  return `rs_${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

function toResponseTools(request: ModelRequest): FunctionTool[] | undefined {
  if (!request.tools.length) return undefined;
  return request.tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
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
  ) return "image/png";
  if (
    content.length >= 4 &&
    content[0] === 0xff && content[1] === 0xd8 &&
    content.at(-2) === 0xff && content.at(-1) === 0xd9
  ) return "image/jpeg";
  if (
    content.length >= 14 &&
    ["GIF87a", "GIF89a"].includes(content.subarray(0, 6).toString("ascii")) &&
    content.at(-1) === 0x3b
  ) return "image/gif";
  if (
    content.length >= 12 &&
    content.subarray(0, 4).toString("ascii") === "RIFF" &&
    content.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "image/webp";
  if (
    content.length >= 26 &&
    content.subarray(0, 2).toString("ascii") === "BM" &&
    content.readUInt32LE(2) <= content.length
  ) return "image/bmp";
  throw new Error("Model image content is not a supported raster image.");
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

export class OpenAIResponsesProvider implements ModelProvider {
  readonly #client: OpenAI;
  #providerStateEnabled = true;

  constructor(config: OpenAIResponsesProviderConfig) {
    this.#client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      defaultHeaders: config.defaultHeaders,
      timeout: config.timeoutMs,
      maxRetries: 0,
    });
  }

  async *stream(
    request: ModelRequest,
    options: ModelStreamOptions = {},
  ): AsyncIterable<ModelEvent> {
    const state: ResponseNormalizationState = {
      requestId: request.requestId,
      sequence: 0,
      started: false,
    };
    try {
      const resolvedRequest = await resolveLocalImageInputs(request);
      const useProviderState = Boolean(
        resolvedRequest.providerState && this.#providerStateEnabled,
      );
      let stream;
      try {
        stream = await this.#client.responses.create(
          toResponsesCreateParams(resolvedRequest, {
            disableProviderState: !useProviderState,
          }),
          { signal: options.signal },
        );
      } catch (error) {
        if (!useProviderState || !providerStateCompatibilityError(error)) throw error;
        this.#providerStateEnabled = false;
        logProviderStateFallback(error);
        stream = await this.#client.responses.create(
          toResponsesCreateParams(resolvedRequest, { disableProviderState: true }),
          { signal: options.signal },
        );
      }
      for await (const providerEvent of stream) {
        if (
          useProviderState &&
          this.#providerStateEnabled &&
          providerEvent.type === "response.created" &&
          responseStore(providerEvent.response) !== true
        ) {
          this.#providerStateEnabled = false;
          logProviderStateUnavailable("response_not_stored");
        }
        for (const event of normalizeResponseStreamEvent(providerEvent, state)) {
          yield event;
        }
      }
      if (!state.terminal) {
        yield {
          protocol: BUSH_MODEL_EVENT_PROTOCOL,
          requestId: request.requestId,
          sequence: state.sequence++,
          createdAt: new Date().toISOString(),
          kind: "response_failed",
          code: "provider_stream_incomplete",
          message: "The Responses API stream ended without a terminal event.",
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

function providerStateCompatibilityError(error: unknown): boolean {
  if (!(error instanceof OpenAI.APIError)) return false;
  if (![400, 404, 422].includes(error.status ?? 0)) return false;
  const code = typeof error.code === "string" ? error.code : "";
  return /(?:previous[_ -]?response|response[_ -]?state|\bstore\b)/i.test(
    `${code} ${error.message}`,
  );
}

function logProviderStateFallback(error: unknown): void {
  const apiError = error instanceof OpenAI.APIError ? error : undefined;
  console.warn("[bush-provider-openai]", JSON.stringify({
    type: "provider_response_chain_disabled",
    status: apiError?.status ?? null,
    code: typeof apiError?.code === "string"
      ? apiError.code
      : apiError?.name ?? "provider_state_unsupported",
  }));
}

function logProviderStateUnavailable(reason: string): void {
  console.warn("[bush-provider-openai]", JSON.stringify({
    type: "provider_response_chain_disabled",
    status: null,
    code: reason,
  }));
}
