import OpenAI from "openai";
import { createHash } from "node:crypto";
import type {
  Response,
  ResponseCreateParamsStreaming,
  ResponseInputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import type { InputTokenCountParams } from "openai/resources/responses/input-tokens";

import {
  BUSH_MODEL_EVENT_PROTOCOL,
  type ModelEvent,
  type ModelMessage,
  type ModelRequest,
  type ProviderCompatibilityDiagnostic,
} from "@cardbush/bush-protocol";
import type {
  ModelInputTokenCount,
  ModelProvider,
  ModelStreamOptions,
} from "@cardbush/bush-runtime";
import { readLocalModelImage, isToolCallValidationFailure } from "@cardbush/bush-runtime";
import { providerFailureEvent } from "./providerFailure.js";
import { assertRequestBodyBudget, DEFAULT_REQUEST_BODY_MAX_BYTES, requestBodyBudget } from "./requestBodyBudget.js";
import { historicalCompatibilityMode, isClientToolSearchCall, portableResponsesReplay, replayResponsesOutput, responsesReplayData, type ResponsesToolSearchMode } from "./responsesReplay.js";
import { ResponseToolCalls, ResponseToolCallError } from "./responsesToolCalls.js";
import { ResponseText, ResponseTextError } from "./responsesText.js";
import { ResponseOutputIndex, ResponseOutputIdentityError } from "./responsesOutputIndex.js";
import { discoveryInputProjection, hasMcpDiscovery, historicalToolSearchMode, responseTools, TOOL_SEARCH_CAPABILITY } from "./responsesToolSearch.js";
import { compatibleToolImageProjection, RESPONSES_COMPATIBILITY_CAPABILITY } from "./responsesCompatibility.js";
import { responseToolAliases, responseToolName } from "./responsesToolNames.js";
import { uniqueToolDeclarations } from "./responsesToolDeclarations.js";
import { responsesInputFingerprint } from "./responsesInputFingerprint.js";
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
  /** Local JSON-body budget, independent of the model's context window. */
  maxRequestBodyBytes?: number;
}

export interface ResponseCreateProjectionOptions {
  disableProviderState?: boolean;
  toolSearchMode?: ResponsesToolSearchMode;
  compatibilityMode?: boolean;
}

interface ResponsesProjection {
  request: ModelRequest;
  params: ResponseCreateParamsStreaming;
  usesProviderState: boolean;
  toolSearchMode: ResponsesToolSearchMode;
  compatibilityMode: boolean;
}

const INPUT_TOKEN_COUNT_CAPABILITY = "input_token_count";

