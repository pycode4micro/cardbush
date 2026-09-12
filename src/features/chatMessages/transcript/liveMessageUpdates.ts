// Apply live events to message collections. Callers own subscriptions and React commits.
import type {
  ChatMessage,
  StreamExecutionUpdate,
  AssistantRevision,
  TurnTerminalSnapshot,
  ChatToolExecution,
  TaskPlanStreamUpdate,
} from '../../../types';
import type {
  AssistantStreamRoute,
  AssistantStreamBufferRelease,
} from './assistantStreamBuffer';
import {
  chatTurnStartedAt,
  chatMessageTurnId,
  isSupersededLoopAssistant,
  normalizeLoopContent,
  timestampDurationMs,
  optionalFiniteNumber,
} from './messageFacts';
import {
  mergeLoopHistoryMessages,
  localLoopHistorySnapshot,
  hasVisibleLoopHistory,
} from './loopHistory';
import {
  mergeToolExecutionUpdate,
} from './toolExecutionMerge';

export function markOptimisticChatRequestAccepted(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  userMessageId: string,
) {
  return {
    ...current,
    [sessionId]: (current[sessionId] ?? []).map((message) =>
      message.id === userMessageId
        ? {
            ...message,
            status: 'sent',
            metadata: {
              ...(message.metadata ?? {}),
              message_delivery: 'accepted',
            },
          }
        : message,
    ),
  };
}

export function markOptimisticChatRequestFailed(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  userMessageId: string,
  assistantMessageId: string,
) {
  return {
    ...current,
    [sessionId]: (current[sessionId] ?? [])
      .filter((message) => message.id !== assistantMessageId)
      .map((message) =>
        message.id === userMessageId
          ? {
              ...message,
              status: 'failed',
              metadata: {
                ...(message.metadata ?? {}),
                message_delivery: 'failed',
              },
            }
          : message,
      ),
  };
}

export function appendAssistantDelta(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  assistantId: string,
  delta: string,
  route?: AssistantStreamRoute,
  release?: AssistantStreamBufferRelease,
) {
  const messages = [...(current[sessionId] ?? [])];
  const targetIndex = assistantStreamTargetIndex(messages, assistantId, route);
  if (targetIndex < 0) {
    const message = createAssistantStreamMessage(messages, sessionId, route);
    messages.push({
      ...message,
      content: delta,
      metadata: {
        ...message.metadata,
        ...assistantStreamReleaseMetadata(release),
      },
    });
    return { ...current, [sessionId]: messages };
  }
  return {
    ...current,
    [sessionId]: messages.map((message, index) => {
      if (index !== targetIndex) {
        return message;
      }
      const routed = applyAssistantStreamRoute(message, route);
      if (!route?.messageId && shouldStartNextLocalAssistantSegment(routed, delta)) {
        const loopHistory = mergeLoopHistoryMessages(
          routed.loopHistory ?? [],
          [localLoopHistorySnapshot(routed)],
        );
        return {
          ...routed,
          content: delta,
          toolExecutions: undefined,
          loopHistory: loopHistory.length > 0 ? loopHistory : undefined,
          metadata: {
            ...(routed.metadata ?? {}),
            ...assistantStreamReleaseMetadata(release),
          },
        };
      }
      return {
        ...routed,
        content: appendAssistantTextAfterToolBoundary(routed, delta),
        metadata: {
          ...(routed.metadata ?? {}),
          ...assistantStreamReleaseMetadata(release),
        },
      };
    }),
  };
}

export function appendAssistantTextAfterToolBoundary(
  message: ChatMessage,
  delta: string,
) {
  const content = message.content;
  if (!content.trim() || !delta.trim() || /\r?\n\s*$/.test(content) || /^\s/.test(delta)) {
    return `${content}${delta}`;
  }
  const latestToolOffset = Math.max(
    -1,
    ...(message.toolExecutions ?? []).map((execution) => execution.contentOffset),
  );
  return latestToolOffset >= content.length
    ? `${content}\n\n${delta}`
    : `${content}${delta}`;
}

