import type { ModelEvent } from '@cardbush/bush-protocol';
import type { ModelRoundResult } from './modelRound.js';

export interface RuntimeExecutionProgress {
  phase: 'waiting' | 'reasoning' | 'responding' | 'retrying' | 'validating';
  startedAt: number;
  lastProgressAt: number | null;
  textChars: number;
  reasoningChars: number;
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: string;
}

export interface RuntimeExecutionOptions {
  timeouts?: { firstResponseMs: number; idleMs: number; totalMs: number };
  onProgress?: (progress: RuntimeExecutionProgress) => void;
}

/** Turn-owned activity and deadlines. All model calls still use the Runtime's
 * request interruption, retry, projection and finalization path. */
export class RuntimeTurnExecution {
  readonly progress: RuntimeExecutionProgress = {
    phase: 'waiting', startedAt: Date.now(), lastProgressAt: null, textChars: 0, reasoningChars: 0,
  };
  timeoutReason?: 'first_response' | 'idle' | 'total';
  private idle?: ReturnType<typeof setTimeout>;
  private total?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(private controller: AbortController, private options: RuntimeExecutionOptions = {}) {
    if (options.timeouts) {
      this.total = setTimeout(() => this.expire('total'), options.timeouts.totalMs);
      this.total.unref?.();
    }
    this.publish();
  }
  private publish() { this.options.onProgress?.({ ...this.progress }); }
  private expire(reason: NonNullable<RuntimeTurnExecution['timeoutReason']>) {
    if (this.closed || this.controller.signal.aborted) return;
    this.timeoutReason = reason;
    this.controller.abort(new Error('Runtime model task timed out.'));
  }
  private arm(reason: 'first_response' | 'idle', milliseconds: number) {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.expire(reason), milliseconds);
    this.idle.unref?.();
  }
  requesting() {
    this.progress.phase = 'waiting';
    this.progress.inputTokens = undefined; this.progress.outputTokens = undefined; this.progress.finishReason = undefined;
    if (this.options.timeouts) this.arm('first_response', this.options.timeouts.firstResponseMs);
    this.publish();
  }
  observe(event: ModelEvent) {
    if (this.closed || this.controller.signal.aborted) return;
    if ((event.kind === 'text_delta' || event.kind === 'reasoning_delta') && event.delta.length) {
      if (event.kind === 'text_delta') { this.progress.textChars += event.delta.length; this.progress.phase = 'responding'; }
      else { this.progress.reasoningChars += event.delta.length; this.progress.phase = 'reasoning'; }
      this.progress.lastProgressAt = Date.now();
      if (this.options.timeouts) this.arm('idle', this.options.timeouts.idleMs);
    } else if (event.kind === 'usage') {
      this.progress.inputTokens = event.inputTokens ?? this.progress.inputTokens;
      this.progress.outputTokens = event.outputTokens ?? this.progress.outputTokens;
    } else return;
    this.publish();
  }
  received(result: ModelRoundResult) {
    clearTimeout(this.idle);
    this.progress.inputTokens = result.usage.inputTokens ?? this.progress.inputTokens;
    this.progress.outputTokens = result.usage.outputTokens ?? this.progress.outputTokens;
    this.progress.finishReason = result.finishReason;
    this.publish();
  }
  phase(phase: 'retrying' | 'validating') {
    clearTimeout(this.idle); this.progress.phase = phase; this.publish();
  }
  dispose() { this.closed = true; clearTimeout(this.idle); clearTimeout(this.total); }
}
