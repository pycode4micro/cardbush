// Reconcile snapshots and derive visible transcripts. Runtime history remains authoritative.
import type {
  ChatMessage,
  ChatToolExecution,
} from '../../../types';
import {
  chatMessageClientMessageId,
  chatTurnStartedAt,
  chatMessageTurnId,
  findLastIndex,
  normalizeEditableUserContent,
  findPersistedEditableUserMessage,
  isSupersededLoopAssistant,
  messageIdentityMatches,
  isGuidanceSealedAssistantSegment,
  numericOrderValue,
  normalizeLoopContent,
} from './messageFacts';
import {
  shouldPreserveExistingAsLoopHistory,
  mergeLoopHistoryMessages,
  collapseLoopTranscriptMessages,
  collectLoopHistoryFromReplaced,
  attachLoopHistoryToFinalAssistant,
  isBackendSupersededMessage,
  hasIntermediateAssistantSegments,
  isStableVisibleTranscript,
  dedupeVisibleTranscriptMessages,
  collapseIntermediateAssistantSegments,
  hasVisibleLoopHistory,
  snapshotLoopHistoryMessage,
} from './loopHistory';
import {
  mergeToolExecutionLists,
  toolExecutionBelongsToMessage,
} from './toolExecutionMerge';
import {
  hydrateAssistantTurnTiming,
} from '../assistantTurnTiming';
import {
  isGoalSelfCheckMessage,
} from '../../../shared/goalState';

export function mergeMessages(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  incoming: ChatMessage[],
) {
  const byId = new Map((current[sessionId] ?? []).map((item) => [item.id, item]));
  for (const message of incoming) {
    const clientMessageId = chatMessageClientMessageId(message);
    const clientEntry = clientMessageId
      ? [...byId.entries()].find(([, item]) =>
          chatMessageClientMessageId(item) === clientMessageId,
        )
      : undefined;
    const existing = byId.get(message.id) ?? clientEntry?.[1];
    if (clientEntry && clientEntry[0] !== message.id) {
      byId.delete(clientEntry[0]);
    }
    const nextToolExecutions =
      (message.toolExecutions?.length ?? 0) > 0
        ? message.toolExecutions
        : existing?.toolExecutions;
    const preservedVersions =
      existing && shouldPreserveExistingAsLoopHistory(existing, message)
        ? [existing]
        : [];
    const nextLoopHistory = mergeLoopHistoryMessages(
      existing?.loopHistory ?? [],
      [...preservedVersions, ...(message.loopHistory ?? [])],
    );
    byId.set(message.id, {
      ...message,
      attachments: message.attachments ?? existing?.attachments,
      taskPlan: message.taskPlan ?? existing?.taskPlan,
      toolExecutions: nextToolExecutions,
      loopHistory: nextLoopHistory.length > 0 ? nextLoopHistory : undefined,
    });
  }
  return {
    ...current,
    [sessionId]: collapseLoopTranscriptMessages(Array.from(byId.values())),
  };
}