export function applyAssistantSegmentBoundary(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  fallbackAssistantId: string,
  update: StreamExecutionUpdate,
) {
  const messages = [...(current[sessionId] ?? [])];
  if (update.guidanceMessageId) {
    const guidanceMessageId = update.guidanceMessageId.trim();
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (
        message.role === 'user' &&
        (message.id === guidanceMessageId ||
          message.clientMessageId === guidanceMessageId ||
          String(message.metadata?.client_message_id ?? '') === guidanceMessageId)
      ) {
        messages[index] = {
          ...message,
          messageId: guidanceMessageId,
          status: 'sent',
          metadata: {
            ...(message.metadata ?? {}),
            guidance_delivery: 'sent',
          },
        };
      }
    }
  }
  const nextSegmentIndex =
    update.nextAssistantSegmentIndex ?? update.assistantSegmentIndex;
  const previousSegmentIndex =
    update.previousAssistantSegmentIndex ??
    (nextSegmentIndex != null && nextSegmentIndex > 1
      ? nextSegmentIndex - 1
      : undefined);
  const previousIndex = assistantStreamTargetIndex(messages, fallbackAssistantId, {
    messageId: update.previousAssistantMessageId ?? '',
    assistantSegmentIndex: previousSegmentIndex,
    turnId: update.turnId,
  });
  if (previousIndex >= 0 && messages[previousIndex].role === 'assistant') {
    const previous = messages[previousIndex];
    messages[previousIndex] = {
      ...previous,
      status: 'completed',
      metadata: {
        ...(previous.metadata ?? {}),
        status: 'completed',
        segment_complete: true,
        segment_boundary: 'turn_guidance',
        ...(nextSegmentIndex != null
          ? { next_assistant_segment_index: nextSegmentIndex }
          : {}),
      },
    };
  }

  const nextMessageId = update.messageId.trim();
  if (nextSegmentIndex == null || nextSegmentIndex <= 1) {
    return { ...current, [sessionId]: messages };
  }
  const nextIndex = assistantStreamTargetIndex(messages, fallbackAssistantId, {
    messageId: nextMessageId,
    assistantSegmentIndex: nextSegmentIndex,
    turnId: update.turnId,
  });
  if (nextIndex < 0) {
    const turnStartedAt = chatTurnStartedAt(messages, update.turnId);
    messages.push({
      id:
        nextMessageId ||
        `assistant-${update.turnId || sessionId}-segment-${nextSegmentIndex}`,
      messageId: nextMessageId || undefined,
      assistantMessageId: nextMessageId || undefined,
      role: 'assistant',
      content: '',
      conversationId: sessionId,
      turnId: update.turnId || undefined,
      createdAt: update.createdAt || new Date().toISOString(),
      status: 'streaming',
      metadata: {
        assistant_segment_index: nextSegmentIndex,
        ...(nextMessageId ? { message_id: nextMessageId } : {}),
        ...(turnStartedAt ? { cardbush_turn_started_at: turnStartedAt } : {}),
      },
    });
  }
  return { ...current, [sessionId]: messages };
}

export function optimisticGuidanceMessage({
  clientMessageId,
  conversationId,
  turnId,
  content,
  mode,
}: {
  clientMessageId: string;
  conversationId: string;
  turnId: string;
  content: string;
  mode: 'append_context' | 'interrupt_and_continue';
}): ChatMessage {
  return {
    id: clientMessageId,
    clientMessageId,
    role: 'user',
    content,
    conversationId,
    turnId,
    createdAt: new Date().toISOString(),
    status: 'pending',
    metadata: {
      turn_guidance: true,
      client_message_id: clientMessageId,
      guidance_mode: mode,
      guidance_delivery: 'pending',
    },
  };
}

