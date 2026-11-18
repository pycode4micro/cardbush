import { randomUUID } from 'node:crypto';
import { DEFAULT_MAX_CONTEXT_TOKENS, type ModelMessage, type ModelRequest, type RuntimeSessionTurnRequest, type ToolDefinition } from '@cardbush/bush-protocol';
import { AssistantModelHistory } from './assistantModelHistory.js';
import { completeContextUnits } from './contextCompactionTransaction.js';
import { estimateContextPressure } from './contextCompaction.js';
import { compactRealtimeContext, serializeRealtimeContextSource } from './realtimeContextCompaction.js';
import type { ModelProvider } from './modelProvider.js';

// A working-set policy, independent of the model's hard capacity. Hysteresis
// avoids rewriting the cache prefix after every exchange. Source records stay
// on disk; only the model-authored checkpoint replaces the active prefix.
export const assistantWorkingSetPolicy = Object.freeze({ highTokens: 64_000, lowTokens: 32_000, sourceTokens: 32_000, recentUnits: 8, summaryCharacters: 6_000 });
function checkpointPairs(messages: ModelMessage[]) {
  return messages.flatMap(message => {
    const text = JSON.stringify(message), chunks = [];
    for (let offset = 0; offset < text.length; offset += 30_000) chunks.push({ user: text.slice(offset, offset + 30_000), assistant: 'Historical exchange data; adjacent fragments retain their original order.' });
    return chunks;
  });
}
export function assistantCheckpointPlan(history: ReturnType<AssistantModelHistory['read']>, parent: RuntimeSessionTurnRequest, tasks: unknown[] = []) {
  const request: ModelRequest = { ...parent, protocol: 'bush.model_request.v1', messages: history.messages, tools: [],
    metadata: { ...parent.metadata, contextWindowTokens: Number(parent.metadata.contextWindowTokens) || DEFAULT_MAX_CONTEXT_TOKENS } };
  const tokens = (messages: ModelMessage[]) => estimateContextPressure(request, messages)!.estimatedPromptTokens;
  const before = tokens(history.messages) + Math.ceil(history.summary.length / 4);
  const capacity = Number(request.metadata.contextWindowTokens);
  const high = Math.min(assistantWorkingSetPolicy.highTokens, Math.floor(capacity * 0.6));
  if (before < high) return;
  const units = completeContextUnits(history.messages);
  if (units.length <= assistantWorkingSetPolicy.recentUnits) return;
  const low = Math.min(assistantWorkingSetPolicy.lowTokens, Math.floor(high / 2));
  // Keep whole exchanges, including reasoning/tool pairs. Never cut a receipt
  // away from its call or discard the most recent input to meet a soft budget.
  let cut = units.length - assistantWorkingSetPolicy.recentUnits;
  let retained = tokens(units.slice(cut).flat());
  while (cut > 0) {
    const next = tokens(units[cut - 1]!);
    if (retained + next > low) break;
    retained += next; cut--;
  }
  // Bound maintenance latency too: smaller checkpoints can commit between
  // foreground requests instead of repeatedly losing one oversized API call.
  const maximumSource = Math.min(assistantWorkingSetPolicy.sourceTokens, Math.floor(capacity * 0.5));
  // The checkpoint serializes reasoning and tool envelopes as plain text. Its
  // budget must measure that representation, not the original chat projection.
  const sourceTokens = (messages: ModelMessage[]) => tokens([{ role: 'user', content: serializeRealtimeContextSource({
    previousSummary: history.summary, pairs: checkpointPairs(messages),
  }, tasks, true) }]);
  let selected = 0, upper = cut;
  while (selected < upper) {
    const candidate = Math.ceil((selected + upper) / 2);
    if (sourceTokens(units.slice(0, candidate).flat()) > maximumSource) upper = candidate - 1;
    else selected = candidate;
  }
  if (!selected) throw Object.assign(Error('A complete context unit exceeds the idle checkpoint source budget; original history retained.'), { code: 'context_checkpoint_source_too_large' });
  const messages = units.slice(0, selected).flat();
  return { before, messages, through: history.through + messages.length };
}