export function mergeFinalStreamMessages(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  incoming: ChatMessage[],
  options: {
    turnId?: string;
    temporaryMessageIds?: string[];
    toolSourceMessageId?: string;
  } = {},
) {
  if (incoming.length === 0) {
    return current;
  }
  const existing = current[sessionId] ?? [];
  const existingById = new Map(existing.map((item) => [item.id, item]));
  const temporaryIds = new Set(options.temporaryMessageIds ?? []);
  const incomingIds = new Set(incoming.map((item) => item.id));
  const incomingTurnIds = new Set(
    incoming
      .map((item) => item.turnId?.trim() ?? '')
      .filter(Boolean),
  );
  const targetTurnId = options.turnId?.trim() ?? '';
  const toolSource = options.toolSourceMessageId
    ? existingById.get(options.toolSourceMessageId)
    : undefined;
  const localToolExecutions = toolSource?.toolExecutions ?? [];
  const completedAt = new Date().toISOString();

  const mergedIncoming = attachLocalToolExecutionsToTranscriptMessages(incoming.map((message) => {
    const exactExistingMessage = existingById.get(message.id);
    const hasSegmentedAssistantSnapshot =
      message.role === 'assistant' &&
      countMessagesInSameRoleTurn(incoming, message) > 1;
    const existingMessage =
      exactExistingMessage ??
      findStreamReplacementSource(existing, message, {
        targetTurnId,
        temporaryIds,
      });
    const existingToolExecutions =
      existingMessage && !temporaryIds.has(existingMessage.id)
        ? existingMessage.toolExecutions
        : undefined;
    return {
      ...message,
      createdAt: existingMessage?.createdAt ?? message.createdAt,
      attachments: message.attachments ?? existingMessage?.attachments,
      metadata: mergeFinalAssistantTimingMetadata(
        message,
        existingMessage,
        completedAt,
        chatTurnStartedAt(
          existing,
          chatMessageTurnId(message) || targetTurnId,
          existingMessage?.createdAt,
        ),
      ),
      toolExecutions:
        (message.toolExecutions?.length ?? 0) > 0
          ? message.toolExecutions
          : existingToolExecutions,
      taskPlan: message.taskPlan ?? existingMessage?.taskPlan,
      loopHistory:
        (message.loopHistory?.length ?? 0) > 0
          ? message.loopHistory
          // A temporary streaming assistant is the aggregate display target for
          // the whole active Turn. Reusing its loopHistory as the fallback for
          // every persisted assistant segment duplicates the complete execution
          // transcript once per segment when Stop reconciles the final snapshot.
          // Once the backend supplied multiple authoritative segments, even a
          // matching final message id can still refer to that aggregate local
          // display target. Do not reattach its history to the final segment.
          : hasSegmentedAssistantSnapshot
            ? undefined
            : exactExistingMessage?.loopHistory,
    };
  }), localToolExecutions);

  if (
    localToolExecutions.length > 0 &&
    !mergedIncoming.some((message) => (message.toolExecutions?.length ?? 0) > 0) &&
    mergedIncoming.filter((message) => message.role === 'assistant').length === 1
  ) {
    const targetIndex = findLastIndex(
      mergedIncoming,
      (message) => message.role === 'assistant',
    );
    if (targetIndex >= 0) {
      const target = mergedIncoming[targetIndex];
      mergedIncoming[targetIndex] = {
        ...target,
        toolExecutions: mergeToolExecutionLists(
          target.toolExecutions ?? [],
          localToolExecutions,
        ),
      };
    }
  }

  const normalizedIncoming = collapseLoopTranscriptMessages(mergedIncoming);
  const segmentedIncoming = normalizedIncoming.some(
    (message) =>
      message.role === 'assistant' &&
      Number.isFinite(Number(message.metadata?.assistant_segment_index)),
  );
  const shouldReplace = (message: ChatMessage) => {
    const messageTurnId = message.turnId?.trim() ?? '';
    if (message.role === 'user') {
      const matchingIncomingUser = normalizedIncoming.find((candidate) => {
        if (candidate.role !== 'user') {
          return false;
        }
        if (candidate.id === message.id) {
          return true;
        }
        const candidateTurnId = candidate.turnId?.trim() ?? '';
        if (messageTurnId && candidateTurnId === messageTurnId) {
          return true;
        }
        return (
          normalizeEditableUserContent(candidate.content) ===
          normalizeEditableUserContent(message.content)
        );
      });
      if (
        incomingIds.has(message.id) ||
        temporaryIds.has(message.id) ||
        (!segmentedIncoming && targetTurnId && messageTurnId === targetTurnId) ||
        Boolean(!segmentedIncoming && messageTurnId && incomingTurnIds.has(messageTurnId))
      ) {
        return Boolean(
          matchingIncomingUser ??
            findPersistedEditableUserMessage(message, normalizedIncoming),
        );
      }
      return false;
    }
    if (
      isRetainedTerminalAssistant(message) &&
      !hasAssistantInSameTurn(normalizedIncoming, message)
    ) {
      return false;
    }
    if (incomingIds.has(message.id) || temporaryIds.has(message.id)) {
      return true;
    }
    if (!segmentedIncoming && targetTurnId && messageTurnId === targetTurnId) {
      return true;
    }
    return Boolean(!segmentedIncoming && messageTurnId && incomingTurnIds.has(messageTurnId));
  };

  const replacedMessages = existing.filter(shouldReplace);
  const loopHistory = collectLoopHistoryFromReplaced(
    replacedMessages,
    normalizedIncoming,
    temporaryIds,
  );
  if (loopHistory.length > 0) {
    attachLoopHistoryToFinalAssistant(normalizedIncoming, loopHistory);
  }

  const replaceIndex = existing.findIndex(shouldReplace);
  const kept = existing.filter((message) => !shouldReplace(message));
  const insertAt = replaceIndex < 0
    ? kept.length
    : existing.slice(0, replaceIndex).filter((message) => !shouldReplace(message)).length;
  const nextMessages = [...kept];
  nextMessages.splice(insertAt, 0, ...normalizedIncoming);
  return {
    ...current,
    [sessionId]: collapseLoopTranscriptMessages(nextMessages),
  };
}

