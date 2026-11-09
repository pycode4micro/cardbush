import { useSyncExternalStore } from 'react';
import { migrateComposerStyle } from '../composer/composerStyle';
import { componentStorageKey, defaultComponents, normalizeComponents, type ComponentCollection } from './componentModel';

const listeners = new Set<() => void>();
let current = defaultComponents;
let initialized = false;
let initializing: Promise<ComponentCollection> | undefined;
let detach: (() => void) | undefined;
function legacy() {
  try { return normalizeComponents(JSON.parse(localStorage.getItem(componentStorageKey) || 'null')); }
  catch { return defaultComponents; }
}
function accept(next: ComponentCollection | null) {
  if (next && (!initialized || next.revision > current.revision)) {
    current = next;
    listeners.forEach(listener => listener());
  }
  initialized = true;
  return current;
}
export async function getComponents(): Promise<ComponentCollection> {
  const api = window.cardbushDesktop?.homeComponentLibrary;
  if (!api) return accept(legacy());
  if (!initialized) {
    initializing ??= api('migrate', undefined, legacy().items).then(next => {
      migrateComposerStyle();
      localStorage.removeItem(componentStorageKey);
      return accept(next);
    }).finally(() => { initializing = undefined; });
    return initializing;
  }
  return accept(await api('read', current.revision));
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const refresh = () => { void getComponents().catch(() => { /* Retry on the next catalog change or focus. */ }); };
    const unsubscribe = window.cardbushDesktop?.onHomeComponentsChanged?.(refresh);
    const storage = (event: StorageEvent) => { if (!event.key || event.key === componentStorageKey) refresh(); };
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', storage);
    detach = () => { unsubscribe?.(); window.removeEventListener('focus', refresh); window.removeEventListener('storage', storage); };
    refresh();
  }
  return () => { listeners.delete(listener); if (!listeners.size) detach?.(); };
}
export function useComponents() { return useSyncExternalStore(subscribe, () => current, () => defaultComponents); }
export async function saveComponents(value: ComponentCollection, expectedRevision: number) {
  const api = window.cardbushDesktop?.homeComponentLibrary;
  const previous = api ? await getComponents() : legacy();
  if (previous.revision !== expectedRevision) throw Error('REVISION_CONFLICT');
  if (value.items.length > Math.max(12,previous.items.length)) throw Error('COMPONENT_LIMIT');
  if (api) accept(await api('save', expectedRevision, value.items));
  else {
    const next = normalizeComponents({...value, revision: expectedRevision + 1});
    localStorage.setItem(componentStorageKey, JSON.stringify(next)); accept(next);
  }
  for (const item of previous.items) {
    if (!value.items.some(next => next.id === item.id)) localStorage.removeItem('cardbush.component-state.' + item.id);
  }
}