export interface ResponseNormalizationState {
  requestId: string;
  sequence: number;
  started: boolean;
  terminal?: boolean;
  toolSearchMode?: ResponsesToolSearchMode;
  compatibilityMode?: boolean;
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
          providerReplay: responsesReplayData(event.response, state.toolSearchMode, state.compatibilityMode) });
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
  const compatibilityMode = options.compatibilityMode ?? historicalCompatibilityMode(request);
  const providerState = options.disableProviderState || compatibilityMode
    ? undefined
    : request.providerState;
  const toolSearchMode = compatibilityMode ? "function" : options.toolSearchMode ?? historicalToolSearchMode(request) ?? "function";
  const inputMessageOffset = providerState?.previousResponseId
    ? providerState.inputMessageOffset!
    : 0;
  if (inputMessageOffset > request.messages.length) {
    throw new Error(
      `Provider continuation offset ${inputMessageOffset} exceeds ${request.messages.length} messages.`,
    );
  }
  const projectDiscovery = discoveryInputProjection(request);
  const projectImages = compatibilityMode ? compatibleToolImageProjection() : (items: ResponseInputItem[]) => items;
  const projected = uniqueToolDeclarations(request.messages.map((message, messageIndex) => ({
    messageIndex,
    items: projectImages(projectDiscovery(messageIndex, toResponseInputItems(message, messageIndex, request, toolSearchMode))),
  })), responseTools(request, toolSearchMode), inputMessageOffset);
  return {
    model: request.model,
    input: projected.input,
    tools: projected.tools,
    max_output_tokens: request.maxOutputTokens,
    temperature: request.temperature,
    top_p: request.topP,
    reasoning: request.reasoningEffort
      ? { effort: request.reasoningEffort }
      : undefined,
    ...(providerState?.previousResponseId && !projected.replayFromStart
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
      output: message.images?.length ? [
        { type: "input_text", text: message.content },
        ...message.images.map((image) => ({
          type: "input_image" as const,
          image_url: image.url,
          detail: image.detail ?? "auto",
        })),
      ] : message.content,
    }];
  }
  if (message.role === "assistant") {
    const replay = replayResponsesOutput(message, request);
    if (replay) return mode === "function" ? portableResponsesReplay(replay) : replay;
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
  readonly #maxRequestBodyBytes: number;
  readonly #diagnosticSecrets: string[];

  constructor(config: OpenAIResponsesProviderConfig) {
    this.#maxRequestBodyBytes = config.maxRequestBodyBytes ?? DEFAULT_REQUEST_BODY_MAX_BYTES;
    if (!Number.isSafeInteger(this.#maxRequestBodyBytes) || this.#maxRequestBodyBytes <= 0) {
      throw new Error("maxRequestBodyBytes must be a positive safe integer.");
    }
    this.#client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      defaultHeaders: config.defaultHeaders,
      timeout: config.timeoutMs,
      maxRetries: 0,
    });
    this.#capabilityStore = config.capabilityStore ?? new InMemoryProviderCapabilityStore();
    this.#capabilityScope = config.capabilityScope ?? openAIResponsesCapabilityScope(config);
    this.#diagnosticSecrets = [config.apiKey, ...Object.values(config.defaultHeaders ?? {})].filter(Boolean);
  }

  async estimateInputTokens(request: ModelRequest, options: ModelStreamOptions = {}): Promise<number> {
    options.signal?.throwIfAborted();
    const projection = await this.#project(request);
    options.signal?.throwIfAborted();
    const full = toResponsesCreateParams(projection.request, { disableProviderState: true,
      toolSearchMode: projection.toolSearchMode, compatibilityMode: projection.compatibilityMode });
    const fingerprint = responsesInputFingerprint(full, full, request.providerBinding);
    options.onInputProjection?.(fingerprint);
    options.onRequestBodyBudget?.(requestBodyBudget(projection.params, this.#maxRequestBodyBytes));
    return fingerprint.tokenEstimate!.tokens;
  }

  async countInputTokens(
    request: ModelRequest,
    options: ModelStreamOptions = {},
  ): Promise<ModelInputTokenCount | undefined> {
    options.signal?.throwIfAborted();
    if (this.#compatibilityMode(request) || this.#readCapability(request.model, INPUT_TOKEN_COUNT_CAPABILITY) === "unsupported") {
      return undefined;
    }
    const projection = await this.#project(request);
    const budget = requestBodyBudget(projection.params, this.#maxRequestBodyBytes);
    options.onRequestBodyBudget?.(budget);
    // Do not send an oversized body to the counting endpoint either. Runtime
    // can use the local estimate and the independent byte budget to compact.
    if (budget.bytes > budget.maxBytes) return undefined;
    if (projection.compatibilityMode) return undefined;
    try {
      const result = await this.#client.responses.inputTokens.count(
        toResponsesInputTokenCountParams(projection.params), { signal: options.signal });
      if (!Number.isSafeInteger(result.input_tokens) || result.input_tokens < 0) {
        throw new Error("The provider returned an invalid input token count.");
      }
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
      if (options.signal?.aborted || error instanceof OpenAI.APIUserAbortError) throw error;
      this.#enableCompatibility(request, "input_token_count");
      this.#compatibilityDiagnostic(request, options, "input_token_count", "local_estimate",
        providerFailureEvent(request.requestId, 0, error, false));
      return undefined;
    }
  }

  async *stream(
    request: ModelRequest,
    options: ModelStreamOptions = {},
  ): AsyncIterable<ModelEvent> {
    try {
      let projection = await this.#project(request);
      // One collective fallback, regardless of the provider's error vocabulary.
      // Buffer only response_started: a header/created event is not usable output.
      for (let attempt = 0; attempt < 2; attempt++) {
        options.signal?.throwIfAborted();
        const { params, request: resolvedRequest } = projection;
        const budget = requestBodyBudget(params, this.#maxRequestBodyBytes);
        options.onRequestBodyBudget?.(budget);
        assertRequestBodyBudget(budget);
        if (options.onInputProjection) {
          const full = toResponsesCreateParams(resolvedRequest, { disableProviderState: true,
            toolSearchMode: projection.toolSearchMode, compatibilityMode: projection.compatibilityMode });
          options.onInputProjection(responsesInputFingerprint(full, params, request.providerBinding));
        }
        const state: ResponseNormalizationState = {
          requestId: request.requestId, sequence: 0, started: false,
          ...(hasMcpDiscovery(resolvedRequest) ? { toolSearchMode: projection.toolSearchMode } : {}),
          compatibilityMode: projection.compatibilityMode,
          toolAliases: responseToolAliases(resolvedRequest),
        };
        let pendingStart: ModelEvent | undefined;
        let outputExposed = false;
        try {
          const stream = await this.#client.responses.create(params, { signal: options.signal });
          for await (const providerEvent of stream) {
            options.signal?.throwIfAborted();
            const response = responseFromEvent(providerEvent);
            if (projection.toolSearchMode === "native" &&
                (response?.tools?.some(tool => tool.type === "tool_search" && tool.execution === "client") ||
                 (providerEvent.type === "response.output_item.done" && isClientToolSearchCall(providerEvent.item)))) {
              this.#observeCapability(resolvedRequest.model, TOOL_SEARCH_CAPABILITY, "supported", "client_tool_search_observed");
            }
            if (projection.usesProviderState && providerEvent.type === "response.created") {
              const stored = responseStore(providerEvent.response) === true;
              this.#observeCapability(resolvedRequest.model, "response_continuation",
                stored ? "supported" : "unsupported", stored ? "response_stored" : "response_not_stored");
            }
            for (const event of normalizeResponseStreamEvent(providerEvent, state)) {
              options.signal?.throwIfAborted();
              if (event.kind === "response_started") { pendingStart = event; continue; }
              if (event.kind === "response_failed") throw new ResponseAttemptFailure(event);
              if (pendingStart) { yield pendingStart; pendingStart = undefined; }
              options.signal?.throwIfAborted();
              outputExposed = true;
              if (event.kind === "response_completed" && attempt > 0) {
                this.#compatibilityDiagnostic(request, options, "generation", "recovered");
              }
              yield event;
              // Ignore a late socket error after an authoritative completion.
              if (event.kind === "response_completed") return;
            }
          }
          throw new ResponseAttemptFailure({
            protocol: BUSH_MODEL_EVENT_PROTOCOL, requestId: request.requestId,
            sequence: state.sequence++, createdAt: new Date().toISOString(), kind: "response_failed",
            code: "provider_stream_incomplete", message: "The Responses API stream ended without a terminal event.", retryable: true,
          });
        } catch (error) {
          if (options.signal?.aborted || error instanceof OpenAI.APIUserAbortError) {
            yield providerFailureEvent(request.requestId, state.sequence++, error, true);
            return;
          }
          const failure = error instanceof ResponseAttemptFailure ? error.failure
            : providerFailureEvent(request.requestId, state.sequence++, error, false);
          if (isToolCallValidationFailure(failure)) {
            // Runtime repairs the call by appending guidance. An invalid call
            // is not evidence to switch schemas and invalidate the cache prefix.
            this.#compatibilityDiagnostic(request, options, "generation", "failed", failure);
            yield failure;
            return;
          }
          const retry = !projection.compatibilityMode && attempt === 0 && !outputExposed;
          this.#enableCompatibility(request, "generation");
          this.#compatibilityDiagnostic(request, options, "generation",
            retry ? "retry" : projection.compatibilityMode ? "failed" : "next_request", failure);
          if (!retry) { yield failure; return; }
          projection = await this.#project(request, true);
        }
      }
    } catch (error) {
      // Local projection/size errors and cancellation are not provider capability evidence.
      yield providerFailureEvent(request.requestId, 0, error, options.signal?.aborted === true);
    }
  }

  #compatibilityMode(request: ModelRequest): boolean {
    return historicalCompatibilityMode(request) ||
      this.#readCapability(request.model, RESPONSES_COMPATIBILITY_CAPABILITY) === "supported";
  }

  #enableCompatibility(request: ModelRequest, source: ProviderCompatibilityDiagnostic["source"]): void {
    if (this.#readCapability(request.model, RESPONSES_COMPATIBILITY_CAPABILITY) !== "supported") {
      this.#observeCapability(request.model, RESPONSES_COMPATIBILITY_CAPABILITY, "supported", `${source}_failed`);
    }
  }

  #compatibilityDiagnostic(request: ModelRequest, options: ModelStreamOptions,
    source: ProviderCompatibilityDiagnostic["source"], action: ProviderCompatibilityDiagnostic["action"],
    failure?: Extract<ModelEvent, { kind: "response_failed" }>): void {
    const diagnostic: ProviderCompatibilityDiagnostic = { model: request.model, source, action,
      ...(failure ? { error: { code: failure.code,
        message: this.#diagnosticSecrets.reduce((text, secret) => text.split(secret).join("[redacted]"), failure.message),
        status: failure.status, providerRequestId: failure.providerRequestId, diagnostics: failure.diagnostics } } : {}) };
    options.onCompatibilityDiagnostic?.(diagnostic);
    console.warn("[bush-provider-openai]", JSON.stringify({ type: "provider_compatibility",
      sessionId: request.sessionId, turnId: request.turnId, requestId: request.requestId, ...diagnostic }));
  }

  async #project(request: ModelRequest, forceCompatibility = false): Promise<ResponsesProjection> {
    const resolvedRequest = await resolveLocalImageInputs(request);
    const compatibilityMode = forceCompatibility || this.#compatibilityMode(resolvedRequest);
    const continuation = this.#readCapability(
      resolvedRequest.model,
      "response_continuation",
    );
    const hasPreviousResponse = Boolean(
      resolvedRequest.providerState?.previousResponseId,
    );
    const usesProviderState = Boolean(
      !compatibilityMode && resolvedRequest.providerState &&
      (!hasPreviousResponse || continuation === "supported"),
    );
    const toolSearchMode = compatibilityMode ? "function" : (hasMcpDiscovery(resolvedRequest)
      ? historicalToolSearchMode(resolvedRequest) ??
        (this.#readCapability(resolvedRequest.model, TOOL_SEARCH_CAPABILITY) === "unsupported" ? "function" : "native")
      : "function");
    return {
      request: resolvedRequest,
      params: toResponsesCreateParams(resolvedRequest, {
        disableProviderState: !usesProviderState,
        toolSearchMode,
        compatibilityMode,
      }),
      usesProviderState,
      toolSearchMode,
      compatibilityMode,
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

class ResponseAttemptFailure extends Error {
  constructor(readonly failure: Extract<ModelEvent, { kind: "response_failed" }>) {
    super(failure.message);
  }
}
