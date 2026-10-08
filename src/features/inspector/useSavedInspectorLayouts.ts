import { useSyncExternalStore } from 'react';
import { normalizeSavedInspectorLayouts, savedInspectorLayoutsKey, type SavedInspectorLayout } from './savedInspectorLayouts';

const changed = 'cardbush:saved-inspector-layouts';
let previous = '', cached: SavedInspectorLayout[] = [];
function snapshot() {
  let raw = '';
  try { raw = localStorage.getItem(savedInspectorLayoutsKey) ?? ''; } catch { return cached; }
  if (raw !== previous) {
    previous = raw;
    try { cached = normalizeSavedInspectorLayouts(JSON.parse(raw)); } catch { cached = []; }
  }
  return cached;
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => { if (!event.key || event.key === savedInspectorLayoutsKey) listener(); };
  window.addEventListener(changed, listener); window.addEventListener('storage', storage);
  return () => { window.removeEventListener(changed, listener); window.removeEventListener('storage', storage); };
}
function write(layouts: SavedInspectorLayout[]) {
  localStorage.setItem(savedInspectorLayoutsKey, JSON.stringify(layouts));
  window.dispatchEvent(new Event(changed));
}
export function saveInspectorLayout(layout: SavedInspectorLayout) {
  const current = snapshot(), next = normalizeSavedInspectorLayouts([layout])[0];
  if (!next) throw Error('invalid-layout');
  if (current.some(item => item.id !== next.id && item.name.toLocaleLowerCase() === next.name.toLocaleLowerCase())) throw Error('duplicate-name');
  if (current.length >= 50 && !current.some(item => item.id === next.id)) throw Error('layout-limit');
  const index = current.findIndex(item => item.id === next.id), layouts = [...current];
  if (index < 0) layouts.push(next); else layouts[index] = next;
  write(layouts);
}
export function removeInspectorLayout(id: string) { write(snapshot().filter(item => item.id !== id)); }
export function useSavedInspectorLayouts() { return useSyncExternalStore(subscribe, snapshot, snapshot); }
