import { renderPromptTemplate } from '@cardbush/platform/prompts';
import { randomUUID } from 'node:crypto';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '@cardbush/bush-protocol';
import type { RealtimeContextRequest, RealtimeContextResult, ToolDefinition } from '@cardbush/bush-protocol';
import { ContextCompactionTransaction } from './contextCompactionTransaction.js';
import { executeBufferedModelRound } from './bufferedModelRetry.js';
import { resolveContextOutputTokens } from './contextCompaction.js';
import type { ModelProvider } from './modelProvider.js';

const instructions = renderPromptTemplate('realtime-context-compaction');

/** A bounded maintenance request, independent of the foreground turn and its tools. */
export async function compactRealtimeContext(provider: ModelProvider, input: RealtimeContextRequest,
  checkpoint: ToolDefinition, signal?: AbortSignal, currentTasks: unknown[] = []): Promise<RealtimeContextResult> {
  const { job, model } = input;
  const contextTokens = Number(model.metadata.contextWindowTokens) || DEFAULT_MAX_CONTEXT_TOKENS;
  const outputTokens = resolveContextOutputTokens(contextTokens, model.maxOutputTokens);
  const bounded = AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]);
  const source = JSON.stringify({ previousSummary: job.previousSummary, pairs: job.pairs,
    currentTasks, note:'Assistant transcripts are generated text, not proof the user heard all of it. Task states are a point-in-time snapshot; query actual tasks before acting.' });
  const transaction = new ContextCompactionTransaction({
    messages: [{ role: 'developer', content: instructions+`\nThis session's summary must fit ${job.maxSummaryCharacters} characters.` }, { role: 'user', content: source }], prefixMessageCount: 1,
    sources: [{ target: 'source 0', turnId: job.jobId, startMessage: 1, endMessageExclusive: 2 }],
    state: { revision: job.revision, totalTurns: 1, unsummarizedTurnIds: [job.jobId] },
    pressure: { measurement: 'fallback_estimate', estimatedPromptTokens: source.length, fallbackPromptTokens: source.length,
      fallbackScale: 1, reservedOutputTokens: outputTokens, usableInputTokens: contextTokens - outputTokens, ratio: source.length / (contextTokens - outputTokens) },
    outputTokens, maximumOutputTokens: outputTokens, inputFormat: 'incremental',
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    bounded.throwIfAborted();
    const work = transaction.job();
    const result = await executeBufferedModelRound(provider, {
      protocol: 'bush.model_request.v1', requestId: randomUUID(), sessionId: job.sessionId, turnId: `voice_memory_${job.jobId}`,
      model: model.model, providerBinding: model.providerBinding, reasoningEffort: model.reasoningEffort,
      messages: work.messages, tools: [checkpoint], maxOutputTokens: work.outputTokens,
      permissionMode: 'task_free', requestCapabilities: { vision: false, interactiveRequests: false },
      metadata: { ...model.metadata, runtimeMaintenance: 'realtime_context_compaction' },
    }, { signal: bounded });
    if (result.status !== 'completed') throw Error('Voice checkpoint request failed; original history retained.');
    try {
      const candidate=JSON.parse(result.toolCalls[0]?.argumentsText ?? '{}').updates?.[0]?.summary;
      if (typeof candidate!=='string' || candidate.length>job.maxSummaryCharacters || candidate.length>=source.length*0.8) throw Error('Checkpoint did not reduce the source enough.');
      if (transaction.accept(result)) {
        const summary = transaction.incremental!.value.summaries[0]!;
        bounded.throwIfAborted();
        return { jobId: job.jobId, revision: job.revision, through: job.through, summary };
      }
    } catch { if (!transaction.retry(`Return one complete checkpoint_context update for source 0. Keep its summary below ${job.maxSummaryCharacters} characters and substantially shorter than the original.`)) break; }
  }
  throw Error('Voice checkpoint failed validation; original history retained.');
}