export function reconcileOptimisticGuidance(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  localClientMessageId: string,
  acceptedClientMessageId: string,
) {
  const clientMessageId = acceptedClientMessageId.trim() || localClientMessageId;
  return {
    ...current,
    [sessionId]: (current[sessionId] ?? []).map((message) =>
      message.id === localClientMessageId || message.clientMessageId === localClientMessageId
        ? {
            ...message,
            clientMessageId,
            status: 'queued',
            metadata: {
              ...(message.metadata ?? {}),
              client_message_id: clientMessageId,
              guidance_delivery: 'queued',
            },
          }
        : message,
    ),
  };
}

export function markOptimisticGuidanceFailed(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  clientMessageId: string,
) {
  return {
    ...current,
    [sessionId]: (current[sessionId] ?? []).map((message) =>
      message.id === clientMessageId || message.clientMessageId === clientMessageId
        ? {
            ...message,
            status: 'failed',
            metadata: {
              ...(message.metadata ?? {}),
              guidance_delivery: 'failed',
            },
          }
        : message,
    ),
  };
}

export function markOptimisticGuidancePending(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  clientMessageId: string,
) {
  return {
    ...current,
    [sessionId]: (current[sessionId] ?? []).map((message) =>
      message.id === clientMessageId || message.clientMessageId === clientMessageId
        ? {
            ...message,
            status: 'pending',
            metadata: {
              ...(message.metadata ?? {}),
              guidance_delivery: 'pending',
            },
          }
        : message,
    ),
  };
}

export function removeOptimisticGuidance(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  clientMessageId: string,
) {
  return {
    ...current,
    [sessionId]: (current[sessionId] ?? []).filter(
      (message) =>
        message.id !== clientMessageId && message.clientMessageId !== clientMessageId,
    ),
  };
}

export function ensureBackgroundTurnAssistant(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  assistantId: string,
  turnId: string,
  createdAt?: string,
) {
  const messages = current[sessionId] ?? [];
  if (messages.some((message) => message.id === assistantId)) {
    return current;
  }
  return {
    ...current,
    [sessionId]: [
      ...messages,
      {
        id: assistantId,
        role: 'assistant' as const,
        content: '',
        conversationId: sessionId,
        turnId,
        createdAt: createdAt || new Date().toISOString(),
        metadata: {
          background_turn: true,
          goal_auto_continuation: true,
        },
      },
    ],
  };
}

function assistantStreamTargetIndex(
  messages: ChatMessage[],
  fallbackAssistantId: string,
  route?: AssistantStreamRoute,
) {
  const messageId = route?.messageId.trim() ?? '';
  if (messageId) {
    const exact = messages.findIndex((message) => assistantMessageMatchesRoute(message, messageId));
    if (exact >= 0) return exact;
    // Runtime message identity is stronger than a content-block ordinal, which
    // restarts within each model round. Only an unbound local placeholder can
    // adopt a new identity; never rename and append to an earlier bound reply.
    const placeholder = messages.findIndex((message) =>
      message.role === 'assistant' &&
      !message.messageId?.trim() &&
      !message.assistantMessageId?.trim() &&
      !String(message.metadata?.message_id ?? '').trim() &&
      (!chatMessageTurnId(message) || chatMessageTurnId(message) === route?.turnId) &&
      (
        route?.assistantSegmentIndex != null
          ? Number(message.metadata?.assistant_segment_index) === route.assistantSegmentIndex ||
            (message.id === fallbackAssistantId && message.metadata?.assistant_segment_index == null)
          : message.id === fallbackAssistantId
      ),
    );
    return placeholder;
  }
  const segmentIndex = route?.assistantSegmentIndex;
  if (segmentIndex != null) {
    const exactSegment = messages.findIndex((message) =>
      message.role === 'assistant' &&
      chatMessageTurnId(message) === route?.turnId &&
      Number(message.metadata?.assistant_segment_index) === segmentIndex,
    );
    if (exactSegment >= 0) return exactSegment;
    if (segmentIndex > 1) return -1;
  }
  return messages.findIndex((message) => message.id === fallbackAssistantId);
}

