import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlockParam, MessageCreateParamsStreaming, MessageParam, RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages';
import { modelApiBaseURL, modelApiGateway, modelRequestHeaders, type ModelEvent, type ModelMessage, type ModelRequest } from '@cardbush/bush-protocol';
import { modelReplayMatches, withToolDisplayTitle, ModelRequestAttempts, type ModelProvider, type ModelStreamOptions } from '@cardbush/bush-runtime';
import type { ModelProviderConfig } from './providerConfig.js';
import { resolveLocalImageInputs, namedMessageContent, portableMessages } from './modelInputs.js';
import { providerToolName } from './toolNames.js';
import { anthropicValidationMessage, providerFailureEvent } from './providerFailure.js';
import { InMemoryProviderCapabilityStore, modelProviderCapabilityScope, type ProviderCapabilityStore } from './providerCapabilities.js';
import { eventWriter, incompleteStream, recordProjection, toolCallEvents, type PortableCall } from './portableProvider.js';
import { AnthropicStreamDiagnostics } from './anthropicStreamDiagnostics.js';

const FORMAT = 'anthropic.messages.v1';
const PROMPT_CACHING_CAPABILITY = 'anthropic_automatic_prompt_caching';
function imageBlock(url: string): ContentBlockParam {
  const data = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/s.exec(url);
  if (data) return { type: 'image', source: { type: 'base64', media_type: data[1] as 'image/png', data: data[2] } };
  if (/^https?:\/\//i.test(url)) return { type: 'image', source: { type: 'url', url } };
  throw new Error('Anthropic Messages supports JPEG, PNG, GIF and WebP images.');
}
function textBlocks(text: string): ContentBlockParam[] { return text ? [{ type: 'text', text }] : []; }

function objectArguments(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function replayContent(message: Extract<ModelMessage, { role: 'assistant' }>, request: ModelRequest): ContentBlockParam[] | undefined {
  const replay = message.providerReplay;
  if (replay?.format !== FORMAT || !modelReplayMatches(message, request) || !Array.isArray(replay.data.content)) return;
  const blocks = replay.data.content as Record<string, unknown>[];
  if (!blocks.every(block => block && (
    block.type === 'text' && typeof block.text === 'string' ||
    block.type === 'thinking' && typeof block.thinking === 'string' && typeof block.signature === 'string' && block.signature.length > 0 ||
    block.type === 'redacted_thinking' && typeof block.data === 'string' ||
    block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && block.input && typeof block.input === 'object'
  ))) return;
  if (blocks.filter(b => b.type === 'text').map(b => b.text).join('') !== message.content ||
    blocks.filter(b => b.type === 'thinking').map(b => b.thinking).join('') !== (message.reasoningContent ?? '')) return;
  const calls = blocks.filter(b => b.type === 'tool_use');
  if (calls.length !== message.toolCalls.length || calls.some((call, index) => {
    const expected = message.toolCalls[index];
    return call.id !== expected.id || call.name !== providerToolName(expected.name) || JSON.stringify(call.input) !== JSON.stringify(objectArguments(expected.argumentsText));
  })) return;
  return structuredClone(blocks) as unknown as ContentBlockParam[];
}

export function toAnthropicMessagesParams(request: ModelRequest, thinkingMode: 'adaptive' | 'budget' = 'adaptive', cache = true): MessageCreateParamsStreaming {
  const messages: MessageParam[] = [], system: string[] = [];
  const textCallIds = new Set<string>();
  let inPrefix = true;
  const append = (role: 'user' | 'assistant', content: ContentBlockParam[]) => {
    if (!content.length) return;
    const previous = messages.at(-1);
    if (previous?.role === role && Array.isArray(previous.content)) {
      previous.content.push(...content);
      // Messages requires tool results before other user content, including
      // textual projections of rejected calls in the same batch.
      if (role === 'user') previous.content.sort((a, b) => Number(b.type === 'tool_result') - Number(a.type === 'tool_result'));
    }
    else messages.push({ role, content });
  };
  for (const message of portableMessages(request)) {
    if (message.role === 'system' || message.role === 'developer') {
      const content = namedMessageContent(message.name, message.content);
      if (inPrefix) system.push(content);
      // Messages has no portable mid-conversation developer role. Keep runtime
      // notices at their original boundary instead of rewriting the system
      // prefix or leaving an assistant prefill after a failed tool call.
      else append('user', textBlocks(`Runtime ${message.role} instruction:\n${content}`));
      continue;
    }
    inPrefix = false;
    if (message.role === 'assistant') {
      const replay = replayContent(message, request);
      if (replay) {
        append('assistant', replay);
      } else append('assistant', [...textBlocks(message.content), ...message.toolCalls.flatMap(call => {
        const input = objectArguments(call.argumentsText);
        if (input) return [{ type: 'tool_use', id: call.id, name: providerToolName(call.name), input } as ContentBlockParam];
        // Messages cannot encode malformed JSON as tool_use.input. Preserve the
        // factual attempted call and its Runtime receipt as text, not invented
        // arguments. Durable history and the shared error/continuation policy stay intact.
        textCallIds.add(call.id);
        return textBlocks(`Tool call ${call.id} (${call.name}) could not be encoded as a Messages input object. Original arguments:\n${call.argumentsText}`);
      })]);
    } else if (message.role === 'tool') {
      const content = [...textBlocks(message.content), ...(message.images ?? []).map(image => imageBlock(image.url))];
      append('user', textCallIds.has(message.toolCallId)
        ? [...textBlocks(`Runtime result for tool call ${message.toolCallId}:`), ...content]
        : [{ type: 'tool_result', tool_use_id: message.toolCallId, content: content as Anthropic.Messages.ToolResultBlockParam['content'] }]);
    } else if (message.role === 'user') append('user', [...textBlocks(namedMessageContent(message.name, message.content)),
      ...(message.images ?? []).map(image => imageBlock(image.url))]);
  }
  const maxTokens = request.maxOutputTokens ?? 8192;
  const effort = request.reasoningEffort;
  const thinking = effort && effort !== 'none';
  if (thinking && thinkingMode === 'budget' && maxTokens <= 1024) throw new Error('Anthropic budget thinking requires an output limit greater than 1024 tokens.');
  const budget = thinking && thinkingMode === 'budget' ? Math.min(maxTokens - 1, { low: 1024, medium: 2048, high: 4096, xhigh: 8192, max: 16384 }[effort]) : undefined;
  return { model: request.model, messages, system: system.join('\n\n') || undefined, max_tokens: maxTokens, stream: true,
    ...(cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
    ...(request.tools.length ? { tools: request.tools.map(tool => ({ name: providerToolName(tool.name), description: tool.description,
      input_schema: { ...withToolDisplayTitle(tool).inputSchema, type: 'object' as const } })) } : {}),
    ...(thinking ? budget ? { thinking: { type: 'enabled' as const, budget_tokens: budget } }
      : { thinking: { type: 'adaptive' as const }, output_config: { effort } }
      : { ...(effort === 'none' ? { thinking: { type: 'disabled' as const } } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : { top_p: request.topP }) }) };
}

type Block = { value: Record<string, unknown>; json: string; stopped: boolean };
export class AnthropicMessagesProvider implements ModelProvider {
  readonly #client: Anthropic;
  readonly #baseURL: string;
  readonly #capabilityStore: ProviderCapabilityStore;
  readonly #capabilityScope: string;
  constructor(readonly config: ModelProviderConfig) {
    this.#baseURL = modelApiBaseURL('anthropic_messages', config.baseURL);
    this.#capabilityStore = config.capabilityStore ?? new InMemoryProviderCapabilityStore();
    this.#capabilityScope = config.capabilityScope ?? modelProviderCapabilityScope({ ...config, adapter: 'anthropic_messages' });
    // SDK paths begin with /v1. Map them to the configured API root, including
    // gateway prefixes such as /zen/go/v1, without doubling or dropping /v1.
    const fetcher = config.fetch ?? globalThis.fetch;
    this.#client = new Anthropic({ ...(modelApiGateway(this.#baseURL) === 'openrouter'
      ? { apiKey: null, authToken: config.apiKey } : { apiKey: config.apiKey }), baseURL: this.#baseURL,
      timeout: config.timeoutMs, maxRetries: 0, fetch: (input, init) => {
        const url = String(input);
        const prefix = `${this.#baseURL}/v1/`;
        return fetcher(url.startsWith(prefix) ? `${this.#baseURL}/${url.slice(prefix.length)}` : input, init);
      } });
  }
  async estimateInputTokens(request: ModelRequest, options: ModelStreamOptions = {}): Promise<number> {
    options.signal?.throwIfAborted();
    const params = this.#project(await resolveLocalImageInputs(request));
    options.signal?.throwIfAborted();
    return recordProjection(FORMAT, request, { ...params }, options, this.config.maxRequestBodyBytes);
  }
  async *stream(request: ModelRequest, options: ModelStreamOptions = {}): AsyncIterable<ModelEvent> {
    const attempts = options.attempts ?? new ModelRequestAttempts();
    options = { ...options, attempts };
    const emit = eventWriter(request.requestId), blocks = new Map<number, Block>();
    const diagnostics = new AnthropicStreamDiagnostics(options.onStreamDiagnostic, options.signal);
    let started = false, finishReason: string | undefined;
    let usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    try {
      const resolvedRequest = await resolveLocalImageInputs(request);
      options.signal?.throwIfAborted();
      const stream = await this.#createStream(resolvedRequest, options, diagnostics);
      diagnostics.report('response_headers');
      for await (const event of stream) {
        diagnostics.observe(event);
        options.signal?.throwIfAborted();
        if (event.type === 'message_start') {
          if (started) throw new Error('Duplicate Anthropic message_start.');
          started = true;
          usage = usageFrom(event.message.usage, usage);
          yield emit({ kind: 'response_started' });
          yield emit({ kind: 'usage', ...usage });
        } else if (!started) throw new Error('Anthropic stream is missing message_start.');
        else if (event.type === 'content_block_start') {
          if (!Number.isSafeInteger(event.index) || event.index < 0 || blocks.has(event.index)) throw new Error('Invalid Anthropic block identity.');
          if (!['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(event.content_block.type)) throw new Error(`Unsupported Anthropic content block: ${event.content_block.type}`);
          blocks.set(event.index, { value: structuredClone(event.content_block) as unknown as Record<string, unknown>, json: '', stopped: false });
          if (event.content_block.type === 'text' && event.content_block.text) yield emit({ kind: 'text_delta', delta: event.content_block.text });
          if (event.content_block.type === 'thinking' && event.content_block.thinking) yield emit({ kind: 'reasoning_delta', delta: event.content_block.thinking });
        } else if (event.type === 'content_block_delta') {
          const block = blocks.get(event.index);
          if (!block || block.stopped) throw new Error('Anthropic delta references a missing or closed block.');
          const delta = event.delta;
          if (delta.type === 'text_delta' && block.value.type === 'text') {
            block.value.text = String(block.value.text ?? '') + delta.text;
            yield emit({ kind: 'text_delta', delta: delta.text });
          } else if (delta.type === 'thinking_delta' && block.value.type === 'thinking') {
            block.value.thinking = String(block.value.thinking ?? '') + delta.thinking;
            yield emit({ kind: 'reasoning_delta', delta: delta.thinking });
          } else if (delta.type === 'signature_delta' && block.value.type === 'thinking') {
            block.value.signature = String(block.value.signature ?? '') + delta.signature;
          } else if (delta.type === 'input_json_delta' && block.value.type === 'tool_use') block.json += delta.partial_json;
          else throw new Error('Unsupported or mismatched Anthropic content delta.');
        } else if (event.type === 'content_block_stop') {
          const block = blocks.get(event.index);
          if (!block || block.stopped) throw new Error('Invalid Anthropic block completion.');
          block.stopped = true;
        } else if (event.type === 'message_delta') {
          if (event.delta.stop_reason) finishReason = event.delta.stop_reason;
          usage = usageFrom(event.usage, usage);
          yield emit({ kind: 'usage', ...usage });
        } else if (event.type === 'message_stop') {
          if (!finishReason) { yield emit(incompleteStream()); return; }
          if (finishReason === 'model_context_window_exceeded') {
            // No tools from an incomplete response may run. Use the existing
            // bounded context recovery, or fail explicitly when unavailable.
            yield emit({ kind: 'usage', ...usage });
            yield emit({ kind: 'response_failed', code: 'context_length_exceeded',
              message: 'The model reached its context window before completing the response.', retryable: false });
            return;
          }
          const truncated = finishReason === 'max_tokens';
          const calls = new Map<number, PortableCall>();
          for (const [index, block] of blocks) {
            if (!block.stopped && !truncated) throw new Error('Anthropic message contains an unfinished block.');
            if (block.value.type === 'tool_use') {
              if (truncated) continue;
              calls.set(index, { id: String(block.value.id ?? ''), name: String(block.value.name ?? ''),
                arguments: block.json || JSON.stringify(block.value.input) });
            }
          }
          if (!truncated && ((calls.size > 0) !== (finishReason === 'tool_use'))) throw new Error('Anthropic tool completion does not match its content.');
          // Validate wire identities only. Argument/schema failures belong to the Runtime.
          const toolEvents = toolCallEvents(calls, request);
          let replayable = !truncated;
          for (const [index, call] of calls) {
            const input = objectArguments(call.arguments);
            if (input) blocks.get(index)!.value.input = input;
            else replayable = false;
          }
          for (const event of toolEvents) yield emit(event);
          yield emit({ kind: 'usage', ...usage });
          if (attempts.snapshot().recoveryAttempts > 0) options.onCompatibilityDiagnostic?.({
            model: request.model, source: 'generation', action: 'recovered', ...attempts.snapshot(),
          });
          yield emit({ kind: 'response_completed', finishReason: truncated ? 'length' : finishReason === 'tool_use' ? 'tool_calls' : finishReason === 'end_turn' || finishReason === 'stop_sequence' ? 'stop' : finishReason,
            ...(truncated ? { completedToolCallIndices: [] } : {}),
            ...(replayable ? { providerReplay: { format: FORMAT, data: {
              content: [...blocks].sort(([a], [b]) => a - b).map(([, block]) => block.value),
            } } } : {}) });
          return;
        }
      }
      options.signal?.throwIfAborted();
      diagnostics.report('eof');
      yield emit(incompleteStream());
    } catch (error) {
      diagnostics.report('error');
      const failure = providerFailureEvent(request.requestId, 0, error, options.signal?.aborted ?? false);
      const { protocol: _p, requestId: _r, sequence: _s, createdAt: _t, ...payload } = failure;
      yield emit(payload);
    } finally { diagnostics.close(); }
  }

  #cacheIdentity(model: string) {
    return { scope: this.#capabilityScope, model, capability: PROMPT_CACHING_CAPABILITY };
  }

  #project(request: ModelRequest, disablePromptCache = false): MessageCreateParamsStreaming {
    return toAnthropicMessagesParams(request, this.config.anthropicThinkingMode,
      !disablePromptCache && this.#capabilityStore.read(this.#cacheIdentity(request.model)).status !== 'unsupported');
  }

  async #createStream(request: ModelRequest, options: ModelStreamOptions, diagnostics: AnthropicStreamDiagnostics) {
    const attempts = options.attempts ?? new ModelRequestAttempts();
    for (;;) {
      options.signal?.throwIfAborted();
      const params = this.#project(request, attempts.hasRecovery('negotiate_capability'));
      recordProjection(FORMAT, request, { ...params }, options, this.config.maxRequestBodyBytes, true);
      diagnostics.dispatch(params);
      try {
        attempts.dispatch();
        return await this.#client.messages.create(params, { signal: options.signal,
          headers: modelRequestHeaders(this.#baseURL, this.config.defaultHeaders, request.sessionId) });
      } catch (error) {
        const message = anthropicValidationMessage(error) ?? '';
        const unsupportedCache = /^(?:["']?cache_control["']?)\s*(?::|is\b)\s*(?:extra inputs are not permitted|not supported|unsupported)\b/i.test(message) ||
          /^(?:unknown|unsupported|unrecognized) (?:field|parameter|request argument(?: supplied)?)\s*:?\s*["']?cache_control\b/i.test(message);
        // This retry only removes a rejected optional field, before any output.
        // HTTP auth, overflow, unrelated validation and stream errors never use it.
        if (!params.cache_control || !unsupportedCache ||
            !attempts.recover('negotiate_capability', { signal: options.signal })) throw error;
        this.#capabilityStore.observe(this.#cacheIdentity(request.model), { status: 'unsupported', reason: 'cache_control_rejected' });
        options.onCompatibilityDiagnostic?.({ model: request.model, source: 'generation', action: 'retry',
          ...attempts.snapshot(),
          error: { code: 'anthropic_prompt_cache_unsupported', status: 400,
            message: 'This endpoint rejected automatic prompt caching; retrying without cache_control.' } });
      }
    }
  }
}

function usageFrom(value: Extract<RawMessageStreamEvent, { type: 'message_delta' }>['usage'] | Anthropic.Messages.Usage,
  previous: { inputTokens: number; outputTokens: number; cachedInputTokens: number }) {
  const full = value as Partial<Anthropic.Messages.Usage>;
  const inputKnown = typeof full.input_tokens === 'number';
  return {
    inputTokens: inputKnown ? full.input_tokens! + (full.cache_creation_input_tokens ?? 0) + (full.cache_read_input_tokens ?? 0) : previous.inputTokens,
    outputTokens: full.output_tokens ?? previous.outputTokens,
    cachedInputTokens: full.cache_read_input_tokens ?? previous.cachedInputTokens,
  };
}
