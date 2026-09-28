import { useMemo, useSyncExternalStore } from 'react';
import { conversationStyleChanged, conversationStyleStorageKey, normalizeConversationStylePreferences,
  readConversationStyleOverride, resolveConversationStyleId, selectConversationStyle } from './conversationStyle';

function subscribe(listener: () => void) {
  window.addEventListener(conversationStyleChanged, listener);
  window.addEventListener('storage', listener);
  return () => { window.removeEventListener(conversationStyleChanged, listener); window.removeEventListener('storage', listener); };
}

export function useConversationStyle(sessionId: string, hostId = '') {
  const snapshot = useSyncExternalStore(subscribe, () => {
    let saved: string | null = null;
    try { saved = localStorage.getItem(conversationStyleStorageKey); } catch { /* Use defaults when storage is unavailable. */ }
    return JSON.stringify([saved, readConversationStyleOverride(sessionId, hostId)]);
  });
  const state = useMemo(() => {
    const [saved, override] = JSON.parse(snapshot) as [string | null, string | null];
    let input: unknown;
    try { input = JSON.parse(saved ?? 'null'); } catch { /* Ignore malformed preferences. */ }
    const preferences = normalizeConversationStylePreferences(input);
    const id = resolveConversationStyleId(preferences, override);
    return { preferences, id, override: override === id ? override : null };
  }, [snapshot]);
  return { ...state, select: (id: string | null) => selectConversationStyle(sessionId, id, hostId) };
}