function assistantMessageMatchesRoute(message: ChatMessage, messageId: string) {
  return message.role === 'assistant' && Boolean(messageId) && (
    message.id === messageId ||
    message.messageId === messageId ||
    message.assistantMessageId === messageId ||
    String(message.metadata?.message_id ?? '') === messageId
  );
}

function createAssistantStreamMessage(
  messages: ChatMessage[],
  sessionId: string,
  route?: AssistantStreamRoute,
): ChatMessage {
  const messageId = route?.messageId.trim() ?? '';
  const turnStartedAt = chatTurnStartedAt(messages, route?.turnId);
  return {
    id: messageId || `assistant-${route?.turnId || sessionId}-segment-${route?.assistantSegmentIndex ?? 1}`,
    messageId: messageId || undefined,
    assistantMessageId: messageId || undefined,
    role: 'assistant',
    content: '',
    conversationId: sessionId,
    turnId: route?.turnId || undefined,
    createdAt: route?.createdAt || new Date().toISOString(),
    sequence: route?.sequence,
    metadata: {
      ...(route?.assistantSegmentIndex != null ? { assistant_segment_index: route.assistantSegmentIndex } : {}),
      ...(messageId ? { message_id: messageId } : {}),
      ...(turnStartedAt ? { cardbush_turn_started_at: turnStartedAt } : {}),
    },
  };
}

export function applyAssistantStreamRoute(
  message: ChatMessage,
  route?: AssistantStreamRoute,
): ChatMessage {
  if (!route) return message;
  const messageId = route.messageId.trim();
  return {
    ...message,
    messageId: messageId || message.messageId,
    assistantMessageId: messageId || message.assistantMessageId,
    turnId: route.turnId || message.turnId,
    createdAt: message.createdAt ?? route.createdAt,
    sequence: message.sequence == null ? route.sequence :
      route.sequence == null ? message.sequence : Math.min(message.sequence, route.sequence),
    metadata: {
      ...(message.metadata ?? {}),
      ...(messageId ? { message_id: messageId } : {}),
      ...(route.assistantSegmentIndex != null
        ? { assistant_segment_index: route.assistantSegmentIndex }
        : {}),
    },
  };
}

function assistantStreamReleaseMetadata(
  release?: AssistantStreamBufferRelease,
): Record<string, unknown> {
  if (!release) return {};
  return {
    assistant_stream_release: release.reason,
    ...(release.reason === 'segment_completed' ? { segment_complete: true } : {}),
    ...(release.segmentId ? { assistant_segment_id: release.segmentId } : {}),
    ...(release.segmentOrdinal != null
      ? { assistant_stream_segment_ordinal: release.segmentOrdinal }
      : {}),
  };
}

function shouldStartNextLocalAssistantSegment(message: ChatMessage, delta: string) {
  return (
    message.role === 'assistant' &&
    delta.trim().length > 0 &&
    (message.toolExecutions?.length ?? 0) > 0 &&
    hasVisibleLoopHistory(message)
  );
}

