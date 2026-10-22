import type { RuntimeEvent } from './runtimeHost.js';

export type RuntimeToolLifecycleEvent = Extract<RuntimeEvent, {
  kind: 'tool_queued' | 'tool_running' | 'tool_returned' | 'tool_failed' | 'tool_cancelled';
}>;

/** Presentation facts shared by App and CLI. A successful transport return can
 * still contain a declared tool failure; prose never determines success. */
export function runtimeToolLifecycle(event: RuntimeToolLifecycleEvent) {
  const error = event.kind === 'tool_returned' ? event.payload.resultError : event.kind === 'tool_failed' ? event.payload.error : undefined;
  const states = { tool_queued: 'queued', tool_running: 'running', tool_returned: 'completed', tool_failed: 'failed', tool_cancelled: 'cancelled' } as const;
  return {
    id: event.payload.toolCallId,
    name: event.payload.toolName,
    state: error ? 'failed' as const : states[event.kind],
    title: event.payload.display?.title || event.payload.toolName,
    summary: event.payload.display?.summary || event.payload.display?.title || event.payload.toolName,
    success: event.kind === 'tool_returned' && !error,
    error,
  };
}
