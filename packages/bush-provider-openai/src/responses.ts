import OpenAI from "openai";
import { createHash } from "node:crypto";
import type {
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
import { isClientToolSearchCall, replayResponsesOutput, responsesReplayData, type ResponsesToolSearchMode } from "./responsesReplay.js";
import { ResponseToolCalls, ResponseToolCallError } from "./responsesToolCalls.js";
import { ResponseText, ResponseTextError } from "./responsesText.js";
import { ResponseOutputIndex, ResponseOutputIdentityError } from "./responsesOutputIndex.js";
import { discoveryInputProjection, hasMcpDiscovery, historicalToolSearchMode, isToolSearchUnsupported, responseTools, TOOL_SEARCH_CAPABILITY } from "./responsesToolSearch.js";
import { responseToolAliases, responseToolName } from "./responsesToolNames.js";
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
  toolSearchMode?: ResponsesToolSearchMode;
}

interface ResponsesProjection {
  request: ModelRequest;
  params: ResponseCreateParamsStreaming;
  usesProviderState: boolean;
  toolSearchMode: ResponsesToolSearchMode;
}

const INPUT_TOKEN_COUNT_CAPABILITY = "input_token_count";
const TOOL_SEARCH_TOKEN_COUNT_CAPABILITY = "input_token_count.client_tool_search";
const UNSUPPORTED_INPUT_TOKEN_COUNT_STATUSES = new Set([404, 405, 501]);

