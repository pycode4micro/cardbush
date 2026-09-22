import type { RuntimeEvent } from '@cardbush/bush-protocol';
import type { ThinkingStreamEvent } from '../types';

/** Shared presentation for local and remote Runtime reasoning events. */
export function runtimeThinkingEvent(event: Extract<RuntimeEvent, {
  kind: 'reasoning_segment_started' | 'reasoning_segment_delta' | 'reasoning_segment_completed';
}>): ThinkingStreamEvent {
  const delta = event.kind === 'reasoning_segment_delta' ? event.payload.delta : '';
  return {
    id: event.payload.segmentId, channel: 'reasoning', turnId: event.turnId,
    generationId: event.payload.segmentId,
    phase: event.kind === 'reasoning_segment_started' ? 'start' : event.kind === 'reasoning_segment_delta' ? 'delta' : 'end',
    delta, content: event.kind === 'reasoning_segment_completed' ? event.payload.content : '',
    preview: delta, createdAt: event.createdAt,
  };
}
