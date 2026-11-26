import { renderPromptTemplate } from '@cardbush/platform/prompts';
import { randomUUID } from 'node:crypto';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '@cardbush/bush-protocol';
import type { ModelMessage, RealtimeContextRequest, RealtimeContextResult, ToolDefinition } from '@cardbush/bush-protocol';
import { ContextCompactionTransaction } from './contextCompactionTransaction.js';
import { executeBufferedModelRound } from './bufferedModelRetry.js';
import { estimateContextPressure, resolveContextOutputTokens } from './contextCompaction.js';
import type { ModelProvider } from './modelProvider.js';

const instructions = renderPromptTemplate('realtime-context-compaction');

export function serializeRealtimeContextSource(job: Pick<RealtimeContextRequest['job'], 'previousSummary' | 'pairs'>,
  currentTasks: unknown[] = [], assistant = false): string {
  return JSON.stringify({ previousSummary: job.previousSummary, pairs: job.pairs, currentTasks,
    note: assistant ? 'Historical records and point-in-time task states, not a live execution status.'
      : 'Assistant transcripts are generated text, not proof the user heard all of it. Task states are a point-in-time snapshot; query actual tasks before acting.' });
}

/** A bounded maintenance request, independent of the foreground turn and its tools. */
export async function compactRealtimeContext(provider: ModelProvider, input: RealtimeContextRequest,
  checkpoint: ToolDefinition, signal?: AbortSignal, currentTasks: unknown[] = [],
  options: { timeoutMs?: number; maintenance?: string } = {}): Promise<RealtimeContextResult> {
  const { job, model } = input;
  const contextTokens = Number(model.metadata.contextWindowTokens) || DEFAULT_MAX_CONTEXT_TOKENS;
  const outputTokens = resolveContextOutputTokens(contextTokens, model.maxOutputTokens);
  const bounded = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 60_000), ...(signal ? [signal] : [])]);
  const source = serializeRealtimeContextSource(job, currentTasks, options.maintenance === 'assistant_context_compaction');
  const messages: ModelMessage[] = [{ role: 'developer', content: (options.maintenance === 'assistant_context_compaction' ? renderPromptTemplate('assistant-context-compaction') : instructions)+`\nThis session's summary must fit ${job.maxSummaryCharacters} characters.` }, { role: 'user', content: source }];
  const transaction = new ContextCompactionTransaction({
    messages, prefixMessageCount: 1,
    sources: [{ target: 'source 0', turnId: job.jobId, startMessage: 1, endMessageExclusive: 2 }],
    state: { revision: job.revision, totalTurns: 1, unsummarizedTurnIds: [job.jobId] },
    pressure: estimateContextPressure({ ...model, protocol: 'bush.model_request.v1', requestId: job.jobId, sessionId: job.sessionId,
      turnId: job.jobId, messages, tools: [checkpoint], maxOutputTokens: outputTokens, permissionMode: 'ask_for_approval',
      requestCapabilities: { vision: false, interactiveRequests: false }, metadata: { ...model.metadata, contextWindowTokens: contextTokens } }, messages)!,
    outputTokens, maximumOutputTokens: outputTokens, inputFormat: 'incremental',
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    bounded.throwIfAborted();
    const work = transaction.job();
    const result = await executeBufferedModelRound(provider, {
      protocol: 'bush.model_request.v1', requestId: randomUUID(), sessionId: job.sessionId, turnId: `${options.maintenance === 'assistant_context_compaction' ? 'assistant' : 'voice'}_memory_${job.jobId}`,
      model: model.model, providerBinding: model.providerBinding, reasoningEffort: model.reasoningEffort,
      messages: work.messages, tools: [checkpoint], maxOutputTokens: work.outputTokens,
      permissionMode: 'ask_for_approval', requestCapabilities: { vision: false, interactiveRequests: false },
      metadata: { ...model.metadata, runtimeMaintenance: options.maintenance ?? 'realtime_context_compaction' },
    }, { signal: bounded });
    if (result.status !== 'completed') throw Object.assign(Error('Context checkpoint request failed; original history retained.'), { code: result.error.code });
    try {
      const candidate=JSON.parse(result.toolCalls[0]?.argumentsText ?? '{}').updates?.[0]?.summary;
      if (typeof candidate!=='string') throw Error('checkpoint_context requires updates[0].summary as a string.');
      if (candidate.length>job.maxSummaryCharacters) throw Error(`Checkpoint summary has ${candidate.length} characters; limit is ${job.maxSummaryCharacters}.`);
      if (candidate.length>=source.length*0.8) throw Error('Checkpoint summary did not reduce the source enough.');
      if (transaction.accept(result)) {
        const summary = transaction.incremental!.value.summaries[0]!;
        bounded.throwIfAborted();
        return { jobId: job.jobId, revision: job.revision, through: job.through, summary };
      }
    } catch (error) { if (!transaction.retry(`Return one complete checkpoint_context update for source 0. Keep its summary below ${job.maxSummaryCharacters} characters and substantially shorter than the original. Validation: ${error instanceof Error ? error.message : 'Invalid checkpoint.'}`)) break; }
  }
  throw Object.assign(Error('Context checkpoint failed validation; original history retained.'), { code: 'context_checkpoint_invalid' });
}
