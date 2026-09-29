import { useSyncExternalStore } from 'react';
import { componentStorageKey, defaultComponents, normalizeComponents, type ComponentCollection } from './componentModel';
const eventName = 'cardbush:components-changed';
let raw: string | null | undefined, cache = defaultComponents;
function read() {
  try { const next = localStorage.getItem(componentStorageKey); if (next !== raw) { raw = next; cache = normalizeComponents(next ? JSON.parse(next) : null); } }
  catch { cache = defaultComponents; }
  return cache;
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => { if (!event.key || event.key === componentStorageKey) listener(); };
  window.addEventListener(eventName, listener); window.addEventListener('storage', storage);
  return () => { window.removeEventListener(eventName, listener); window.removeEventListener('storage', storage); };
}
export function saveComponents(value: ComponentCollection, expectedRevision: number) {
  const previous = read();
  if (previous.revision !== expectedRevision) throw new Error('REVISION_CONFLICT');
  const next = normalizeComponents({ ...value, revision: expectedRevision + 1 });
  localStorage.setItem(componentStorageKey, JSON.stringify(next));
  for (const item of previous.items) {
    if (!next.items.some(current => current.id === item.id)) {
      try { localStorage.removeItem('cardbush.component-state.' + item.id); } catch { /* The saved layout remains valid if state cleanup is unavailable. */ }
    }
  }
  read(); window.dispatchEvent(new Event(eventName));
}
export function useComponents() { return useSyncExternalStore(subscribe, read, () => defaultComponents); }