function mergeFinalAssistantTimingMetadata(
  message: ChatMessage,
  existingMessage: ChatMessage | undefined,
  completedAt: string,
  turnStartedAt?: string,
) {
  if (message.role !== 'assistant' || isSupersededLoopAssistant(message)) {
    return message.metadata;
  }
  return {
    ...(message.metadata ?? {}),
    cardbush_turn_started_at:
      turnStartedAt ??
      message.metadata?.cardbush_turn_started_at ??
      existingMessage?.metadata?.cardbush_turn_started_at ??
      existingMessage?.createdAt ??
      message.createdAt,
    cardbush_turn_completed_at:
      message.metadata?.cardbush_turn_completed_at ??
      existingMessage?.metadata?.cardbush_turn_completed_at ??
      completedAt,
  };
}

function attachLocalToolExecutionsToTranscriptMessages(
  messages: ChatMessage[],
  localToolExecutions: ChatToolExecution[],
) {
  if (localToolExecutions.length === 0) {
    return messages;
  }
  return messages.map((message) => {
    if (message.role !== 'assistant') {
      return message;
    }
    const matchedExecutions = localToolExecutions.filter((execution) =>
      toolExecutionBelongsToMessage(message, execution),
    );
    if (matchedExecutions.length === 0) {
      return message;
    }
    return {
      ...message,
      toolExecutions: mergeToolExecutionLists(
        message.toolExecutions ?? [],
        matchedExecutions,
      ),
    };
  });
}

export function mergeLoadedMessagesPreservingLocalState(
  existing: ChatMessage[],
  loaded: ChatMessage[],
) {
  if (existing.length === 0) {
    return collapseLoopTranscriptMessages(loaded);
  }
  if (loaded.length === 0) {
    return collapseLoopTranscriptMessages(existing);
  }
  const merged = loaded.map((message) => {
    const source = findLocalMessageStateSource(existing, message);
    if (!source) {
      return message;
    }
    const localTranscriptInheritance = localTranscriptCollectionInheritance(
      source,
      message,
      loaded,
    );
    const sourceToolExecutions = source.toolExecutions ?? [];
    const inheritedToolExecutions =
      countMessagesInSameRoleTurn(loaded, message) > 1
        ? sourceToolExecutions.filter((execution) =>
            toolExecutionBelongsToMessage(message, execution),
          )
        : localTranscriptInheritance.toolExecutions
          ? sourceToolExecutions
          : [];
    return {
      ...message,
      // A terminal refresh may persist the user/assistant rows at slightly
      // different wall-clock times than the optimistic transcript. Keep the
      // established local timestamp so Stop cannot move the user bubble below
      // the assistant execution it originally preceded.
      createdAt: source.createdAt ?? message.createdAt,
      metadata: preserveLocalAssistantTimingMetadata(message, source),
      attachments: message.attachments ?? source.attachments,
      taskPlan: message.taskPlan ?? source.taskPlan,
      toolExecutions: mergeToolExecutionLists(
        message.toolExecutions ?? [],
        inheritedToolExecutions,
      ),
      loopHistory:
        (message.loopHistory?.length ?? 0) > 0
          ? message.loopHistory
          : localTranscriptInheritance.loopHistory
            ? source.loopHistory
            : undefined,
    };
  });
  const retainedTerminalAssistants = existing.filter((message) =>
    isRetainedTerminalAssistant(message) &&
      !hasAssistantInSameTurn(merged, message),
  );
  for (const retained of retainedTerminalAssistants) {
    const turnId = chatMessageTurnId(retained);
    const lastTurnIndex = findLastIndex(
      merged,
      (candidate) => Boolean(turnId) && chatMessageTurnId(candidate) === turnId,
    );
    merged.splice(lastTurnIndex >= 0 ? lastTurnIndex + 1 : merged.length, 0, retained);
  }
  return collapseLoopTranscriptMessages(merged);
}

