// Transcript identity, ordering and timing facts. No UI state or backend reads.
import type {
  ChatMessage,
} from '../../../types';

export function hasCompletedAssistantForTurn(messages: ChatMessage[], turnId?: string) {
  const normalizedTurnId = turnId?.trim() ?? '';
  if (!normalizedTurnId) {
    return false;
  }
  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      message.content.trim() &&
      chatMessageTurnId(message) === normalizedTurnId &&
      isAssistantFinalTranscript(message) &&
      !isSupersededLoopAssistant(message),
  );
}

export function optionalFiniteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function isGuidanceSealedAssistantSegment(message: ChatMessage) {
  const metadata = message.metadata ?? {};
  return (
    metadata.segment_boundary === 'turn_guidance' ||
    metadata.segmentBoundary === 'turn_guidance' ||
    String(
      metadata.sealed_by_client_message_id ??
        metadata.sealedByClientMessageId ??
        '',
    ).trim().length > 0
  );
}

export function compareAssistantSegments(left: ChatMessage, right: ChatMessage) {
  const leftSegment = assistantSegmentIndex(left);
  const rightSegment = assistantSegmentIndex(right);
  if (leftSegment != null && rightSegment != null && leftSegment !== rightSegment) {
    return leftSegment - rightSegment;
  }
  return compareTranscriptOrder(left, right);
}

export function assistantSegmentIndex(message: ChatMessage) {
  return optionalFiniteNumber(
    message.metadata?.assistant_segment_index ??
      message.metadata?.assistantSegmentIndex,
  );
}

export function sortMessagesByTranscriptOrder(messages: ChatMessage[]) {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      return compareTranscriptOrder(left.message, right.message) || left.index - right.index;
    })
    .map((item) => item.message);
}

export function compareTranscriptOrder(left: ChatMessage, right: ChatMessage) {
  const turnDelta = compareOptionalOrder(
    numericOrderValue(left.turnSequence),
    numericOrderValue(right.turnSequence),
  );
  if (turnDelta !== 0) {
    return turnDelta;
  }
  const sameTurn = turnTranscriptKey(left) === turnTranscriptKey(right);
  const indexDelta = sameTurn
    ? compareOptionalOrder(
        numericOrderValue(left.messageIndex),
        numericOrderValue(right.messageIndex),
      )
    : 0;
  if (indexDelta !== 0) {
    return indexDelta;
  }
  const loopDelta = sameTurn
    ? compareOptionalOrder(
        numericOrderValue(left.loopIndex),
        numericOrderValue(right.loopIndex),
      )
    : 0;
  if (loopDelta !== 0) {
    return loopDelta;
  }
  const sequenceDelta = compareOptionalOrder(
    numericOrderValue(left.sequence),
    numericOrderValue(right.sequence),
  );
  if (sequenceDelta !== 0) {
    return sequenceDelta;
  }
  return compareOptionalOrder(
    dateOrderValue(left.createdAt),
    dateOrderValue(right.createdAt),
  );
}

export function compareOptionalOrder(left: number | undefined, right: number | undefined) {
  if (left == null || right == null) {
    return 0;
  }
  return left - right;
}

