import type { RuntimeContextCompactionEvent } from '@cardbush/bush-protocol';

import type { ChatToolExecution } from '../types';

export const runtimeContextCompactionPresentationName =
  'runtime_context_compaction' as const;

export function isContextCompactionPresentationExecution(
  execution: ChatToolExecution,
) {
  return execution.name === runtimeContextCompactionPresentationName &&
    execution.metadata.runtimeMaintenance === 'context_compaction';
}

/**
 * Context compaction is a Runtime maintenance lifecycle, not a model Tool
 * execution. The product adapts its explicit events into the existing
 * execution-row view model only at the renderer boundary so it can share the
 * familiar Tool presentation without entering Session messages, Tool records,
 * review, revert, or the next model request.
 */
export function contextCompactionPresentationExecution(
  event: RuntimeContextCompactionEvent,
  current?: ChatToolExecution,
): ChatToolExecution {
  const terminal = event.kind === 'context_compaction_completed' ||
    event.kind === 'context_compaction_failed' ||
    event.kind === 'context_compaction_cancelled';
  const state: ChatToolExecution['state'] =
    event.kind === 'context_compaction_completed'
      ? 'completed'
      : event.kind === 'context_compaction_failed'
        ? 'failed'
        : event.kind === 'context_compaction_cancelled'
          ? 'cancelled'
          : 'running';
  const createdAt = current?.createdAt ?? event.createdAt;
  const durationMs = terminal
    ? elapsedMilliseconds(createdAt, event.createdAt)
    : current?.durationMs ?? 0;
  const payload = event.payload;
  const previousMetadata = { ...(current?.metadata ?? {}) };
  // Retry diagnostics describe only the currently active lifecycle edge. Do
  // not leave an old correction message attached after that same compaction
  // later succeeds.
  delete previousMetadata.runtimeMaintenanceEvent;
  delete previousMetadata.reason;
  delete previousMetadata.message;
  const metadata = {
    ...previousMetadata,
    runtimeMaintenance: 'context_compaction',
    runtimeMaintenanceEvent: event.kind,
    compactionId: payload.compactionId,
    round: payload.round,
    attempt: payload.attempt,
    ...('thresholdRatio' in payload
      ? {
          thresholdRatio: payload.thresholdRatio,
          triggerRatio: payload.triggerRatio,
          estimatedInputTokens: payload.estimatedInputTokens,
          usableInputTokens: payload.usableInputTokens,
          measurement: payload.measurement,
          precedingTurnCount: payload.precedingTurnCount,
          activeTurnIncluded: payload.activeTurnIncluded,
          activeThroughMessageId: payload.activeThroughMessageId,
        }
      : {}),
    ...('summarizedTurnCount' in payload
      ? {
          summarizedTurnCount: payload.summarizedTurnCount,
          activeTurnCheckpointed: payload.activeTurnCheckpointed,
          activeThroughMessageId: payload.activeThroughMessageId,
        }
      : {}),
    ...('reason' in payload ? { reason: payload.reason } : {}),
    ...('message' in payload ? { message: payload.message } : {}),
  };
  return {
    id: payload.compactionId,
    name: runtimeContextCompactionPresentationName,
    state,
    summary: runtimeContextCompactionPresentationName,
    output: '',
    success: event.kind === 'context_compaction_completed',
    durationMs,
    createdAt,
    contentOffset:
      current?.contentOffsetExplicit
        ? current.contentOffset
        : payload.assistantContentOffset ?? 0,
    ...(current?.contentOffsetExplicit || payload.assistantContentOffset !== undefined
      ? { contentOffsetExplicit: true }
      : {}),
    sequence: current?.sequence ?? event.sequence,
    loopIndex: current?.loopIndex ?? payload.round,
    turnId: event.turnId,
    assistantMessageId:
      current?.assistantMessageId ?? payload.assistantMessageId,
    metadata,
  };
}

export function contextCompactionPresentationExecutions(
  events: RuntimeContextCompactionEvent[],
): ChatToolExecution[] {
  const byId = new Map<string, ChatToolExecution>();
  for (const event of events) {
    const id = event.payload.compactionId;
    byId.set(id, contextCompactionPresentationExecution(event, byId.get(id)));
  }
  return [...byId.values()].sort((left, right) =>
    (left.sequence ?? Number.MAX_SAFE_INTEGER) -
      (right.sequence ?? Number.MAX_SAFE_INTEGER) ||
    left.id.localeCompare(right.id),
  );
}

function elapsedMilliseconds(start: string, end: string) {
  const startedAt = Date.parse(start);
  const completedAt = Date.parse(end);
  return Number.isFinite(startedAt) &&
    Number.isFinite(completedAt) &&
    completedAt >= startedAt
    ? completedAt - startedAt
    : 0;
}