function localTranscriptCollectionInheritance(
  source: ChatMessage,
  message: ChatMessage,
  loaded: ChatMessage[],
) {
  const sameRoleTurnCount = countMessagesInSameRoleTurn(loaded, message);
  let preciseIdentity = messageIdentityMatches(source, message);
  const sourceAssistantId = source.assistantMessageId?.trim() ?? '';
  const messageAssistantId = message.assistantMessageId?.trim() ?? '';
  if (
    sourceAssistantId &&
    messageAssistantId &&
    sourceAssistantId === messageAssistantId
  ) {
    preciseIdentity = true;
  }
  const turnId = chatMessageTurnId(message);
  if (!turnId) {
    return {
      toolExecutions: preciseIdentity,
      loopHistory: preciseIdentity,
    };
  }
  // A legacy final snapshot can replace one optimistic assistant without a
  // shared message id. That fallback is safe only when the backend returned a
  // single assistant for the Turn. With multiple loop segments, assigning the
  // aggregate local collections to every row is precisely the duplication this
  // guard prevents.
  const uniqueTurnMessage = sameRoleTurnCount === 1;
  return {
    toolExecutions: preciseIdentity || uniqueTurnMessage,
    // loopHistory on a local streaming assistant is an aggregate of its prior
    // loop segments. A multi-segment backend snapshot already contains those
    // rows, so inheriting it on the matching final row would render them twice.
    loopHistory: uniqueTurnMessage,
  };
}

function countMessagesInSameRoleTurn(
  messages: ChatMessage[],
  reference: ChatMessage,
) {
  const turnId = chatMessageTurnId(reference);
  if (!turnId) {
    return 0;
  }
  return messages.filter(
    (candidate) =>
      candidate.role === reference.role && chatMessageTurnId(candidate) === turnId,
  ).length;
}

function isRetainedTerminalAssistant(message: ChatMessage) {
  if (
    message.role !== 'assistant' ||
    message.metadata?.cardbush_terminal_snapshot !== true
  ) {
    return false;
  }
  const status = String(message.status ?? message.metadata?.status ?? '')
    .trim()
    .toLowerCase();
  return (
    status === 'failed' ||
    status === 'stopped' ||
    message.metadata?.cardbush_terminal_stopped === true
  );
}

function hasAssistantInSameTurn(
  messages: ChatMessage[],
  reference: ChatMessage,
) {
  const turnId = chatMessageTurnId(reference);
  return Boolean(
    turnId && messages.some(
      (message) =>
        message.role === 'assistant' && chatMessageTurnId(message) === turnId,
    ),
  );
}