export function dateOrderValue(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function numericOrderValue(value: number | undefined) {
  return Number.isFinite(value) ? Number(value) : undefined;
}

export function persistedChatMessageId(message: ChatMessage | undefined) {
  if (!message) {
    return '';
  }
  const explicitId = message.messageId?.trim() ?? '';
  if (isPersistedChatMessageId(explicitId)) {
    return explicitId;
  }
  const ownId = message.id.trim();
  if (isPersistedChatMessageId(ownId)) {
    return ownId;
  }
  const metadata = message.metadata ?? {};
  for (const value of [
    metadata.message_id,
    metadata.messageId,
    metadata.chat_message_id,
    metadata.chatMessageId,
  ]) {
    const candidate = String(value ?? '').trim();
    if (isPersistedChatMessageId(candidate)) {
      return candidate;
    }
  }
  return '';
}

function isPersistedChatMessageId(value: string) {
  const normalized = value.trim();
  return (
    /^msg:\S+$/.test(normalized) ||
    /^msg-[\w-]+$/.test(normalized) ||
    /^msg_[\w-]+$/.test(normalized) ||
    /^message_[\w-]+$/.test(normalized) ||
    /^\d+$/.test(normalized)
  );
}

export function findPersistedEditableUserMessage(
  source: ChatMessage,
  candidates: ChatMessage[],
) {
  if (source.role !== 'user') {
    return undefined;
  }
  const sourceId = persistedChatMessageId(source);
  if (sourceId) {
    return source.id === sourceId ? source : { ...source, id: sourceId };
  }
  const persistedCandidates = candidates.filter(
    (candidate) => candidate.role === 'user' && persistedChatMessageId(candidate),
  );
  const sourceTurnId = chatMessageTurnId(source);
  if (sourceTurnId) {
    const turnMatch = persistedCandidates.find(
      (candidate) => chatMessageTurnId(candidate) === sourceTurnId,
    );
    if (turnMatch) {
      return turnMatch;
    }
  }
  const sourceTurnSequence = numericOrderValue(source.turnSequence);
  const sourceMessageIndex = numericOrderValue(source.messageIndex);
  if (sourceTurnSequence != null && sourceMessageIndex != null) {
    const orderMatch = persistedCandidates.find(
      (candidate) =>
        numericOrderValue(candidate.turnSequence) === sourceTurnSequence &&
        numericOrderValue(candidate.messageIndex) === sourceMessageIndex,
    );
    if (orderMatch) {
      return orderMatch;
    }
  }
  const sourceContent = normalizeEditableUserContent(source.content);
  if (!sourceContent) {
    return undefined;
  }
  const contentMatches = persistedCandidates.filter(
    (candidate) => normalizeEditableUserContent(candidate.content) === sourceContent,
  );
  return contentMatches.length === 1 ? contentMatches[0] : undefined;
}

export function findUserMessageForAssistantRegenerate(
  source: ChatMessage,
  candidates: ChatMessage[],
) {
  const persistedCandidates = candidates.filter(
    (candidate) => candidate.role === 'user' && persistedChatMessageId(candidate),
  );
  const sourceTurnId = chatMessageTurnId(source);
  if (sourceTurnId) {
    const turnMatch = [...persistedCandidates]
      .reverse()
      .find((candidate) => chatMessageTurnId(candidate) === sourceTurnId);
    if (turnMatch) {
      return turnMatch;
    }
  }
  const sourceIndex = candidates.findIndex((candidate) =>
    messageIdentityMatches(candidate, source),
  );
  const previousMessages =
    sourceIndex >= 0 ? candidates.slice(0, sourceIndex) : candidates;
  return [...previousMessages]
    .reverse()
    .find((candidate) => candidate.role === 'user' && persistedChatMessageId(candidate));
}

export function messageIdentityMatches(left: ChatMessage, right: ChatMessage) {
  if (left.id === right.id) {
    return true;
  }
  const leftId = persistedChatMessageId(left);
  const rightId = persistedChatMessageId(right);
  if (leftId && rightId && leftId === rightId) {
    return true;
  }
  const leftTurn = chatMessageTurnId(left);
  const rightTurn = chatMessageTurnId(right);
  if (!leftTurn || leftTurn !== rightTurn) {
    return false;
  }
  const leftMessageIndex = numericOrderValue(left.messageIndex);
  const rightMessageIndex = numericOrderValue(right.messageIndex);
  return (
    leftMessageIndex != null &&
    rightMessageIndex != null &&
    leftMessageIndex === rightMessageIndex
  );
}

export function chatMessageTurnId(message: ChatMessage) {
  return String(
    message.turnId ??
      message.metadata?.turn_id ??
      message.metadata?.turnId ??
      '',
  ).trim();
}

export function chatMessageClientMessageId(message: ChatMessage) {
  return String(
    message.clientMessageId ??
      message.metadata?.client_message_id ??
      message.metadata?.clientMessageId ??
      '',
  ).trim();
}

export function normalizeEditableUserContent(value: string) {
  return value.trim().replace(/\r\n/g, '\n');
}

export function uniqueMessageIds(values: string[]) {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean)),
  );
}

