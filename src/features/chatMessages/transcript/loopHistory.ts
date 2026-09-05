// Preserve and collapse execution history for display without changing stored facts.
import type {
  ChatMessage,
} from '../../../types';
import {
  turnTranscriptKey,
  isAssistantFinalTranscript,
  compareAssistantSegments,
  isGuidanceSealedAssistantSegment,
  isSupersededLoopAssistant,
  persistedChatMessageId,
  normalizeLoopContent,
  chatMessageTurnId,
  numericOrderValue,
  compareTranscriptOrder,
  findLastIndex,
  messageIdentityMatches,
  assistantSegmentIndex,
  optionalFiniteNumber,
  sortMessagesByTranscriptOrder,
  chatMessageClientMessageId,
} from './messageFacts';
import {
  mergeToolExecutionLists,
} from './toolExecutionMerge';

export function localLoopHistorySnapshot(message: ChatMessage): ChatMessage {
  const nextLoopIndex = nextLocalLoopIndex(message);
  return {
    ...snapshotLoopHistoryMessage(message),
    id: `${message.id}:local-loop:${nextLoopIndex}`,
    createdAt: new Date().toISOString(),
    status: 'superseded',
    loopIndex: message.loopIndex ?? nextLoopIndex,
    metadata: {
      ...(message.metadata ?? {}),
      status: 'superseded',
      transcript_kind: 'assistant_loop',
      ui_transcript_only: true,
    },
  };
}

function nextLocalLoopIndex(message: ChatMessage) {
  const existing = message.loopHistory ?? [];
  const loopIndexes = existing
    .map((item) => item.loopIndex)
    .filter((value): value is number => Number.isFinite(value));
  const maxLoopIndex = loopIndexes.length > 0 ? Math.max(...loopIndexes) : 0;
  return maxLoopIndex + 1;
}

export function hasIntermediateAssistantSegments(messages: ChatMessage[]) {
  const finalByTurn = finalAssistantSegmentsByTurn(messages);
  return messages.some((message) => {
    const final = finalByTurn.get(turnTranscriptKey(message));
    return Boolean(final && shouldArchiveAssistantSegment(message, final));
  });
}

export function collapseIntermediateAssistantSegments(messages: ChatMessage[]) {
  const finalByTurn = finalAssistantSegmentsByTurn(messages);
  if (finalByTurn.size === 0) {
    return messages;
  }
  const historyByFinalId = new Map<string, ChatMessage[]>();
  const visible: ChatMessage[] = [];
  for (const message of messages) {
    const final = finalByTurn.get(turnTranscriptKey(message));
    if (!final || !shouldArchiveAssistantSegment(message, final)) {
      visible.push(message);
      continue;
    }
    historyByFinalId.set(final.id, [
      ...(historyByFinalId.get(final.id) ?? []),
      snapshotLoopHistoryMessage(message),
    ]);
  }
  return visible.map((message) => {
    const history = historyByFinalId.get(message.id);
    if (!history?.length) {
      return message;
    }
    return {
      ...message,
      loopHistory: mergeLoopHistoryMessages(message.loopHistory ?? [], history),
    };
  });
}

function finalAssistantSegmentsByTurn(messages: ChatMessage[]) {
  const byTurn = new Map<string, ChatMessage>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !isAssistantFinalTranscript(message)) {
      continue;
    }
    const turnKey = turnTranscriptKey(message);
    const current = byTurn.get(turnKey);
    if (!current || compareAssistantSegments(current, message) <= 0) {
      byTurn.set(turnKey, message);
    }
  }
  return byTurn;
}

