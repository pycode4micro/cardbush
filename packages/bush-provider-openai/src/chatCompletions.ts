import OpenAI from 'openai';
import type { ChatCompletionCreateParamsStreaming, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { modelApiBaseURL, modelApiGateway, modelRequestHeaders, protocolReasoningEffort, type ModelEvent, type ModelRequest } from '@cardbush/bush-protocol';
import { modelReplayMatches, withToolDisplayTitle, type ModelProvider, type ModelStreamOptions } from '@cardbush/bush-runtime';
import type { ModelProviderConfig } from './providerConfig.js';
import { resolveLocalImageInputs, namedMessageContent, portableMessages } from './modelInputs.js';
import { providerToolName } from './toolNames.js';
import { providerFailureEvent } from './providerFailure.js';
import { eventWriter, incompleteStream, recordProjection, toolCallEvents, type PortableCall } from './portableProvider.js';
import { OpenRouterReasoning } from './openRouterReasoning.js';
import { sessionPromptCacheKey } from './promptCache.js';

const FORMAT = 'openai.chat_completions.v1';
const OPENROUTER_FORMAT = 'openrouter.chat_completions.v1';
type ChatParams = ChatCompletionCreateParamsStreaming & { reasoning?: { effort: 'low' | 'medium' | 'high' } };
export function toChatCompletionsParams(request: ModelRequest, baseURL?: string): ChatParams {
  const openRouter = modelApiGateway(baseURL) === 'openrouter';
  const messages: ChatCompletionMessageParam[] = [];
  // Tool messages cannot carry image parts. Append images only after the entire
  // tool-result batch so assistant/tool adjacency stays valid on strict gateways.
  const toolImages: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  const flush = () => { if (toolImages.length) messages.push({ role: 'user', content: toolImages.splice(0) }); };
  for (const message of portableMessages(request)) {
    if (message.role !== 'tool') flush();
    if (message.role === 'assistant') {
      const replay = message.providerReplay;
      const reasoning = replay?.format === FORMAT && !openRouter && modelReplayMatches(message, request) &&
        typeof replay.data.reasoning_content === 'string' && replay.data.reasoning_content === message.reasoningContent ? replay.data.reasoning_content : undefined;
      const routerReplay = openRouter && replay?.format === OPENROUTER_FORMAT && modelReplayMatches(message, request) ? replay.data : undefined;
      const details = Array.isArray(routerReplay?.reasoning_details) ? routerReplay.reasoning_details : undefined;
      messages.push({ role: 'assistant', content: message.content || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(details?.length ? { reasoning_details: details } : typeof routerReplay?.reasoning === 'string' ? { reasoning: routerReplay.reasoning } : {}),
        ...(message.toolCalls.length ? { tool_calls: message.toolCalls.map(call => ({ type: 'function' as const, id: call.id,
          function: { name: providerToolName(call.name), arguments: call.argumentsText } })) } : {}) });
    } else if (message.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content });
      if (message.images?.length) toolImages.push({ type: 'text', text: `Images from tool result ${message.toolCallId}:` },
        ...message.images.map(image => ({ type: 'image_url' as const, image_url: { url: image.url, detail: image.detail ?? 'auto' as const } })));
    } else {
      const content = namedMessageContent(message.name, message.content);
      messages.push(message.role === 'user' && message.images?.length
        ? { role: 'user', content: [{ type: 'text', text: content }, ...message.images.map(image => ({ type: 'image_url' as const, image_url: { url: image.url, detail: image.detail ?? 'auto' as const } }))] }
        : { role: message.role === 'developer' ? 'system' : message.role, content });
    }
  }
  flush();
  const cacheKey = sessionPromptCacheKey(request, baseURL);
  return { model: request.model, messages, stream: true, stream_options: { include_usage: true },
    ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
    ...(request.tools.length ? { tools: request.tools.map(tool => ({ type: 'function' as const,
      function: { name: providerToolName(tool.name), description: tool.description, parameters: withToolDisplayTitle(tool).inputSchema, strict: false } })) } : {}),
    max_completion_tokens: request.maxOutputTokens, temperature: request.temperature, top_p: request.topP,
    ...(request.reasoningEffort ? openRouter
      ? { reasoning: { effort: protocolReasoningEffort('openai_chat_completions', request.reasoningEffort) } }
      : { reasoning_effort: protocolReasoningEffort('openai_chat_completions', request.reasoningEffort) } : {}) };
}

