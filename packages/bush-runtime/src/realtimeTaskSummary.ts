import { renderPromptTemplate } from '@cardbush/platform/prompts';
import { randomUUID } from 'node:crypto';
import type { RealtimeTaskSummaryRequest, SubagentTask } from '@cardbush/bush-protocol';
import { executeModelRound } from './modelRound.js';
import type { ModelProvider } from './modelProvider.js';

/** Separate, tool-free inference: never occupies the conversation or child turn. */
export async function summarizeRealtimeTask(provider: ModelProvider, input: RealtimeTaskSummaryRequest, task: SubagentTask, signal?: AbortSignal, turnId = `voice_summary_${randomUUID()}`) {
  const result = await executeModelRound(provider, {
    protocol: 'bush.model_request.v1', requestId: randomUUID(), sessionId: input.sessionId,
    turnId, ...input.model,
    messages: [{ role: 'system', content: renderPromptTemplate('realtime-task-summary', { language: new Intl.DisplayNames('en', { type: 'language' }).of(input.language) ?? input.language }) },
      { role: 'user', content: JSON.stringify({ assignment: task.prompt, status: task.status,
        result: task.finalResponse.slice(0, 64000), truncated: task.finalResponse.length > 64000, error: task.errorMessage.slice(0, 2000) }) }],
    tools: [], permissionMode: 'task_free',
    requestCapabilities: { vision: false, interactiveRequests: false },
    metadata: { ...input.model.metadata, runtimeMaintenance: 'realtime_task_summary' },
  }, { signal: AbortSignal.any([AbortSignal.timeout(25_000), ...(signal ? [signal] : [])]) });
  const speech = result.text.trim();
  if (result.status !== 'completed' || result.toolCalls.length || !speech || speech.length > 500 || /```|https?:\/\/|[A-Za-z]:[\\/]|(?:^|\s)\/(?:home|usr|tmp|var)\//.test(speech)) {
    throw Error('Spoken task summary unavailable.');
  }
  return { speech };
}
