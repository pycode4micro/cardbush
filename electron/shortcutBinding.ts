// Shared by DOM key events and Electron's before-input-event for embedded pages.
export type ShortcutBinding = { key: string; ctrl?: boolean; alt?: boolean; shift?: boolean };
export type ShortcutEvent = { key: string; code?: string; ctrlKey: boolean; metaKey: boolean;
  altKey: boolean; shiftKey: boolean; repeat?: boolean; isComposing?: boolean; keyCode?: number };

export function bindingFromEvent(event: ShortcutEvent): ShortcutBinding | null {
  if (event.isComposing || event.keyCode === 229 || ['Control', 'Meta', 'Alt', 'Shift', 'AltGraph', 'Dead', 'Process', 'Unidentified'].includes(event.key)) return null;
  let key = event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (['+', '='].includes(key) || event.code === 'NumpadAdd') key = 'Plus';
  if (['-', '_'].includes(key) || event.code === 'NumpadSubtract') key = 'Minus';
  return { key, ctrl: event.ctrlKey || event.metaKey, alt: event.altKey,
    shift: key === 'Plus' || key === 'Minus' ? false : event.shiftKey };
}

export function sameBinding(a: ShortcutBinding | null, b: ShortcutBinding | null) {
  return a === b || Boolean(a && b && a.key === b.key && !!a.ctrl === !!b.ctrl && !!a.alt === !!b.alt && !!a.shift === !!b.shift);
}

export type HistoryDirection = 'back' | 'forward';
export type HistoryBinding = { direction: HistoryDirection; binding: ShortcutBinding };
export type HistoryInput = { direction: HistoryDirection; guestId?: number };
export function matchHistoryInput(bindings: HistoryBinding[], event: ShortcutEvent) {
  const gesture = bindingFromEvent(event);
  return bindings.find(entry => sameBinding(entry.binding, gesture))?.direction;
}