export class OpenAIChatCompletionsProvider implements ModelProvider {
  readonly #client: OpenAI;
  readonly #openRouter: boolean;
  readonly #format: string;
  constructor(readonly config: ModelProviderConfig) {
    this.#openRouter = modelApiGateway(config.baseURL) === 'openrouter';
    this.#format = this.#openRouter ? OPENROUTER_FORMAT : FORMAT;
    this.#client = new OpenAI({ apiKey: config.apiKey, baseURL: modelApiBaseURL('openai_chat_completions', config.baseURL),
      timeout: config.timeoutMs, fetch: config.fetch, maxRetries: 0 });
  }
  async estimateInputTokens(request: ModelRequest, options: ModelStreamOptions = {}): Promise<number> {
    options.signal?.throwIfAborted();
    const params = toChatCompletionsParams(await resolveLocalImageInputs(request), this.config.baseURL);
    options.signal?.throwIfAborted();
    return recordProjection(this.#format, request, { ...params }, options, this.config.maxRequestBodyBytes);
  }
  async *stream(request: ModelRequest, options: ModelStreamOptions = {}): AsyncIterable<ModelEvent> {
    const emit = eventWriter(request.requestId);
    let finished: string | undefined, reasoning = '';
    const routerReasoning = new OpenRouterReasoning();
    const calls = new Map<number, PortableCall>();
    try {
      const params = toChatCompletionsParams(await resolveLocalImageInputs(request), this.config.baseURL);
      options.signal?.throwIfAborted();
      recordProjection(this.#format, request, { ...params }, options, this.config.maxRequestBodyBytes, true);
      const stream = await this.#client.chat.completions.create(params, { signal: options.signal,
        headers: modelRequestHeaders(this.config.baseURL, this.config.defaultHeaders, request.sessionId) });
      yield emit({ kind: 'response_started' });
      for await (const chunk of stream) {
        options.signal?.throwIfAborted();
        if (chunk.usage) yield emit({ kind: 'usage', inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens, cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens });
        const choice = chunk.choices.find(item => item.index === 0);
        if (!choice) continue;
        if (finished) throw new Error('The provider sent content after completion.');
        if (choice.delta.content) yield emit({ kind: 'text_delta', delta: choice.delta.content });
        if (choice.delta.refusal) yield emit({ kind: 'text_delta', delta: choice.delta.refusal });
        const thought = this.#openRouter ? routerReasoning.append(choice.delta as Parameters<OpenRouterReasoning['append']>[0])
          : (choice.delta as { reasoning_content?: string }).reasoning_content;
        if (typeof thought === 'string' && thought) { reasoning += thought; yield emit({ kind: 'reasoning_delta', delta: thought }); }
        for (const delta of choice.delta.tool_calls ?? []) {
          const call = calls.get(delta.index) ?? { id: '', name: '', arguments: '' };
          call.id += delta.id ?? ''; call.name += delta.function?.name ?? ''; call.arguments += delta.function?.arguments ?? '';
          calls.set(delta.index, call);
        }
        if (choice.finish_reason) finished = choice.finish_reason;
      }
      options.signal?.throwIfAborted();
      if (!finished) { yield emit(incompleteStream()); return; }
      if (finished === 'error') throw new Error('The provider reported a stream error.');
      const truncated = finished === 'length';
      if (!truncated && calls.size && finished !== 'tool_calls') throw new Error('Tool calls were not confirmed by the provider.');
      if (finished === 'tool_calls' && !calls.size) throw new Error('The provider finished with missing tool calls.');
      // A length stop has no per-tool completion markers. Never execute its partial batch.
      if (!truncated) for (const event of toolCallEvents(calls, request)) yield emit(event);
      const replay = this.#openRouter ? routerReasoning.details.length ? { reasoning_details: routerReasoning.details }
        : reasoning ? { reasoning } : undefined : reasoning ? { reasoning_content: reasoning } : undefined;
      yield emit({ kind: 'response_completed', finishReason: finished,
        ...(truncated ? { completedToolCallIndices: [] } : replay ? { providerReplay: { format: this.#format, data: replay } } : {}) });
    } catch (error) {
      const failure = providerFailureEvent(request.requestId, 0, error, options.signal?.aborted ?? false);
      const { protocol: _p, requestId: _r, sequence: _s, createdAt: _t, ...payload } = failure;
      yield emit(payload);
    }
  }
}
