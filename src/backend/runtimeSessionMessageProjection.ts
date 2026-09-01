import type {
  SessionMessage as RuntimeSessionMessage,
  SessionSnapshot as RuntimeSessionSnapshot,
} from '@cardbush/bush-protocol';

import type { ChatMessage } from '../types';

type RuntimeCommittedTurn = RuntimeSessionSnapshot['turns'][number];

/**
 * Project one committed Runtime Turn without losing boundaries that are
 * represented by message order. In particular, a named turn_guidance user
 * message seals the preceding assistant reply as user-visible output.
 */
export function projectRuntimeTurnMessages(
  turn: RuntimeCommittedTurn,
  sessionId: string,
): ChatMessage[] {
  let assistantSegmentIndex = 0;
  let segmentStartedAt = turn.createdAt;
  const lastAssistantIndex = findLastAssistantIndex(turn.messages);

  return turn.messages.map((message, index) => {
    const next = turn.messages[index + 1];
    const previous = turn.messages[index - 1];
    const isGuidance = isRuntimeGuidanceMessage(message);
    const isGuidanceBoundary =
      message.message.role === 'assistant' && isRuntimeGuidanceMessage(next);

    if (isGuidance) {
      segmentStartedAt = message.createdAt;
    }
    if (message.message.role === 'assistant') {
      assistantSegmentIndex += 1;
    }

    const projected = projectRuntimeSessionMessage(message, sessionId, turn);
    const metadata: Record<string, unknown> = {
      ...(projected.metadata ?? {}),
    };

    if (isGuidance) {
      metadata.name = 'turn_guidance';
      metadata.turn_guidance = true;
      metadata.guidance_delivery = 'sent';
      metadata.client_message_id = message.messageId;
    }

    if (message.message.role === 'assistant') {
      metadata.assistant_segment_index = assistantSegmentIndex;
      metadata.transcript_kind = isGuidanceBoundary
        ? 'assistant_segment'
        : index === lastAssistantIndex
          ? 'assistant_final'
          : 'assistant_segment';

      if (isGuidanceBoundary && next) {
        metadata.segment_complete = true;
        metadata.segment_boundary = 'turn_guidance';
        metadata.sealed_by_client_message_id = next.messageId;
        metadata.next_assistant_segment_index = assistantSegmentIndex + 1;
      }

      const startedAt = isRuntimeGuidanceMessage(previous)
        ? previous.createdAt
        : segmentStartedAt;
      const completedAt = isGuidanceBoundary
        ? message.createdAt
        : index === lastAssistantIndex
          ? turn.completedAt
          : message.createdAt;
      const durationMs = timestampDuration(startedAt, completedAt);
      metadata.cardbush_turn_started_at = startedAt;
      metadata.cardbush_turn_completed_at = completedAt;
      if (durationMs != null) {
        metadata.cardbush_turn_duration_ms = durationMs;
      }
      segmentStartedAt = completedAt;
    }

    return {
      ...projected,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
  });
}

export function projectRuntimeSessionMessage(
  message: RuntimeSessionMessage,
  sessionId: string,
  turn?: RuntimeCommittedTurn,
): ChatMessage {
  const role =
    message.message.role === 'developer' ? 'system' : message.message.role;
  const metadata: Record<string, unknown> = {};
  if (message.message.role === 'assistant') {
    metadata.toolCalls = message.message.toolCalls;
  } else if (message.message.role === 'tool') {
    metadata.toolCallId = message.message.toolCallId;
  } else if (message.message.name) {
    metadata.name = message.message.name;
  }
  return {
    id: message.messageId,
    messageId: message.messageId,
    role,
    content: message.message.content,
    conversationId: sessionId,
    turnId: message.turnId,
    createdAt: message.createdAt,
    ...(role === 'assistant' && turn ? { status: turn.status } : {}),
    turnSequence: message.turnSequence,
    messageIndex: message.messageIndex,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function isRuntimeGuidanceMessage(message?: RuntimeSessionMessage): boolean {
  return message?.message.role === 'user' && message.message.name === 'turn_guidance';
}

function findLastAssistantIndex(messages: RuntimeSessionMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].message.role === 'assistant') {
      return index;
    }
  }
  return -1;
}

function timestampDuration(startedAt: string, completedAt: string): number | undefined {
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  return Number.isFinite(started) && Number.isFinite(completed) && completed >= started
    ? completed - started
    : undefined;
}