function preserveLocalAssistantTimingMetadata(
  message: ChatMessage,
  source: ChatMessage,
) {
  if (message.role !== 'assistant') {
    return message.metadata;
  }
  return {
    ...(message.metadata ?? {}),
    ...(source.metadata?.cardbush_terminal_snapshot === true
      ? {
          cardbush_terminal_snapshot: true,
          cardbush_terminal_stopped:
            message.metadata?.stopped === true ||
            source.metadata?.cardbush_terminal_stopped === true,
          status: message.metadata?.status ?? source.metadata?.status,
          stopped: message.metadata?.stopped ?? source.metadata?.stopped,
          stop_reason:
            message.metadata?.stop_reason ?? source.metadata?.stop_reason,
          stop_scenario:
            message.metadata?.stop_scenario ?? source.metadata?.stop_scenario,
          stop_details:
            message.metadata?.stop_details ?? source.metadata?.stop_details,
          terminal_event_sequence:
            message.metadata?.terminal_event_sequence ??
            source.metadata?.terminal_event_sequence,
        }
      : {}),
    cardbush_turn_started_at:
      message.metadata?.cardbush_turn_started_at ??
      source.metadata?.cardbush_turn_started_at ??
      source.createdAt ??
      message.createdAt,
    cardbush_turn_completed_at:
      message.metadata?.cardbush_turn_completed_at ??
      source.metadata?.cardbush_turn_completed_at,
  };
}

const normalizedChatMessageDisplayCache = new WeakMap<
  ChatMessage[],
  ChatMessage[]
>();

export function normalizeChatMessagesForDisplay(messages: ChatMessage[]) {
  const cached = normalizedChatMessageDisplayCache.get(messages);
  if (cached) return cached;
  const timedMessages = hydrateAssistantTurnTiming(messages);
  const visibleMessages = timedMessages.filter(
    (message) =>
      !isGoalSelfCheckMessage(message) && !isBackendSupersededMessage(message),
  );
  const hasIntermediateSegments = hasIntermediateAssistantSegments(visibleMessages);
  if (isStableVisibleTranscript(visibleMessages) && !hasIntermediateSegments) {
    normalizedChatMessageDisplayCache.set(messages, visibleMessages);
    return visibleMessages;
  }
  const normalized = dedupeVisibleTranscriptMessages(
    collapseIntermediateAssistantSegments(
      collapseLoopTranscriptMessages(visibleMessages),
    ),
  );
  normalizedChatMessageDisplayCache.set(messages, normalized);
  return normalized;
}

export function mergePolledMessagesPreservingLocalState(
  existing: ChatMessage[],
  loaded: ChatMessage[],
) {
  if (loaded.length === 0) {
    return existing;
  }
  const hydrated = mergeLoadedMessagesPreservingLocalState(existing, loaded);
  return collapseLoopTranscriptMessages([...existing, ...hydrated]);
}

/**
 * While a turn is running, present every assistant segment as one continuous
 * transcript. Persisted/final normalization still owns the completed state;
 * this projection exists only for the active turn and therefore disappears as
 * soon as the terminal `done` event clears `sending`.
 */
export function normalizeActiveTurnTranscriptForDisplay(
  messages: ChatMessage[],
  activeTurnId: string,
) {
  const turnId = activeTurnId.trim();
  if (!turnId) {
    return messages;
  }
  const activeAssistantIndex = findLastIndex(
    messages,
    (message) =>
      message.role === 'assistant' && chatMessageTurnId(message) === turnId,
  );
  if (activeAssistantIndex < 0) {
    return messages;
  }
  const activeAssistant = messages[activeAssistantIndex];
  const siblingIndexes = messages
    .map((message, index) => ({ message, index }))
    .filter(
      ({ message, index }) =>
        index !== activeAssistantIndex &&
        message.role === 'assistant' &&
        chatMessageTurnId(message) === turnId &&
        !isGuidanceSealedAssistantSegment(message) &&
        hasVisibleLoopHistory(message),
    );
  if (siblingIndexes.length === 0) {
    return messages;
  }
  const siblingIndexSet = new Set(siblingIndexes.map(({ index }) => index));
  const siblingMessages = siblingIndexes.map(({ message }) =>
    snapshotLoopHistoryMessage(message),
  );
  const stableDisplayId = siblingIndexes[0]?.message.id ?? activeAssistant.id;
  const inheritedPlan = [...siblingMessages]
    .reverse()
    .find((message) => message.taskPlan)?.taskPlan;
  const mergedAssistant: ChatMessage = {
    ...activeAssistant,
    // The latest Runtime segment owns the live facts, but the first visible
    // segment owns the React row identity. Keeping that identity stable avoids
    // remounting and reparsing the complete Turn transcript on every segment.
    id: stableDisplayId,
    taskPlan: activeAssistant.taskPlan ?? inheritedPlan,
    loopHistory: mergeLoopHistoryMessages(
      activeAssistant.loopHistory ?? [],
      siblingMessages,
    ),
  };
  return messages.flatMap((message, index) => {
    if (siblingIndexSet.has(index)) {
      return [];
    }
    return [index === activeAssistantIndex ? mergedAssistant : message];
  });
}

