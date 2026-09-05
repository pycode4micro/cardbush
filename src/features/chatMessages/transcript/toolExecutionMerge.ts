// Merge execution facts and enrich their original message; never execute tools here.
import type {
  ChatToolExecution,
  ChatMessage,
} from '../../../types';
import {
  mergeToolArtifacts,
} from '../../../backend/toolArtifacts';
import {
  optionalFiniteNumber,
  chatMessageTurnId,
  numericOrderValue,
  compareOptionalOrder,
  dateOrderValue,
} from './messageFacts';
import {
  attachHistoryToolExecutions,
} from '../../../backend/historyToolAssociation';

export function mergeToolExecutionUpdate(
  current: ChatToolExecution,
  incoming: ChatToolExecution,
): ChatToolExecution {
  const currentSettled = toolExecutionStateRank(current.state) >= 2;
  const incomingRunning = toolExecutionStateRank(incoming.state) < 2;
  const artifacts = mergeToolArtifacts(current.artifacts, incoming.artifacts);
  const merged = {
    ...current,
    ...incoming,
    ...(artifacts.length > 0 ? { artifacts } : {}),
  };
  if (!currentSettled || !incomingRunning) {
    return merged;
  }
  return {
    ...merged,
    state: current.state,
    success: current.success,
    durationMs: Math.max(current.durationMs, incoming.durationMs),
  };
}

function toolExecutionStateRank(value: ChatToolExecution['state']) {
  if (value === 'completed') return 3;
  if (value === 'failed' || value === 'cancelled') return 2;
  return 1;
}

export function toolExecutionBelongsToMessage(
  message: ChatMessage,
  execution: ChatToolExecution,
) {
  const assistantMessageId = execution.assistantMessageId?.trim() ?? '';
  if (assistantMessageId) {
    return (
      message.id === assistantMessageId ||
      (message.messageId?.trim() ?? '') === assistantMessageId ||
      (message.assistantMessageId?.trim() ?? '') === assistantMessageId
    );
  }
  const executionSegmentIndex =
    execution.assistantSegmentIndex ??
    optionalFiniteNumber(execution.metadata.assistant_segment_index);
  const executionTurnId =
    execution.turnId?.trim() || String(execution.metadata.turn_id ?? '').trim();
  if (executionSegmentIndex != null && executionTurnId) {
    return (
      chatMessageTurnId(message) === executionTurnId &&
      Number(message.metadata?.assistant_segment_index) === executionSegmentIndex
    );
  }
  const executionLoopIndex = numericOrderValue(execution.loopIndex);
  const messageLoopIndex = numericOrderValue(message.loopIndex);
  return (
    executionLoopIndex != null &&
    messageLoopIndex != null &&
    executionLoopIndex === messageLoopIndex
  );
}

export function mergeToolExecutionLists(
  primary: ChatToolExecution[],
  fallback: ChatToolExecution[],
) {
  const byId = new Map<string, ChatToolExecution>();
  for (const execution of fallback) {
    byId.set(execution.id, execution);
  }
  for (const execution of primary) {
    const current = byId.get(execution.id);
    byId.set(
      execution.id,
      current ? mergeToolExecutionUpdate(current, execution) : execution,
    );
  }
  return Array.from(byId.values()).sort(compareToolExecutionTranscriptOrder);
}

function compareToolExecutionTranscriptOrder(
  left: ChatToolExecution,
  right: ChatToolExecution,
) {
  return (
    compareOptionalOrder(numericOrderValue(left.sequence), numericOrderValue(right.sequence)) ||
    compareOptionalOrder(numericOrderValue(left.loopIndex), numericOrderValue(right.loopIndex)) ||
    compareOptionalOrder(dateOrderValue(left.createdAt), dateOrderValue(right.createdAt))
  );
}

export function mergeWorkspaceChangeExecutions(
  messages: ChatMessage[],
  workspaceChanges: ChatToolExecution[],
) {
  if (workspaceChanges.length === 0) return messages;
  // The transcript initially carries compact Tool execution summaries. Upgrade
  // each summary in the assistant segment that issued the Tool call so loop
  // collapsing cannot leave the summary ahead of a detached full-detail copy.
  return attachHistoryToolExecutions(messages, workspaceChanges);
}