function shouldArchiveAssistantSegment(
  message: ChatMessage,
  final: ChatMessage,
) {
  if (message.role !== 'assistant' || message.id === final.id) {
    return false;
  }
  if (turnTranscriptKey(message) !== turnTranscriptKey(final)) {
    return false;
  }
  if (isGuidanceSealedAssistantSegment(message)) {
    return false;
  }
  // Older histories do not always carry transcript_kind or
  // assistant_segment_index. Once a later final assistant message exists for
  // the same turn, every other assistant message in that turn is process
  // history. A turn-guidance boundary is different: it seals a user-visible
  // assistant reply before the queued guidance and must remain in the chat.
  return true;
}

export function isStableVisibleTranscript(messages: ChatMessage[]) {
  const ids = new Set<string>();
  const persistedIds = new Set<string>();
  const positions = new Set<string>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (isSupersededLoopAssistant(message) || ids.has(message.id)) {
      return false;
    }
    ids.add(message.id);
    const persistedId = persistedChatMessageId(message);
    if (persistedId) {
      if (persistedIds.has(persistedId)) {
        return false;
      }
      persistedIds.add(persistedId);
    }
    const content = normalizeLoopContent(message.content);
    if (content) {
      const position = [
        message.role,
        chatMessageTurnId(message),
        numericOrderValue(message.turnSequence) ?? '',
        numericOrderValue(message.messageIndex) ?? '',
        numericOrderValue(message.loopIndex) ?? '',
        content,
      ].join('\u0000');
      if (positions.has(position)) {
        return false;
      }
      positions.add(position);
    }
    if (index > 0 && compareTranscriptOrder(messages[index - 1], message) > 0) {
      return false;
    }
  }
  return true;
}

export function collectLoopHistoryFromReplaced(
  replacedMessages: ChatMessage[],
  finalMessages: ChatMessage[],
  temporaryIds: Set<string>,
) {
  const finalIds = new Set(finalMessages.map((message) => message.id));
  const finalAssistant = finalMessages[findLastIndex(
    finalMessages,
    (message) => message.role === 'assistant',
  )];
  const replacedAssistants = replacedMessages
    .filter((message) => message.role === 'assistant')
    .filter((message) => !finalIds.has(message.id))
    .filter(
      (message) =>
        !isGuidanceSealedAssistantSegment(message) ||
        !finalMessages.some(
          (candidate) =>
            candidate.role === 'assistant' &&
            isGuidanceSealedAssistantSegment(candidate) &&
            turnTranscriptKey(candidate) === turnTranscriptKey(message) &&
            (
              messageIdentityMatches(candidate, message) ||
              (
                assistantSegmentIndex(candidate) != null &&
                assistantSegmentIndex(candidate) === assistantSegmentIndex(message)
              )
            ),
        ),
    );
  const candidates = replacedAssistants.flatMap((message) => [
    ...(message.loopHistory ?? []),
    ...(
      hasVisibleLoopHistory(message) &&
      !isTemporaryAssistantCoveredByBackendTranscript(
        message,
        finalMessages,
        temporaryIds,
      ) &&
      !isRedundantTemporaryAssistant(message, finalAssistant, temporaryIds)
        ? [message]
        : []
    ),
  ]);
  return mergeLoopHistoryMessages([], candidates);
}

function isTemporaryAssistantCoveredByBackendTranscript(
  message: ChatMessage,
  finalMessages: ChatMessage[],
  temporaryIds: Set<string>,
) {
  if (!temporaryIds.has(message.id)) {
    return false;
  }
  const turnKey = turnTranscriptKey(message);
  return finalMessages.some((candidate) => {
    if (candidate.role !== 'assistant' || turnTranscriptKey(candidate) !== turnKey) {
      return false;
    }
    if (backendLoopMessageMatchesTemporary(candidate, message, temporaryIds)) {
      return true;
    }
    return (candidate.loopHistory ?? []).some(
      (item) => backendLoopMessageMatchesTemporary(item, message, temporaryIds),
    );
  });
}

