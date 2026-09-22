import type { RuntimeEvent } from '@cardbush/bush-protocol';
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
  };
}

export function toolLifecycle(
  event: Extract<RuntimeEvent, {
    kind: 'tool_queued' | 'tool_running' | 'tool_returned' | 'tool_failed' | 'tool_cancelled';
  }>,
): ChatToolExecution {
  return {
    id: event.payload.toolCallId,
    name: event.payload.toolName,
    state: toolLifecycleState(event.kind),
    summary: event.payload.display?.summary || event.payload.display?.title || event.payload.toolName,
    output: '',
    success: event.kind === 'tool_returned',
    durationMs: 0,
    createdAt: event.createdAt,
    contentOffset: 0,
    sequence: event.sequence,
    turnId: event.turnId,
    assistantMessageId: event.payload.assistantMessageId,
    metadata: {
      ...('error' in event.payload ? { error: event.payload.error } : {}),
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

function toolLifecycleState(
  kind: 'tool_queued' | 'tool_running' | 'tool_returned' | 'tool_failed' | 'tool_cancelled',
): ChatToolExecution['state'] {
  switch (kind) {
    case 'tool_queued': return 'queued';
    case 'tool_running': return 'running';
    case 'tool_returned': return 'completed';
    case 'tool_failed': return 'failed';
    case 'tool_cancelled': return 'cancelled';
  }
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
