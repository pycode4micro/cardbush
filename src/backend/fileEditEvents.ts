import type { RuntimeEvent } from '@cardbush/bush-protocol';

type FileEditEvent = RuntimeEvent | { kind: 'file_edit_preview_reset'; sessionId: string; turnId: string; createdAt: string };
const listeners = new Set<(event: FileEditEvent) => void>();
export function watchFileEditEvents(listener: (event: FileEditEvent) => void) {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
/** Observe the existing ordered conversation stream without creating a second runtime subscription. */
export function publishFileEditEvent(event: FileEditEvent) {
  if (!['file_edit_preview', 'file_edit_preview_reset', 'tool_returned', 'tool_failed', 'tool_cancelled', 'turn_terminal'].includes(event.kind)) return;
  for (const listener of listeners) { try { listener(event); } catch (error) { console.warn('File edit preview failed', error); } }
}
