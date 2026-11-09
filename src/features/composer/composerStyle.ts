import { useSyncExternalStore } from 'react';

const key = 'cardbush.composer-style';
type Style = 'standard' | 'simple';
export function migrateComposerStyle() {
  if (localStorage.getItem(key)) return;
  let style: Style = 'standard';
  try {
    const old = JSON.parse(localStorage.getItem('cardbush.html_components.v1') || 'null');
    const input = old?.welcomeLayout?.items?.find((item: {componentId?: string}) => item?.componentId === 'system-input');
    if ((input?.inputStyle ?? old?.items?.find((item: {id?: string}) => item?.id === 'system-input')?.inputStyle) === 'simple') style = 'simple';
  } catch { /* No saved presentation. */ }
  localStorage.setItem(key, style);
}
function read(): Style { return localStorage.getItem(key) === 'simple' ? 'simple' : 'standard'; }
export function setComposerStyle(style: Style) {
  localStorage.setItem(key, style);
  window.dispatchEvent(new Event(key));
}
function subscribe(listener: () => void) {
  migrateComposerStyle();
  const storage = (event: StorageEvent) => { if (!event.key || event.key === key) listener(); };
  window.addEventListener('storage', storage); window.addEventListener(key, listener);
  return () => { window.removeEventListener('storage', storage); window.removeEventListener(key, listener); };
}
export function useComposerStyle() { return useSyncExternalStore(subscribe, read, () => 'standard' as Style); }