function backendLoopMessageMatchesTemporary(
  candidate: ChatMessage,
  temporary: ChatMessage,
  temporaryIds: Set<string>,
) {
  if (
    temporaryIds.has(candidate.id) ||
    !isSupersededLoopAssistant(candidate) ||
    turnTranscriptKey(candidate) !== turnTranscriptKey(temporary)
  ) {
    return false;
  }
  if (messageIdentityMatches(candidate, temporary)) {
    return true;
  }
  const candidateSegment = optionalFiniteNumber(
    candidate.metadata?.assistant_segment_index,
  );
  const temporarySegment = optionalFiniteNumber(
    temporary.metadata?.assistant_segment_index,
  );
  if (candidateSegment != null && temporarySegment != null) {
    return candidateSegment === temporarySegment;
  }
  const candidateLoop = numericOrderValue(candidate.loopIndex);
  const temporaryLoop = numericOrderValue(temporary.loopIndex);
  if (candidateLoop != null && temporaryLoop != null) {
    return candidateLoop === temporaryLoop;
  }
  const candidateContent = normalizeLoopContent(candidate.content);
  return Boolean(
    candidateContent &&
    candidateContent === normalizeLoopContent(temporary.content),
  );
}

export function attachLoopHistoryToFinalAssistant(
  messages: ChatMessage[],
  loopHistory: ChatMessage[],
) {
  const targetIndex = findLastIndex(
    messages,
    (message) => message.role === 'assistant',
  );
  if (targetIndex < 0) {
    return;
  }
  const target = messages[targetIndex];
  messages[targetIndex] = {
    ...target,
    loopHistory: mergeLoopHistoryMessages(target.loopHistory ?? [], loopHistory),
  };
}

export function collapseLoopTranscriptMessages(messages: ChatMessage[]) {
  if (messages.length === 0) {
    return messages;
  }
  const sorted = sortMessagesByTranscriptOrder(messages);
  const loopHistoryByTurn = new Map<string, ChatMessage[]>();
  const visible: ChatMessage[] = [];
  for (const message of sorted) {
    // The backend keeps edit/rerun branches for audit when
    // include_superseded=true. They are not assistant loop segments and must
    // never fall back into the visible transcript just because the replacement
    // response belongs to a newly generated turn. Guidance segments are not
    // marked with this persistence flag and continue through the normal
    // turn-guidance projection below.
    if (isBackendSupersededMessage(message)) {
      continue;
    }
    if (isSupersededLoopAssistant(message)) {
      const key = turnTranscriptKey(message);
      loopHistoryByTurn.set(key, [
        ...(loopHistoryByTurn.get(key) ?? []),
        snapshotLoopHistoryMessage(message),
      ]);
      continue;
    }
    visible.push(message);
  }
  for (const [turnKey, loopHistory] of loopHistoryByTurn) {
    const targetIndex = findLastIndex(
      visible,
      (message) =>
        message.role === 'assistant' &&
        turnTranscriptKey(message) === turnKey &&
        !isSupersededLoopAssistant(message),
    );
    if (targetIndex < 0) {
      visible.push(...loopHistory);
      continue;
    }
    const target = visible[targetIndex];
    visible[targetIndex] = {
      ...target,
      loopHistory: mergeLoopHistoryMessages(target.loopHistory ?? [], loopHistory),
    };
  }
  return sortMessagesByTranscriptOrder(dedupeVisibleTranscriptMessages(visible));
}

export function isBackendSupersededMessage(message: ChatMessage) {
  const metadata = message.metadata ?? {};
  return (
    metadata.__bush_superseded === true ||
    metadata.superseded === true ||
    metadata.is_superseded === true ||
    metadata.isSuperseded === true
  );
}

export function dedupeVisibleTranscriptMessages(messages: ChatMessage[]) {
  const deduped: ChatMessage[] = [];
  for (const message of messages) {
    const existingIndex = deduped.findIndex((candidate) =>
      shouldCollapseDuplicateTranscriptMessage(candidate, message),
    );
    if (existingIndex < 0) {
      deduped.push(message);
      continue;
    }
    deduped[existingIndex] = mergeDuplicateTranscriptMessage(
      deduped[existingIndex],
      message,
    );
  }
  return deduped;
}