export type AssistantMaintenanceStatus = { phase: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed';
  beforeTokens?: number; afterTokens?: number; durationMs?: number; checkpoints: number; errorCode?: string };

/** One idle job owns a frozen prefix. New input cancels it before model work
 * starts; a stale provider response cannot commit after stop, reset or restart. */
export class AssistantContextMaintenance {
  private controller?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private retryAfter = 0;
  private state: AssistantMaintenanceStatus = { phase: 'idle', checkpoints: 0 };
  snapshot() { return { ...this.state }; }
  cancel() {
    clearTimeout(this.timer); this.timer = undefined;
    this.controller?.abort(); this.controller = undefined;
    if (this.state.phase === 'running') this.state = { ...this.state, phase: 'cancelled' };
  }
  schedule(run: (signal: AbortSignal) => Promise<void>, delayMs = 1000, onError?: (error: Error) => void) {
    if (this.timer || this.controller || Date.now() < this.retryAfter) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const controller = this.controller = new AbortController();
      void run(controller.signal).catch(error => {
        if (this.controller === controller && !controller.signal.aborted) {
          const candidate = error instanceof Error ? ('code' in error && typeof error.code === 'string' ? error.code : error.name) : '';
          const errorCode = /^[\w.-]{1,80}$/.test(candidate) ? candidate : 'context_checkpoint_failed';
          this.state = { ...this.state, phase: 'failed', errorCode };
          this.retryAfter = Date.now() + 60_000;
          try { onError?.(new Error(`Assistant context maintenance failed (${errorCode}). Original history retained.`)); } catch { /* Diagnostics cannot change lifecycle. */ }
        }
      }).finally(() => { if (this.controller === controller) this.controller = undefined; });
    }, delayMs);
    this.timer.unref?.();
  }
  async compact(history: AssistantModelHistory, parent: RuntimeSessionTurnRequest, provider: ModelProvider,
    checkpoint: ToolDefinition, signal: AbortSignal, tasks: unknown[], afterCheckpoint?: (before: ModelMessage[], after: ModelMessage[]) => void) {
    for (;;) {
      signal.throwIfAborted();
      if (history.replyInputs()?.length) return;
      const source = history.read(), plan = assistantCheckpointPlan(source, parent, tasks);
      if (!plan) return;
      const started = performance.now();
      this.state = { phase: 'running', beforeTokens: plan.before, checkpoints: this.state.checkpoints };
      const summary = await compactRealtimeContext(provider, {
        job: { jobId: randomUUID(), sessionId: parent.sessionId, revision: source.through, through: plan.through,
          previousSummary: source.summary, maxSummaryCharacters: assistantWorkingSetPolicy.summaryCharacters,
          pairs: checkpointPairs(plan.messages) },
        model: parent,
      }, checkpoint, signal, tasks, { timeoutMs: 180_000, maintenance: 'assistant_context_compaction' });
      signal.throwIfAborted();
      const latest = history.read();
      if (latest.through !== source.through || history.replyInputs()?.length ||
        JSON.stringify(latest.messages.slice(0, plan.messages.length)) !== JSON.stringify(plan.messages)) return;
      history.checkpoint(plan.through, summary.summary);
      const after = history.read();
      afterCheckpoint?.(source.messages, after.messages);
      const remaining = estimateContextPressure({ ...parent, protocol: 'bush.model_request.v1', messages: after.messages, tools: [],
        metadata: { ...parent.metadata, contextWindowTokens: Number(parent.metadata.contextWindowTokens) || DEFAULT_MAX_CONTEXT_TOKENS } }, after.messages)!;
      this.state = { phase: 'completed', checkpoints: this.state.checkpoints + 1, beforeTokens: plan.before,
        afterTokens: remaining.estimatedPromptTokens + Math.ceil(after.summary.length / 4), durationMs: Math.round(performance.now() - started) };
    }
  }
}
