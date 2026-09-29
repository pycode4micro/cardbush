import type { MessageCreateParamsStreaming, RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages';
import { providerStreamDiagnosticSchema, type ProviderStreamDiagnostic } from '@cardbush/bush-protocol';

/** Observes SDK events, not socket liveness: SDK-filtered pings are not model progress. */
export class AnthropicStreamDiagnostics {
  readonly #started = Date.now();
  #lastEvent = this.#started;
  readonly #timer?: ReturnType<typeof setInterval>;
  readonly #state: Omit<ProviderStreamDiagnostic, 'stage' | 'elapsedMs' | 'idleMs'> = {
    format: 'anthropic.messages.v1', eventCount: 0, thinkingChars: 0, textChars: 0,
    toolArgumentChars: 0, messageStopReceived: false, aborted: false,
  };
  constructor(private readonly emit?: (event: ProviderStreamDiagnostic) => void,
    private readonly signal?: AbortSignal, intervalMs = 30_000) {
    if (emit) {
      this.#timer = setInterval(() => this.report(Date.now() - this.#lastEvent >= intervalMs ? 'idle' : 'progress'), intervalMs);
      this.#timer.unref();
    }
  }
  dispatch(params: MessageCreateParamsStreaming) {
    this.#state.maxOutputTokens = params.max_tokens;
    this.#state.thinkingMode = params.thinking?.type;
    this.#state.effort = params.output_config?.effort ?? undefined;
    this.report('request');
  }
  observe(event: RawMessageStreamEvent) {
    this.#lastEvent = Date.now();
    this.#state.eventCount++;
    this.#state.lastEventType = event.type;
    if (event.type === 'content_block_start') {
      if (event.content_block.type === 'thinking') this.#state.thinkingChars += event.content_block.thinking.length;
      if (event.content_block.type === 'text') this.#state.textChars += event.content_block.text.length;
    } else if (event.type === 'content_block_delta') {
      if (event.delta.type === 'thinking_delta') this.#state.thinkingChars += event.delta.thinking.length;
      if (event.delta.type === 'text_delta') this.#state.textChars += event.delta.text.length;
      if (event.delta.type === 'input_json_delta') this.#state.toolArgumentChars += event.delta.partial_json.length;
    } else if (event.type === 'message_stop') this.#state.messageStopReceived = true;
    if (event.type === 'message_start' || event.type === 'message_delta') {
      const usage = event.type === 'message_start' ? event.message.usage : event.usage;
      if (typeof usage.input_tokens === 'number') this.#state.inputTokens = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
      if (typeof usage.output_tokens === 'number') this.#state.outputTokens = usage.output_tokens;
      if (typeof usage.cache_read_input_tokens === 'number') this.#state.cachedInputTokens = usage.cache_read_input_tokens;
      if (event.type === 'message_delta' && event.delta.stop_reason) {
        const reason = providerStreamDiagnosticSchema.shape.stopReason.safeParse(event.delta.stop_reason);
        this.#state.stopReason = reason.success ? reason.data : 'unknown';
      }
    }
    // No per-token log amplification. Persist boundaries before waiting for message_stop.
    if (event.type !== 'content_block_delta') this.report('event');
  }
  report(stage: ProviderStreamDiagnostic['stage']) {
    if (!this.emit) return;
    const now = Date.now();
    try { this.emit({ ...this.#state, stage, elapsedMs: Math.max(0, now - this.#started),
      idleMs: Math.max(0, now - this.#lastEvent), aborted: this.signal?.aborted ?? false }); }
    catch { /* Optional diagnostics must not interrupt model execution. */ }
  }
  close() { clearInterval(this.#timer); this.report('closed'); }
}
