import { useSyncExternalStore } from 'react';

const event = 'cardbush:conversation-source-changed';
const key = (sessionId = '', hostId = '') => `cardbush_source:${JSON.stringify([hostId, sessionId])}`;
// A new conversation starts enabled. Unsaved drafts live only in this window.
export function resolveConversationSource(sessionId = '', hostId = ''): boolean {
  try { return (sessionId ? localStorage : sessionStorage).getItem(key(sessionId, hostId)) !== 'off'; }
  catch { return true; }
}
export function setConversationSource(enabled: boolean, sessionId = '', hostId = '') {
  try { (sessionId ? localStorage : sessionStorage).setItem(key(sessionId, hostId), enabled ? 'on' : 'off'); } catch { /* Storage may be unavailable. */ }
  window.dispatchEvent(new Event(event));
}
export function adoptDraftConversationSource(sessionId: string, hostId = '') {
  try {
    const draft = sessionStorage.getItem(key('', hostId));
    if (draft !== null) localStorage.setItem(key(sessionId, hostId), draft);
    sessionStorage.removeItem(key('', hostId));
  } catch { /* Defaults remain usable without storage. */ }
  window.dispatchEvent(new Event(event));
}
function subscribe(listener: () => void) {
  window.addEventListener(event, listener); window.addEventListener('storage', listener);
  return () => { window.removeEventListener(event, listener); window.removeEventListener('storage', listener); };
}
export function useConversationSource(sessionId = '', hostId = '') {
  const enabled = useSyncExternalStore(subscribe, () => resolveConversationSource(sessionId, hostId), () => true);
  return { enabled, setEnabled: (value: boolean) => setConversationSource(value, sessionId, hostId) };
}
