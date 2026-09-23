import { useCallback, useSyncExternalStore, type SetStateAction } from 'react';

type Entry = { value: unknown; listeners: Set<() => void>; retain: (value: unknown) => boolean };
// View data only. Never part of a Runtime request, transcript or model cache.
const entries = new Map<string, Entry>();
const idleLimit = 256;
function trim() {
  let idle = [...entries.values()].filter(entry => !entry.listeners.size && !entry.retain(entry.value)).length;
  for (const [key, entry] of entries) {
    if (idle <= idleLimit) break;
    if (!entry.listeners.size && !entry.retain(entry.value)) { entries.delete(key); idle--; }
  }
}
function entryFor<T>(key: string, initial: () => T, retain: (value: T) => boolean): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = { value: initial(), listeners: new Set(), retain: retain as (value: unknown) => boolean };
    entries.set(key, entry); trim();
  }
  return entry;
}
const disposable = () => false;

/** Setters capture their conversation key, including across an async upload/send. */
export function useConversationViewState<T>(key: string, initial: () => T, retain: (value: T) => boolean = disposable) {
  // Initializer and retention policy belong to the key, just as a useState
  // initializer belongs to a component identity; inline functions do not reset it.
  const get = useCallback(() => entryFor(key, initial, retain).value as T, [key]);
  const subscribe = useCallback((listener: () => void) => {
    const entry = entryFor(key, initial, retain);
    entries.delete(key); entries.set(key, entry);
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); trim(); };
  }, [key]);
  const value = useSyncExternalStore(subscribe, get, get);
  const set = useCallback((update: SetStateAction<T>) => {
    const entry = entryFor(key, initial, retain);
    const next = typeof update === 'function' ? (update as (value: T) => T)(entry.value as T) : update;
    if (Object.is(next, entry.value)) return;
    entry.value = next;
    for (const listener of entry.listeners) listener();
    trim();
  }, [key]);
  return [value, set, get] as const;
}

export function conversationViewKey(hostId: string | undefined, sessionId: string, field: string) {
  return JSON.stringify([hostId ?? 'local', sessionId || '__new__', field]);
}