export function applyAssistantRevision(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  assistantId: string,
  revision: AssistantRevision,
) {
  const messages = current[sessionId] ?? [];
  const revisionTurnId = revision.turnId?.trim() ?? '';
  const isClear = revision.action === 'clear' || revision.action === 'replace';
  if (!isClear) {
    return current;
  }
  const nextContent = revision.content ?? '';
  if (revision.reason === 'tool_preamble' && !nextContent.trim()) {
    return current;
  }
  const route: AssistantStreamRoute = {
    messageId: revision.messageId ?? '',
    assistantSegmentIndex: revision.assistantSegmentIndex,
    turnId: revisionTurnId,
  };
  const targetIndex = assistantStreamTargetIndex(messages, assistantId, route);
  if (
    targetIndex < 0 &&
    nextContent &&
    (route.messageId || (route.assistantSegmentIndex ?? 1) > 1)
  ) {
    return applyAssistantRevision(
      appendAssistantDelta(current, sessionId, assistantId, nextContent, route),
      sessionId,
      assistantId,
      revision,
    );
  }
  return {
    ...current,
    [sessionId]: messages.map((message, index) => {
      if (index !== targetIndex) {
        return message;
      }
      const routed = applyAssistantStreamRoute(message, route);
      const shouldPreserveCurrent =
        routed.role === 'assistant' &&
        !isSupersededLoopAssistant(routed) &&
        hasVisibleLoopHistory(routed) &&
        (normalizeLoopContent(routed.content) !== normalizeLoopContent(nextContent) ||
          revision.reason === 'tool_preamble' ||
          revision.reason === 'assistant_final');
      const loopHistory = shouldPreserveCurrent
        ? mergeLoopHistoryMessages(
            routed.loopHistory ?? [],
            [localLoopHistorySnapshot(routed)],
          )
        : routed.loopHistory;
      return {
        ...routed,
        content: nextContent,
        loopIndex: revision.loopIndex ?? routed.loopIndex,
        toolExecutions: shouldPreserveCurrent ? undefined : routed.toolExecutions,
        loopHistory:
          loopHistory && loopHistory.length > 0 ? loopHistory : undefined,
        metadata: {
          ...(routed.metadata ?? {}),
          assistant_channel: 'assistant',
          transcript_kind:
            revision.reason === 'assistant_final'
              ? 'assistant_final'
              : revision.reason === 'tool_preamble'
                ? 'assistant_segment'
                : routed.metadata?.transcript_kind,
        },
      };
    }),
  };
}

export function assignTurnToLocalMessages(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  turnId: string,
  messageIds: string[],
  route?: AssistantStreamRoute,
  userMessageId?: string,
) {
  const ids = new Set(messageIds);
  const messages = current[sessionId] ?? [];
  const startedAt = chatTurnStartedAt(
    messages.filter((message) => ids.has(message.id)),
    undefined,
  ) ?? new Date().toISOString();
  return {
    ...current,
    [sessionId]: messages.map((message) =>
      ids.has(message.id)
        ? markLocalMessageTurnStarted(
            applyAssistantStreamRoute(
              { ...message, turnId: message.role === 'user' && message.messageId && !userMessageId ? message.turnId : turnId, conversationId: sessionId,
                ...(message.role === 'user' && userMessageId ? { messageId: userMessageId } : {}) },
              message.role === 'assistant' ? route : undefined,
            ),
            startedAt,
          )
        : message,
    ),
  };
}

export function markLocalMessageTurnStarted(message: ChatMessage, startedAt: string) {
  if (message.role !== 'assistant') {
    return message;
  }
  return {
    ...message,
    metadata: {
      ...(message.metadata ?? {}),
      cardbush_turn_started_at:
        message.metadata?.cardbush_turn_started_at ??
        message.createdAt ??
        startedAt,
    },
  };
}

export function markLocalAssistantTurnCompleted(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  assistantId: string,
  completedAt: string,
  route?: AssistantStreamRoute,
  finalText = '',
) {
  const messages = current[sessionId] ?? [];
  const targetIndex = assistantStreamTargetIndex(messages, assistantId, route);
  if (targetIndex < 0 && finalText) {
    return markLocalAssistantTurnCompleted(
      appendAssistantDelta(current, sessionId, assistantId, finalText, route),
      sessionId,
      assistantId,
      completedAt,
      route,
    );
  }
  return {
    ...current,
    [sessionId]: messages.map((message, index) => {
      if (index !== targetIndex || message.role !== 'assistant') {
        return message;
      }
      const routed = applyAssistantStreamRoute(message, route);
      const startedAt = chatTurnStartedAt(
        messages,
        chatMessageTurnId(routed),
        routed.createdAt,
      );
      return {
        ...routed,
        content: finalText || routed.content,
        metadata: {
          ...(routed.metadata ?? {}),
          transcript_kind: 'assistant_final',
          cardbush_turn_started_at:
            startedAt ?? routed.metadata?.cardbush_turn_started_at ?? routed.createdAt,
          cardbush_turn_completed_at:
            routed.metadata?.cardbush_turn_completed_at ?? completedAt,
        },
      };
    }),
  };
}

