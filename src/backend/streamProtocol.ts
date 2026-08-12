import type { AssistantStreamChunk, StreamExecutionUpdate } from '../types';

export function assistantStreamChunkFromPayload(
  payload: Record<string, unknown>,
): AssistantStreamChunk {
  return {
    messageId: String(payload.message_id ?? payload.messageId ?? '').trim(),
    assistantSegmentIndex: optionalNumber(
      payload.assistant_segment_index ?? payload.assistantSegmentIndex,
    ),
    turnId: String(payload.turn_id ?? payload.turnId ?? '').trim(),
    createdAt: optionalString(payload.created_at ?? payload.createdAt),
    sequence: optionalNumber(payload.sequence),
    requestId: optionalString(payload.request_id ?? payload.requestId),
    eventId: optionalString(payload.event_id ?? payload.eventId),
  };
}

export function executionUpdateFromPayload(
  payload: Record<string, unknown>,
): StreamExecutionUpdate {
  return {
    ...assistantStreamChunkFromPayload(payload),
    kind: String(payload.kind ?? '').trim(),
    reason: optionalString(payload.reason),
    pendingGuidanceCount: optionalNumber(
      payload.pending_guidance_count ?? payload.pendingGuidanceCount,
    ),
    guidanceRoundIndex: optionalNumber(
      payload.guidance_round_index ?? payload.guidanceRoundIndex,
    ),
    previousAssistantSegmentIndex: optionalNumber(
      payload.previous_assistant_segment_index ?? payload.previousAssistantSegmentIndex,
    ),
    nextAssistantSegmentIndex: optionalNumber(
      payload.next_assistant_segment_index ?? payload.nextAssistantSegmentIndex,
    ),
    nextRound: optionalNumber(payload.next_round ?? payload.nextRound),
  };
}

function optionalString(value: unknown) {
  const text = value == null ? '' : String(value);
  return text.trim() ? text : undefined;
}

function optionalNumber(value: unknown) {
  if (value == null || value === '') return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}
