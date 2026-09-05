import OpenAI from "openai";
import { createHash } from "node:crypto";
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseInputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import type { InputTokenCountParams } from "openai/resources/responses/input-tokens";

import {
  BUSH_MODEL_EVENT_PROTOCOL,
  type ModelEvent,
  type ModelMessage,
  type ModelRequest,
} from "@cardbush/bush-protocol";
import type {
  ModelInputTokenCount,
  ModelProvider,
  ModelStreamOptions,
} from "@cardbush/bush-runtime";
import { readLocalModelImage } from "@cardbush/bush-runtime";
import { providerFailureEvent } from "./providerFailure.js";
import {
  InMemoryProviderCapabilityStore,
  openAIResponsesCapabilityScope,
  type ProviderCapabilityStatus,
  type ProviderCapabilityStore,
} from "./providerCapabilities.js";

export interface OpenAIResponsesProviderConfig {
  apiKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
  capabilityStore?: ProviderCapabilityStore;
  capabilityScope?: string;
}

export interface ResponseCreateProjectionOptions {
  disableProviderState?: boolean;
}

interface ResponsesProjection {
  request: ModelRequest;
  params: ResponseCreateParamsStreaming;
  usesProviderState: boolean;
}

const INPUT_TOKEN_COUNT_CAPABILITY = "input_token_count";
const UNSUPPORTED_INPUT_TOKEN_COUNT_STATUSES = new Set([404, 405, 501]);

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
        retryable: false,
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
    retryable: false,
    providerRequestId: response.id,
  };
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

export function toResponsesInputTokenCountParams(
  params: ResponseCreateParamsStreaming,
): InputTokenCountParams {
  return {
    model: params.model,
    input: params.input,
    tools: params.tools,
    reasoning: params.reasoning,
    ...(params.previous_response_id
      ? { previous_response_id: params.previous_response_id }
      : {}),
  };
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
  const { content, mime } = await readLocalModelImage(value);
  return `data:${mime};base64,${content.toString("base64")}`;
}

export class OpenAIResponsesProvider implements ModelProvider {
  readonly #client: OpenAI;
  readonly #capabilityStore: ProviderCapabilityStore;
  readonly #capabilityScope: string;

  constructor(config: OpenAIResponsesProviderConfig) {
    this.#client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      defaultHeaders: config.defaultHeaders,
      timeout: config.timeoutMs,
      maxRetries: 0,
    });
    this.#capabilityStore = config.capabilityStore ?? new InMemoryProviderCapabilityStore();
    this.#capabilityScope = config.capabilityScope ?? openAIResponsesCapabilityScope(config);
  }

  async countInputTokens(
    request: ModelRequest,
    options: ModelStreamOptions = {},
  ): Promise<ModelInputTokenCount | undefined> {
    if (this.#readCapability(request.model, INPUT_TOKEN_COUNT_CAPABILITY) === "unsupported") {
      return undefined;
    }
    try {
      const projection = await this.#project(request);
      const result = await this.#client.responses.inputTokens.count(
        toResponsesInputTokenCountParams(projection.params),
        { signal: options.signal },
      );
      this.#observeCapability(
        request.model,
        INPUT_TOKEN_COUNT_CAPABILITY,
        "supported",
        "provider_count_succeeded",
      );
      return {
        inputTokens: result.input_tokens,
        source: "provider",
      };
    } catch (error) {
      const status = providerHttpStatus(error);
      if (status !== undefined && UNSUPPORTED_INPUT_TOKEN_COUNT_STATUSES.has(status)) {
        this.#observeCapability(
          request.model,
          INPUT_TOKEN_COUNT_CAPABILITY,
          "unsupported",
          `http_${status}`,
        );
        return undefined;
      }
      throw error;
    }
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
      const projection = await this.#project(request);
      const resolvedRequest = projection.request;
      const activeProviderState = projection.usesProviderState;
      const stream = await this.#client.responses.create(
        projection.params,
        { signal: options.signal },
      );
      for await (const providerEvent of stream) {
        if (
          activeProviderState &&
          providerEvent.type === "response.created" &&
          responseStore(providerEvent.response) !== true
        ) {
          this.#observeCapability(
            resolvedRequest.model,
            "response_continuation",
            "unsupported",
            "response_not_stored",
          );
        } else if (
          activeProviderState &&
          providerEvent.type === "response.created" &&
          responseStore(providerEvent.response) === true
        ) {
          this.#observeCapability(
            resolvedRequest.model,
            "response_continuation",
            "supported",
            "response_stored",
          );
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

  async #project(request: ModelRequest): Promise<ResponsesProjection> {
    const resolvedRequest = await resolveLocalImageInputs(request);
    const continuation = this.#readCapability(
      resolvedRequest.model,
      "response_continuation",
    );
    const hasPreviousResponse = Boolean(
      resolvedRequest.providerState?.previousResponseId,
    );
    const usesProviderState = Boolean(
      resolvedRequest.providerState &&
      (!hasPreviousResponse || continuation === "supported"),
    );
    return {
      request: resolvedRequest,
      params: toResponsesCreateParams(resolvedRequest, {
        disableProviderState: !usesProviderState,
      }),
      usesProviderState,
    };
  }

  #readCapability(model: string, capability: string): ProviderCapabilityStatus {
    return this.#capabilityStore.read({
      scope: this.#capabilityScope,
      model,
      capability,
    }).status;
  }

  #observeCapability(
    model: string,
    capability: string,
    status: "supported" | "unsupported",
    reason: string,
  ): void {
    const identity = { scope: this.#capabilityScope, model, capability };
    const previous = this.#capabilityStore.read(identity);
    if (previous.status === status && previous.reason === reason) return;
    this.#capabilityStore.observe(identity, { status, reason });
    console.warn("[bush-provider-openai]", JSON.stringify({
      type: "provider_capability_observed",
      capability,
      status,
      reason,
    }));
  }
}

function providerHttpStatus(error: unknown): number | undefined {
  if (error instanceof OpenAI.APIError && Number.isInteger(error.status)) {
    return error.status;
  }
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return Number.isInteger(status) ? Number(status) : undefined;
}