export function applyTurnTerminalSnapshot(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  fallbackAssistantId: string,
  terminal: TurnTerminalSnapshot,
) {
  const turnId = terminal.turnId.trim();
  const completedAt = terminal.completedAt ?? new Date().toISOString();
  const messages = current[sessionId] ?? [];
  const terminalStatus = terminal.stopped
    ? 'stopped'
    : terminal.status === 'failed'
      ? 'failed'
      : 'completed';
  const turnStartedAt = chatTurnStartedAt(messages, turnId);
  const turnDurationMs = timestampDurationMs(turnStartedAt, completedAt);
  const terminalMetadata = (message?: ChatMessage) => ({
    ...(message?.metadata ?? {}),
    status: terminal.status,
    stopped: terminal.stopped,
    stop_reason: terminal.stopReason,
    stop_scenario: terminal.stopScenario,
    ...(terminal.stopDetails ? { stop_details: terminal.stopDetails } : {}),
    ...(terminal.terminalEventSequence != null
      ? { terminal_event_sequence: terminal.terminalEventSequence }
      : {}),
    cardbush_terminal_snapshot: true,
    cardbush_terminal_stopped: terminal.stopped,
    cardbush_turn_started_at:
      turnStartedAt ??
      message?.metadata?.cardbush_turn_started_at ??
      message?.createdAt ??
      completedAt,
    cardbush_turn_completed_at: completedAt,
    ...(turnDurationMs != null ? { cardbush_turn_duration_ms: turnDurationMs } : {}),
  });
  let matchedAssistant = false;
  const nextMessages = messages.map((message) => {
    const belongsToTurn = turnId && chatMessageTurnId(message) === turnId;
    if (
      message.role !== 'assistant' ||
      (!belongsToTurn && message.id !== fallbackAssistantId)
    ) {
      return message;
    }
    matchedAssistant = true;
    return {
      ...message,
      status: terminalStatus,
      metadata: terminalMetadata(message),
    };
  });
  if (!matchedAssistant && terminalStatus === 'failed') {
    nextMessages.push({
      id: fallbackAssistantId || `assistant-terminal-${turnId || completedAt}`,
      role: 'assistant',
      content: '',
      conversationId: sessionId,
      turnId: turnId || undefined,
      createdAt: completedAt,
      status: 'failed',
      metadata: terminalMetadata(),
    });
  }
  return {
    ...current,
    [sessionId]: nextMessages,
  };
}

export function appendToolExecution(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  assistantId: string,
  execution: ChatToolExecution,
) {
  const messages = [...(current[sessionId] ?? [])];
  const executionRoute = assistantRouteFromToolExecution(execution);
  // Enrichment can arrive after the owner has moved into loopHistory, or without
  // its original route. Update that execution in place before resolving a new call.
  const owner = findTranscriptAssistant(messages, message =>
    (!executionRoute.turnId || chatMessageTurnId(message) === executionRoute.turnId) &&
    Boolean(message.toolExecutions?.some(item => item.id === execution.id)),
  ) ?? findTranscriptAssistant(messages, message =>
    assistantMessageMatchesRoute(message, executionRoute.messageId),
  );
  if (owner) {
    return {
      ...current,
      [sessionId]: messages.map(message => updateTranscriptToolOwner(message, owner, execution)),
    };
  }
  // Text and Tools share one identity resolver. A tool-only model round is still
  // a new assistant message, even though it has no assistant_segment events.
  let targetIndex = assistantStreamTargetIndex(messages, assistantId, executionRoute);
  if (
    !executionRoute.messageId && executionRoute.assistantSegmentIndex == null &&
    execution.loopIndex != null && executionRoute.turnId
  ) {
    const loopTarget = messages.findIndex(message =>
      message.role === 'assistant' && chatMessageTurnId(message) === executionRoute.turnId &&
      message.loopIndex === execution.loopIndex,
    );
    if (loopTarget >= 0) targetIndex = loopTarget;
  }
  if (targetIndex < 0) {
    targetIndex = messages.length;
    messages.push(createAssistantStreamMessage(messages, sessionId, executionRoute));
  }
  messages[targetIndex] = appendToolToAssistant(
    applyAssistantStreamRoute(messages[targetIndex], executionRoute), execution,
  );
  return { ...current, [sessionId]: messages };
}