export function turnTranscriptKey(message: ChatMessage) {
  const turnId = message.turnId?.trim();
  if (turnId) {
    return `turn:${turnId}`;
  }
  const metadataTurnId = String(
    message.metadata?.turn_id ?? message.metadata?.turnId ?? '',
  ).trim();
  if (metadataTurnId) {
    return `turn:${metadataTurnId}`;
  }
  const assistantMessageId = message.assistantMessageId?.trim();
  if (assistantMessageId) {
    return `assistant:${assistantMessageId}`;
  }
  return `message:${message.id}`;
}

export function isSupersededLoopAssistant(message: ChatMessage) {
  const status = String(message.status ?? message.metadata?.status ?? '')
    .trim()
    .toLowerCase();
  const transcriptKind = assistantTranscriptKind(message);
  const historyVisibility = String(
    message.metadata?.history_visibility ?? message.metadata?.historyVisibility ?? '',
  )
    .trim()
    .toLowerCase();
  return (
    message.role === 'assistant' &&
    (
      transcriptKind === 'assistant_loop' ||
      (transcriptKind === 'assistant_segment' && historyVisibility === 'ephemeral') ||
      (status === 'superseded' && !transcriptKind)
    )
  );
}

export function isAssistantFinalTranscript(message: ChatMessage) {
  if (message.role !== 'assistant') {
    return false;
  }
  const status = String(message.status ?? message.metadata?.status ?? '')
    .trim()
    .toLowerCase();
  const transcriptKind = assistantTranscriptKind(message);
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'stopped' ||
    message.metadata?.stopped === true ||
    message.metadata?.cardbush_terminal_stopped === true ||
    transcriptKind === 'assistant_final' ||
    (!status && !transcriptKind)
  );
}

function assistantTranscriptKind(message: ChatMessage) {
  return String(
    message.metadata?.transcript_kind ??
      message.metadata?.transcriptKind ??
      '',
  )
    .trim()
    .toLowerCase();
}

export function normalizeLoopContent(content: string) {
  return content.trim().replace(/\s+/g, ' ');
}

export function findLastIndex<T>(values: T[], predicate: (value: T) => boolean) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index])) {
      return index;
    }
  }
  return -1;
}

export function chatTurnStartedAt(
  messages: ChatMessage[],
  turnId?: string,
  fallback?: string,
) {
  const normalizedTurnId = turnId?.trim() ?? '';
  const matching = normalizedTurnId
    ? messages.filter((message) => chatMessageTurnId(message) === normalizedTurnId)
    : messages;
  const userStartedAt = earliestValidTimestamp(
    matching
      .filter((message) => message.role === 'user' && !isTurnGuidanceMessage(message))
      .map((message) => message.createdAt),
  );
  if (userStartedAt) return userStartedAt;
  const metadataStartedAt = earliestValidTimestamp(
    matching.flatMap((message) => [
      message.metadata?.cardbush_turn_started_at,
      message.metadata?.cardbushTurnStartedAt,
      message.metadata?.turn_started_at,
      message.metadata?.turnStartedAt,
    ]),
  );
  return metadataStartedAt ?? earliestValidTimestamp([fallback]);
}

function isTurnGuidanceMessage(message: ChatMessage) {
  const metadata = message.metadata ?? {};
  return (
    metadata.turn_guidance === true ||
    metadata.turnGuidance === true ||
    String(metadata.name ?? '').trim() === 'turn_guidance'
  );
}

function earliestValidTimestamp(values: unknown[]) {
  let earliest: { value: string; timestamp: number } | undefined;
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) continue;
    if (!earliest || timestamp < earliest.timestamp) {
      earliest = { value, timestamp };
    }
  }
  return earliest?.value;
}

export function timestampDurationMs(startedAt?: string, completedAt?: string) {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  const completed = completedAt ? Date.parse(completedAt) : Number.NaN;
  return Number.isFinite(started) && Number.isFinite(completed) && completed >= started
    ? completed - started
    : undefined;
}