function findLocalMessageStateSource(existing: ChatMessage[], message: ChatMessage) {
  const byId = existing.find((item) => item.id === message.id);
  if (byId) {
    return byId;
  }
  const clientMessageId = chatMessageClientMessageId(message);
  if (clientMessageId) {
    const byClientMessageId = existing.find(
      (item) => chatMessageClientMessageId(item) === clientMessageId,
    );
    if (byClientMessageId) return byClientMessageId;
  }
  const turnId = message.turnId?.trim() ?? '';
  if (!turnId) {
    return undefined;
  }
  return [...existing].reverse().find((item) => {
    if (item.role !== message.role) {
      return false;
    }
    const assistantMessageId = message.assistantMessageId?.trim() ?? '';
    if (
      assistantMessageId &&
      (item.assistantMessageId?.trim() ?? item.id) === assistantMessageId
    ) {
      return true;
    }
    if ((item.turnId?.trim() ?? '') !== turnId) {
      return false;
    }
    if (isRetainedTerminalAssistant(item)) {
      return true;
    }
    return (
      messagesShareTranscriptPosition(item, message) ||
      (item.loopHistory?.length ?? 0) > 0 ||
      (item.toolExecutions?.length ?? 0) > 0
    );
  });
}

function messagesShareTranscriptPosition(
  left: ChatMessage,
  right: ChatMessage,
) {
  if (left.role !== right.role) {
    return false;
  }
  const leftTurn = chatMessageTurnId(left);
  const rightTurn = chatMessageTurnId(right);
  if (!leftTurn || leftTurn !== rightTurn) {
    return false;
  }
  const leftMessageIndex = numericOrderValue(left.messageIndex);
  const rightMessageIndex = numericOrderValue(right.messageIndex);
  if (leftMessageIndex != null && rightMessageIndex != null) {
    return leftMessageIndex === rightMessageIndex;
  }
  const leftTurnSequence = numericOrderValue(left.turnSequence);
  const rightTurnSequence = numericOrderValue(right.turnSequence);
  if (
    leftTurnSequence != null &&
    rightTurnSequence != null &&
    leftTurnSequence !== rightTurnSequence
  ) {
    return false;
  }
  return normalizeLoopContent(left.content) === normalizeLoopContent(right.content);
}

function findStreamReplacementSource(
  existing: ChatMessage[],
  incoming: ChatMessage,
  {
    targetTurnId,
    temporaryIds,
  }: {
    targetTurnId: string;
    temporaryIds: Set<string>;
  },
) {
  const incomingTurnId = incoming.turnId?.trim() || targetTurnId;
  if (!incomingTurnId) {
    return undefined;
  }
  const candidates = existing.filter((message) => {
    if (message.role !== incoming.role) {
      return false;
    }
    const messageTurnId = message.turnId?.trim() ?? '';
    return messageTurnId === incomingTurnId || temporaryIds.has(message.id);
  });
  return (
    candidates.find((message) => temporaryIds.has(message.id)) ??
    candidates.at(-1)
  );
}