function appendToolToAssistant(message: ChatMessage, execution: ChatToolExecution): ChatMessage {
  const existing = message.toolExecutions ?? [];
  const index = existing.findIndex(item => item.id === execution.id);
  const nextExecution = {
    ...execution,
    contentOffset: index >= 0
      ? existing[index].contentOffset
      : execution.contentOffsetExplicit ? execution.contentOffset : message.content.length,
    contentOffsetExplicit: true,
  };
  return {
    ...message,
    toolExecutions: index >= 0
      ? existing.map((item, itemIndex) => itemIndex === index ? mergeToolExecutionUpdate(item, nextExecution) : item)
      : [...existing, nextExecution],
  };
}

export function applyTaskPlanUpdate(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  assistantId: string,
  update: TaskPlanStreamUpdate,
) {
  if (update.plan.sessionId !== sessionId) {
    return current;
  }
  const messages = current[sessionId] ?? [];
  let applied = false;
  const targetIndex = assistantStreamTargetIndex(messages, assistantId, {
    messageId: update.messageId ?? '',
    assistantSegmentIndex: update.assistantSegmentIndex,
    turnId: update.turnId,
  });
  const nextMessages = messages.map((message, index) => {
    if (index !== targetIndex || message.role !== 'assistant') {
      return message;
    }
    const currentTurnId = message.turnId?.trim() ?? '';
    if (currentTurnId && currentTurnId !== update.turnId) {
      return message;
    }
    applied = true;
    return {
      ...message,
      turnId: currentTurnId || update.turnId,
      taskPlan: update.plan,
    };
  });
  return applied ? { ...current, [sessionId]: nextMessages } : current;
}

function findTranscriptAssistant(
  messages: ChatMessage[],
  predicate: (message: ChatMessage) => boolean,
): ChatMessage | undefined {
  for (const message of messages) {
    const nested = findTranscriptAssistant(message.loopHistory ?? [], predicate);
    if (nested) return nested;
    if (message.role === 'assistant' && predicate(message)) return message;
  }
  return undefined;
}

function updateTranscriptToolOwner(
  message: ChatMessage,
  owner: ChatMessage,
  execution: ChatToolExecution,
): ChatMessage {
  if (message === owner) return appendToolToAssistant(message, execution);
  const loopHistory = message.loopHistory?.map(item => updateTranscriptToolOwner(item, owner, execution));
  return loopHistory?.some((item, index) => item !== message.loopHistory?.[index])
    ? { ...message, loopHistory } : message;
}

function assistantRouteFromToolExecution(
  execution: ChatToolExecution,
): AssistantStreamRoute {
  return {
    messageId:
      execution.assistantMessageId?.trim() || execution.messageId?.trim() || '',
    assistantSegmentIndex:
      execution.assistantSegmentIndex ??
      optionalFiniteNumber(execution.metadata.assistant_segment_index),
    turnId:
      execution.turnId?.trim() || String(execution.metadata.turn_id ?? '').trim(),
    createdAt: execution.createdAt,
    sequence: execution.sequence,
  };
}
