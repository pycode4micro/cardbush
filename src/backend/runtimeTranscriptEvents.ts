import { runtimeToolLifecycle, type RuntimeEvent } from '@cardbush/bush-protocol';
import type { AssistantStreamChunk, ChatToolExecution, StreamExecutionUpdate, TurnTerminalSnapshot } from '../types';

// Shared event identities for desktop and remote transcripts. Presentation only.
export function streamChunk(
  event: Pick<RuntimeEvent, 'turnId' | 'createdAt' | 'sequence' | 'requestId' | 'eventId'>,
  messageId: string,
): AssistantStreamChunk {
  return {
    messageId,
    turnId: event.turnId,
    createdAt: event.createdAt,
    sequence: event.sequence,
    requestId: event.requestId,
    eventId: event.eventId,
  };
}

export function assistantStreamChunk(
  event: Extract<RuntimeEvent, {
    kind: 'assistant_segment_delta' | 'assistant_segment_completed';
  }>,
): AssistantStreamChunk {
  return {
    ...streamChunk(event, event.payload.messageId),
    // This ordinal orders content blocks inside one model response, not
    // assistant messages across the Turn's tool loop. Route by messageId.
    segmentId: event.payload.segmentId,
    segmentOrdinal: event.payload.ordinal,
    ...(event.payload.finalResponse !== undefined ? { finalResponse: event.payload.finalResponse } : {}),
  };
}

export function toolLifecycle(
  event: Extract<RuntimeEvent, {
    kind: 'tool_queued' | 'tool_running' | 'tool_returned' | 'tool_failed' | 'tool_cancelled';
  }>,
): ChatToolExecution {
  const lifecycle = runtimeToolLifecycle(event), { error } = lifecycle;
  return {
    id: event.payload.toolCallId,
    name: event.payload.toolName,
    state: lifecycle.state,
    summary: lifecycle.summary,
    output: '',
    success: lifecycle.success,
    durationMs: 0,
    createdAt: event.createdAt,
    contentOffset: 0,
    sequence: event.sequence,
    turnId: event.turnId,
    assistantMessageId: event.payload.assistantMessageId,
    metadata: {
      lifecycleSequence: event.sequence,
      ...(event.payload.display?.title ? { displayTitle: event.payload.display.title } : {}),
      ...(event.payload.display?.titles ? { displayTitles: event.payload.display.titles } : {}),
      ...(error ? { error } : {}),
    },
  };
}

export function terminalSnapshot(
  event: Extract<RuntimeEvent, { kind: 'turn_terminal' }>,
): TurnTerminalSnapshot {
  return {
    turnId: event.turnId,
    status: event.payload.status,
    stopped: event.payload.status === 'stopped',
    stopReason: event.payload.reason,
    stopScenario: event.payload.reason,
    stopDetails: event.payload.details,
    completedAt: event.createdAt,
    terminalEventSequence: event.sequence,
    raw: event,
  };
}

export function guidanceAppliedUpdate(
  event: Extract<RuntimeEvent, { kind: 'guidance_applied' }>,
): StreamExecutionUpdate {
  return {
    ...streamChunk(event, ''),
    kind: 'loop_transition',
    reason: 'turn_guidance_applied',
    guidanceMessageId: event.payload.messageId,
    previousAssistantMessageId: event.payload.previousAssistantMessageId,
    pendingGuidanceCount: event.payload.queueDepth,
    guidanceRoundIndex: event.payload.afterRound,
  };
}

/** Same queued-user-message projection for local and remote event streams. */
export function guidanceQueuedUpdate(
  event: Extract<RuntimeEvent, { kind: 'guidance_queued' }>,
): StreamExecutionUpdate {
  const { messageId, content, createdAt, metadata } = event.payload;
  return {
    ...streamChunk(event, ''), kind: 'loop_transition', reason: 'turn_guidance_queued',
    guidanceMessageId: messageId, pendingGuidanceCount: event.payload.queueDepth,
    guidanceMessage: { id: messageId, messageId, clientMessageId: messageId, role: 'user', content,
      conversationId: event.sessionId, turnId: event.turnId, createdAt, sequence: event.sequence, status: 'queued',
      metadata: { ...metadata, turn_guidance: true, client_message_id: messageId, guidance_delivery: 'queued' } },
  };
}