function shouldCollapseDuplicateTranscriptMessage(
  left: ChatMessage,
  right: ChatMessage,
) {
  if (left.id === right.id) {
    return true;
  }
  const leftClientMessageId = chatMessageClientMessageId(left);
  const rightClientMessageId = chatMessageClientMessageId(right);
  if (
    leftClientMessageId &&
    rightClientMessageId &&
    leftClientMessageId === rightClientMessageId
  ) {
    return true;
  }
  const leftPersistedId = persistedChatMessageId(left);
  const rightPersistedId = persistedChatMessageId(right);
  if (leftPersistedId && rightPersistedId && leftPersistedId === rightPersistedId) {
    return true;
  }
  if (left.role !== right.role) {
    return false;
  }
  const leftTurn = chatMessageTurnId(left);
  const rightTurn = chatMessageTurnId(right);
  if (!leftTurn || leftTurn !== rightTurn) {
    return false;
  }
  if (!transcriptOrderCompatible(left, right)) {
    return false;
  }
  const leftContent = normalizeLoopContent(left.content);
  const rightContent = normalizeLoopContent(right.content);
  return Boolean(leftContent && leftContent === rightContent);
}

function transcriptOrderCompatible(left: ChatMessage, right: ChatMessage) {
  const leftTurnSequence = numericOrderValue(left.turnSequence);
  const rightTurnSequence = numericOrderValue(right.turnSequence);
  if (
    leftTurnSequence != null &&
    rightTurnSequence != null &&
    leftTurnSequence !== rightTurnSequence
  ) {
    return false;
  }
  const leftMessageIndex = numericOrderValue(left.messageIndex);
  const rightMessageIndex = numericOrderValue(right.messageIndex);
  if (
    leftMessageIndex != null &&
    rightMessageIndex != null &&
    leftMessageIndex !== rightMessageIndex
  ) {
    return false;
  }
  const leftLoopIndex = numericOrderValue(left.loopIndex);
  const rightLoopIndex = numericOrderValue(right.loopIndex);
  if (
    leftLoopIndex != null &&
    rightLoopIndex != null &&
    leftLoopIndex !== rightLoopIndex
  ) {
    return false;
  }
  return true;
}

function mergeDuplicateTranscriptMessage(left: ChatMessage, right: ChatMessage) {
  const primary = transcriptMessagePriority(right) >= transcriptMessagePriority(left)
    ? right
    : left;
  const fallback = primary === right ? left : right;
  const toolExecutions = mergeToolExecutionLists(
    primary.toolExecutions ?? [],
    fallback.toolExecutions ?? [],
  );
  const loopHistory = mergeLoopHistoryMessages(
    primary.loopHistory ?? [],
    fallback.loopHistory ?? [],
  );
  return {
    ...fallback,
    ...primary,
    messageId: primary.messageId ?? fallback.messageId,
    clientMessageId: primary.clientMessageId ?? fallback.clientMessageId,
    assistantMessageId: primary.assistantMessageId ?? fallback.assistantMessageId,
    createdAt: primary.createdAt ?? fallback.createdAt,
    metadata: {
      ...(fallback.metadata ?? {}),
      ...(primary.metadata ?? {}),
    },
    taskPlan: primary.taskPlan ?? fallback.taskPlan,
    toolExecutions: toolExecutions.length > 0 ? toolExecutions : undefined,
    loopHistory: loopHistory.length > 0 ? loopHistory : undefined,
  };
}

function transcriptMessagePriority(message: ChatMessage) {
  let score = 0;
  if (persistedChatMessageId(message)) {
    score += 8;
  }
  if (message.messageId?.trim()) {
    score += 4;
  }
  if (message.role === 'assistant' && isAssistantFinalTranscript(message)) {
    score += 2;
  }
  if (message.createdAt?.trim()) {
    score += 1;
  }
  return score;
}

