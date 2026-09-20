import { useSyncExternalStore } from 'react';

export const conversationArchivesStorageKey = 'cardbush_archived_conversation_ids';
const changedEvent = 'cardbush-conversation-archives-changed';
const empty: ReadonlySet<string> = new Set();
let cachedRaw: string | null | undefined;
let cached: ReadonlySet<string> = empty;
const listeners = new Set<() => void>();

function readStored() {
  let raw: string | null;
  try { raw = window.localStorage.getItem(conversationArchivesStorageKey); }
  catch { return cached; }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    try {
      const value: unknown = JSON.parse(raw ?? '[]');
      cached = new Set(Array.isArray(value)
        ? value.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
        : []);
    } catch { cached = empty; }
  }
  return cached;
}

function snapshot() { return cachedRaw === undefined ? readStored() : cached; }
function refresh() { readStored(); for (const listener of listeners) listener(); }
function onStorage(event: StorageEvent) {
  if (event.key === null || event.key === conversationArchivesStorageKey) refresh();
}
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

/** Only visibility metadata is stored; conversation history stays in the Runtime. */
export function setConversationsArchived(ids: readonly string[], archived: boolean) {
  const next = new Set(readStored());
  for (const id of ids) {
    if (!id.trim()) continue;
    if (archived) next.add(id);
    else next.delete(id);
  }
  // Publish only after storage succeeds so a failed write cannot look successful.
  window.localStorage.setItem(conversationArchivesStorageKey, JSON.stringify([...next]));
  readStored();
  window.dispatchEvent(new Event(changedEvent));
}

export function useConversationArchives() {
  return useSyncExternalStore(subscribe, snapshot, () => empty);
}
