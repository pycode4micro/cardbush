import { agentToolActivity, savedNextStepPrediction, toolExecutionError, type ToolExecutionRecord as RuntimeToolExecutionRecord, type ToolExecutionSummary as RuntimeToolExecutionSummary } from '@cardbush/bush-protocol';
import type { ChatToolExecution } from '../types';
import { configuredMcpServerId } from './mcpConfigurationFact';
import { toolArtifactsFromPayload } from './toolArtifacts';

export function runtimeHistoryToolExecution(
  record: RuntimeToolExecutionRecord | RuntimeToolExecutionSummary,
): ChatToolExecution {
  const hasNativeResult = 'result' in record && record.result !== undefined;
  const error = toolExecutionError(record);
  const nextStepPrediction = 'result' in record && 'argumentsText' in record.toolCall
    ? savedNextStepPrediction(record.toolCall, record.result, record.recordedAt)
    : 'nextStepPrediction' in record ? record.nextStepPrediction : undefined;
  const activity = 'agentActivity' in record ? record.agentActivity : agentToolActivity(record);
  const mcpServerId = configuredMcpServerId(record.toolCall);
  const artifacts = record.outcome === 'returned' && hasNativeResult
    ? toolArtifactsFromPayload({ result: record.result })
    : [];
  const output = hasNativeResult
    ? typeof record.result === 'string'
      ? record.result
      : JSON.stringify(record.result, null, 2) ?? 'null'
    : '';
  return {
    id: record.toolCall.id,
    name: record.toolCall.name,
    state: record.outcome === 'returned' ? error ? 'failed' : 'completed' : record.outcome,
    summary: record.display?.title ?? error?.message ?? record.toolCall.name,
    output,
    success: record.outcome === 'returned' && !error,
    durationMs: 0,
    createdAt: record.recordedAt,
    contentOffset: 0,
    sequence: record.ordinal,
    loopIndex: record.round,
    turnId: record.turnId,
    ...(artifacts.length > 0 ? { artifacts } : {}),
    metadata: {
      actionManifest: record.actionManifest,
      ...(nextStepPrediction ? { nextStepPrediction } : {}),
      ...(activity ? { agentActivity: activity } : {}),
      ...('terminalOutcome' in record ? { terminalOutcome: record.terminalOutcome } : {}),
      ...(record.display?.title ? { displayTitle: record.display.title } : {}),
      ...(record.display?.titles ? { displayTitles: record.display.titles } : {}),
      ...(mcpServerId ? { mcpServerId } : {}),
      ...(hasNativeResult
        ? { nativeResult: record.result }
        : 'resultAvailable' in record
          ? {
              nativeResultDeferred: record.resultAvailable === true,
              workspaceChangeDetailsDeferred: record.workspaceChanges.some(
                (change) => change.detailAvailable,
              ),
            }
          : {}),
      workspaceChanges: record.workspaceChanges,
      error,
    },
  };
}