export function mergeLoopHistoryMessages(
  existing: ChatMessage[],
  incoming: ChatMessage[],
) {
  const byKey = new Map<string, ChatMessage>();
  for (const message of flattenLoopHistoryMessages([...existing, ...incoming])) {
    if (!hasVisibleLoopHistory(message)) {
      continue;
    }
    byKey.set(loopHistoryMessageKey(message), snapshotLoopHistoryMessage(message));
  }
  return sortMessagesByTranscriptOrder(Array.from(byKey.values()));
}

function flattenLoopHistoryMessages(messages: ChatMessage[]) {
  const flattened: ChatMessage[] = [];
  const visiting = new Set<ChatMessage>();
  const visit = (message: ChatMessage) => {
    if (visiting.has(message)) return;
    visiting.add(message);
    for (const nested of message.loopHistory ?? []) {
      visit(nested);
    }
    flattened.push(message);
    visiting.delete(message);
  };
  for (const message of messages) visit(message);
  return flattened;
}

export function snapshotLoopHistoryMessage(message: ChatMessage): ChatMessage {
  return {
    id: message.id,
    messageId: message.messageId,
    role: message.role,
    content: message.content,
    conversationId: message.conversationId,
    turnId: message.turnId,
    createdAt: message.createdAt,
    status: message.status,
    loopIndex: message.loopIndex,
    turnSequence: message.turnSequence,
    messageIndex: message.messageIndex,
    sequence: message.sequence,
    requestId: message.requestId,
    eventId: message.eventId,
    assistantMessageId: message.assistantMessageId,
    attachments: message.attachments?.map((attachment) => ({ ...attachment })),
    toolExecutions: message.toolExecutions?.map((execution) => ({
      ...execution,
      artifacts: execution.artifacts?.map((artifact) => ({ ...artifact })),
      metadata: { ...execution.metadata },
    })),
    taskPlan: message.taskPlan,
    metadata: message.metadata ? { ...message.metadata } : undefined,
  };
}

export function hasVisibleLoopHistory(message: ChatMessage) {
  return Boolean(
    message.content.trim() ||
      (message.attachments?.length ?? 0) > 0 ||
      (message.toolExecutions?.length ?? 0) > 0,
  );
}

export function shouldPreserveExistingAsLoopHistory(
  existing: ChatMessage,
  incoming: ChatMessage,
) {
  if (existing.role !== 'assistant' || incoming.role !== 'assistant') {
    return false;
  }
  if (!hasVisibleLoopHistory(existing)) {
    return false;
  }
  return normalizeLoopContent(existing.content) !== normalizeLoopContent(incoming.content);
}

function isRedundantTemporaryAssistant(
  message: ChatMessage,
  finalAssistant: ChatMessage | undefined,
  temporaryIds: Set<string>,
) {
  if (!finalAssistant || !temporaryIds.has(message.id)) {
    return false;
  }
  return normalizeLoopContent(message.content) === normalizeLoopContent(finalAssistant.content);
}

function loopHistoryMessageKey(message: ChatMessage) {
  return [
    message.id.trim(),
    message.role,
    message.turnId?.trim() ?? '',
    message.assistantMessageId?.trim() ?? '',
    message.status?.trim() ?? '',
    message.loopIndex ?? '',
    message.turnSequence ?? '',
    message.messageIndex ?? '',
    message.createdAt?.trim() ?? '',
    normalizeLoopContent(message.content),
    message.toolExecutions
      ?.map((execution) =>
        [
          execution.id,
          execution.state,
          normalizeLoopContent(execution.summary),
          normalizeLoopContent(execution.output),
        ].join(':'),
      )
      .join(',') ?? '',
  ].join('|');
}
