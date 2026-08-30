import type { ChatMessage, ChatToolExecution } from '../types';

export function attachHistoryToolExecutions(
  messages: ChatMessage[],
  executions: ChatToolExecution[],
) {
  if (messages.length === 0 || executions.length === 0) {
    return messages;
  }
  const byMessageIndex = new Map<number, ChatToolExecution[]>();
  for (const execution of executions) {
    const targetIndex = historyToolTargetIndex(messages, execution);
    if (targetIndex < 0) continue;
    const current = byMessageIndex.get(targetIndex) ?? [];
    const existingIndex = current.findIndex((item) => item.id === execution.id);
    if (existingIndex >= 0) current[existingIndex] = execution;
    else current.push(execution);
    byMessageIndex.set(targetIndex, current);
  }
  return messages.map((message, index) => {
    const attached = byMessageIndex.get(index);
    if (!attached?.length) return message;
    const byId = new Map(
      (message.toolExecutions ?? []).map((execution) => [execution.id, execution]),
    );
    for (const execution of attached) {
      byId.set(execution.id, { ...byId.get(execution.id), ...execution });
    }
    return {
      ...message,
      toolExecutions: [...byId.values()].sort(compareHistoryToolOrder),
    };
  });
}

function historyToolTargetIndex(
  messages: ChatMessage[],
  execution: ChatToolExecution,
) {
  const assistantMessageId =
    execution.assistantMessageId?.trim() || execution.messageId?.trim() || '';
  if (assistantMessageId) {
    const exactIndex = messages.findIndex((message) =>
      message.role === 'assistant' && messageIdentityValues(message).has(assistantMessageId),
    );
    if (exactIndex >= 0) return exactIndex;
  }

  const turnId = toolTurnId(execution);
  const toolCallIndex = messages.findIndex((message) =>
    message.role === 'assistant' &&
    (!turnId || messageTurnId(message) === turnId) &&
    messageToolCallIds(message).has(execution.id),
  );
  if (toolCallIndex >= 0) return toolCallIndex;

  const segmentIndex =
    execution.assistantSegmentIndex ?? finiteNumber(execution.metadata.assistant_segment_index);
  if (turnId && segmentIndex != null) {
    const segmentMatch = messages.findIndex((message) =>
      message.role === 'assistant' &&
      messageTurnId(message) === turnId &&
      finiteNumber(message.metadata?.assistant_segment_index) === segmentIndex,
    );
    if (segmentMatch >= 0) return segmentMatch;
  }

  if (turnId && execution.loopIndex != null) {
    const loopMatch = messages.findIndex((message) =>
      message.role === 'assistant' &&
      messageTurnId(message) === turnId &&
      message.loopIndex === execution.loopIndex,
    );
    if (loopMatch >= 0) return loopMatch;
  }

  if (!turnId) return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant' && messageTurnId(messages[index]) === turnId) {
      return index;
    }
  }
  return -1;
}

function messageToolCallIds(message: ChatMessage) {
  const toolCalls = message.metadata?.toolCalls;
  if (!Array.isArray(toolCalls)) return new Set<string>();
  return new Set(toolCalls.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const id = String((candidate as Record<string, unknown>).id ?? '').trim();
    return id ? [id] : [];
  }));
}

function messageIdentityValues(message: ChatMessage) {
  return new Set(
    [
      message.id,
      message.messageId,
      message.assistantMessageId,
      String(message.metadata?.message_id ?? ''),
    ].map((value) => value?.trim()).filter(Boolean),
  );
}

function messageTurnId(message: ChatMessage) {
  return message.turnId?.trim() || String(message.metadata?.turn_id ?? '').trim();
}

function toolTurnId(execution: ChatToolExecution) {
  return execution.turnId?.trim() || String(execution.metadata.turn_id ?? '').trim();
}

function finiteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function compareHistoryToolOrder(left: ChatToolExecution, right: ChatToolExecution) {
  return (
    (left.sequence ?? Number.MAX_SAFE_INTEGER) -
      (right.sequence ?? Number.MAX_SAFE_INTEGER) ||
    safeTimestamp(left.createdAt) - safeTimestamp(right.createdAt)
  );
}

function safeTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}