export interface ResponseNormalizationState {
  requestId: string;
  sequence: number;
  started: boolean;
  terminal?: boolean;
  toolSearchMode?: ResponsesToolSearchMode;
  toolAliases?: Map<string, string>;
  toolCalls?: ResponseToolCalls;
  text?: ResponseText;
  outputIndex?: ResponseOutputIndex;
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
    events.push({ protocol: BUSH_MODEL_EVENT_PROTOCOL, requestId: state.requestId,
      sequence: state.sequence++, createdAt, ...payload } as ModelEvent);
  };
  const response = responseFromEvent(event);
  if (!state.started) {
    state.started = true;
    append({ kind: "response_started", providerResponseId: response ? responseContinuationId(response) : undefined });
  }
  const outputIndex = state.outputIndex ??= new ResponseOutputIndex();
  const toolCalls = state.toolCalls ??= new ResponseToolCalls(outputIndex);
  const text = state.text ??= new ResponseText(outputIndex);
  try {
    switch (event.type) {
      case "response.output_text.delta":
      case "response.output_text.done":
      case "response.refusal.delta":
      case "response.refusal.done":
      case "response.reasoning_text.delta":
      case "response.reasoning_text.done":
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_summary_text.done":
        text.event(event, append);
        break;
      case "response.output_item.added":
      case "response.output_item.done":
        toolCalls.item({ ...event.item }, event.output_index, event.type === "response.output_item.done", state.toolSearchMode, state.toolAliases, append);
        text.item(event.item, event.output_index, event.type === "response.output_item.done", append);
        break;
      case "response.function_call_arguments.delta":
      case "response.function_call_arguments.done":
        toolCalls.arguments(event, state.toolAliases, append);
        break;
      case "response.completed":
      case "response.incomplete": {
        if (event.type === "response.completed") {
          const indices = toolCalls.snapshotIndices(event.response.output.map(item => ({ ...item })));
          for (const [position, item] of event.response.output.entries()) {
            toolCalls.item({ ...item }, indices[position]!, true, state.toolSearchMode, state.toolAliases, append);
            text.item(item, position, true, append, true);
          }
          toolCalls.finish();
        } else {
          // Runtime owns output-limit continuation and discards this entire call
          // batch. Preserve its prose without promoting truncated calls to ready.
          for (const [position, item] of event.response.output.entries()) text.item(item, position, true, append, true);
        }
        appendResponseUsage(event.response, append);
        append({ kind: "response_completed",
          finishReason: event.type === "response.incomplete" ? incompleteFinishReason(event.response)
            : toolCalls.hasCalls ? "tool_calls" : responseFinishReason(event.response),
          providerReplay: responsesReplayData(event.response, state.toolSearchMode) });
        state.terminal = true;
        break;
      }
      case "response.failed":
        append(responseFailurePayload(event.response));
        state.terminal = true;
        break;
      case "error":
        append({ kind: "response_failed", code: event.code || "provider_response_error", message: event.message, retryable: false });
        state.terminal = true;
        break;
    }
  } catch (error) {
    if (!(error instanceof ResponseToolCallError) && !(error instanceof ResponseTextError) && !(error instanceof ResponseOutputIdentityError)) throw error;
    append({ kind: "response_failed", code: error.code, message: error.message, retryable: false });
    state.terminal = true;
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
  return response.output.some((item) => item.type === "function_call" || isClientToolSearchCall(item))
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
  const toolSearchMode = options.toolSearchMode ?? historicalToolSearchMode(request) ?? "function";
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
    input: toResponseInput(request, inputMessageOffset, toolSearchMode),
    tools: responseTools(request, toolSearchMode),
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

function toResponseInput(request: ModelRequest, offset: number, mode: ResponsesToolSearchMode): ResponseInput {
  const projectDiscovery = discoveryInputProjection(request);
  return request.messages.flatMap((message, index) => {
    const items = projectDiscovery(index, toResponseInputItems(message, index, request, mode));
    return index < offset ? [] : items;
  });
}

function toResponseInputItems(
  message: ModelMessage,
  messageIndex: number,
  request: ModelRequest,
  mode: ResponsesToolSearchMode,
): ResponseInputItem[] {
  if (message.role === "tool") {
    return [{
      type: "function_call_output",
      call_id: message.toolCallId,
      output: message.content,
    }];
  }
  if (message.role === "assistant") {
    const replay = replayResponsesOutput(message, request);
    if (replay) return replay;
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
    items.push(...message.toolCalls.map((call): ResponseInputItem => mode === "native" && call.name === "mcp_search" ? {
      type: "tool_search_call", call_id: call.id, execution: "client", status: "completed",
      arguments: JSON.parse(call.argumentsText),
    } : ({
      type: "function_call" as const,
      call_id: call.id,
      name: responseToolName(call.name),
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
    const projection = await this.#project(request);
    if (projection.toolSearchMode === "native" &&
      this.#readCapability(request.model, TOOL_SEARCH_TOKEN_COUNT_CAPABILITY) === "unsupported") return undefined;
    try {
      const result = await this.#client.responses.inputTokens.count(
        toResponsesInputTokenCountParams(projection.params), { signal: options.signal });
      this.#observeCapability(
        request.model,
        INPUT_TOKEN_COUNT_CAPABILITY,
        "supported",
        "provider_count_succeeded",
      );
      if (projection.toolSearchMode === "native") this.#observeCapability(request.model,
        TOOL_SEARCH_TOKEN_COUNT_CAPABILITY, "supported", "native_tool_search_count_succeeded");
      return {
        inputTokens: result.input_tokens,
        source: "provider",
      };
    } catch (error) {
      if (projection.toolSearchMode === "native" && isToolSearchUnsupported(error)) {
        this.#observeCapability(request.model, TOOL_SEARCH_TOKEN_COUNT_CAPABILITY, "unsupported", "native_tool_search_count_rejected");
        return undefined;
      }
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
      const initialProjection = await this.#project(request);
      // Only an explicit pre-stream protocol rejection can retry with portable tools.
      // Once any response is accepted, never replay it under another protocol.
      const { result: stream, projection } = await this.#withToolSearchFallback(request, initialProjection,
        params => this.#client.responses.create(params, { signal: options.signal }));
      const resolvedRequest = projection.request;
      const activeProviderState = projection.usesProviderState;
      if (hasMcpDiscovery(resolvedRequest)) state.toolSearchMode = projection.toolSearchMode;
      state.toolAliases = responseToolAliases(resolvedRequest);
      for await (const providerEvent of stream) {
        if (projection.toolSearchMode === "native") {
          const response = responseFromEvent(providerEvent);
          if (response?.tools?.some(tool => tool.type === "tool_search" && tool.execution === "client") ||
            (providerEvent.type === "response.output_item.done" && isClientToolSearchCall(providerEvent.item))) {
            this.#observeCapability(resolvedRequest.model, TOOL_SEARCH_CAPABILITY, "supported", "client_tool_search_observed");
          }
        }
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
          if (options.signal?.aborted) {
            yield providerFailureEvent(request.requestId, state.sequence++, undefined, true);
            return;
          }
          yield event;
          // Completion is authoritative. Closing the iterator here also avoids
          // a late socket failure turning an already completed response into failure.
          if (event.kind === "response_completed" || event.kind === "response_failed") return;
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

  async #withToolSearchFallback<T>(request: ModelRequest, projection: ResponsesProjection,
    operation: (params: ResponseCreateParamsStreaming) => Promise<T>): Promise<{ result: T; projection: ResponsesProjection }> {
    try {
      return { result: await operation(projection.params), projection };
    } catch (error) {
      if (projection.toolSearchMode !== "native" || !isToolSearchUnsupported(error)) throw error;
      this.#observeCapability(request.model, TOOL_SEARCH_CAPABILITY, "unsupported", "client_tool_search_rejected");
      if (historicalToolSearchMode(request) !== undefined || request.providerState?.previousResponseId) throw error;
      const fallback = await this.#project(request, "function");
      return { result: await operation(fallback.params), projection: fallback };
    }
  }

  async #project(request: ModelRequest, mode?: ResponsesToolSearchMode): Promise<ResponsesProjection> {
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
    const toolSearchMode = mode ?? (hasMcpDiscovery(resolvedRequest)
      ? historicalToolSearchMode(resolvedRequest) ??
        (this.#readCapability(resolvedRequest.model, TOOL_SEARCH_CAPABILITY) === "unsupported" ? "function" : "native")
      : "function");
    return {
      request: resolvedRequest,
      params: toResponsesCreateParams(resolvedRequest, {
        disableProviderState: !usesProviderState,
        toolSearchMode,
      }),
      usesProviderState,
      toolSearchMode,
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
