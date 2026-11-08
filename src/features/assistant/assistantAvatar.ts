import { useSyncExternalStore } from 'react';

const key = 'cardbush_personal_assistant_avatar_v1', eventName = 'cardbush:assistant-avatar';
const valid = (value: string) => value.length <= 360000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value);
export function readAssistantAvatar() {
  try { const value = localStorage.getItem(key) ?? ''; return valid(value) ? value : ''; }
  catch { return ''; }
}
export function saveAssistantAvatar(value: string) {
  if (value && !valid(value)) throw Error('INVALID_AVATAR');
  if (value) localStorage.setItem(key, value); else localStorage.removeItem(key);
  window.dispatchEvent(new Event(eventName));
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => { if (!event.key || event.key === key) listener(); };
  window.addEventListener(eventName, listener); window.addEventListener('storage', storage);
  return () => { window.removeEventListener(eventName, listener); window.removeEventListener('storage', storage); };
}
export const useAssistantAvatar = () => useSyncExternalStore(subscribe, readAssistantAvatar);
