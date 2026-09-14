import { useMemo, useSyncExternalStore } from 'react';
import { conflictingShortcut, formatShortcut, matchesShortcut, normalizeShortcutOverrides, shortcutAria, shortcutBinding,
  type ShortcutBinding, type ShortcutEvent, type ShortcutId, type ShortcutOverrides } from './keyboardShortcuts';

export const keyboardShortcutsStorageKey = 'cardbush_keyboard_shortcuts';
const changedEvent = 'cardbush-keyboard-shortcuts-changed';
const empty: ShortcutOverrides = {};
let cachedRaw: string | null | undefined;
let cached: ShortcutOverrides = empty;
const listeners = new Set<() => void>();

function readStored() {
  let raw: string | null;
  try { raw = localStorage.getItem(keyboardShortcutsStorageKey); } catch { return cached; }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    try { cached = normalizeShortcutOverrides(raw ? JSON.parse(raw) : {}); } catch { cached = empty; }
  }
  return cached;
}

// Reading the store during token renders must not synchronously read storage
// once per historical message. Only storage changes refresh the shared snapshot.
function snapshot() { return cachedRaw === undefined ? readStored() : cached; }
function refresh() { readStored(); for (const listener of listeners) listener(); }
function onStorage(event: StorageEvent) { if (event.key === null || event.key === keyboardShortcutsStorageKey) refresh(); }

function subscribe(listener: () => void) {
  if (!listeners.size) {
    readStored();
    window.addEventListener(changedEvent, refresh);
    window.addEventListener('storage', onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      window.removeEventListener(changedEvent, refresh);
      window.removeEventListener('storage', onStorage);
    }
  };
}

export function saveKeyboardShortcuts(overrides: ShortcutOverrides) {
  localStorage.setItem(keyboardShortcutsStorageKey, JSON.stringify(normalizeShortcutOverrides(overrides)));
  readStored();
  window.dispatchEvent(new Event(changedEvent));
}

export function useKeyboardShortcuts() {
  const overrides = useSyncExternalStore(subscribe, snapshot, () => empty);
  return useMemo(() => ({
    overrides,
    matches: (id: ShortcutId, event: ShortcutEvent) => matchesShortcut(id, event, overrides),
    label: (id: ShortcutId) => formatShortcut(shortcutBinding(id, overrides)),
    aria: (id: ShortcutId) => shortcutAria(shortcutBinding(id, overrides)),
    conflict: (id: ShortcutId, binding: ShortcutBinding | null) => conflictingShortcut(id, binding, overrides),
  }), [overrides]);
}
