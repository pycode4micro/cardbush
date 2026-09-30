import { normalizeIndividuation, type IndividuationSettings } from '@cardbush/bush-protocol';
export { normalizeIndividuation };
export const individuationStorageKey = 'cardbush_individuation';
const individuationChanged = 'cardbush:individuation-changed';

export function readIndividuation(): IndividuationSettings {
  try { return normalizeIndividuation(JSON.parse(window.localStorage.getItem(individuationStorageKey) ?? 'null')); }
  catch { return normalizeIndividuation(undefined); }
}
export function saveIndividuation(value: unknown): void {
  const target = window;
  const saved = JSON.stringify(normalizeIndividuation(value));
  if (target.localStorage.getItem(individuationStorageKey) === saved) return;
  target.localStorage.setItem(individuationStorageKey, saved);
  // Settings can be persisted inside a React state updater. Notify after it
  // completes so other composers are never updated during that render.
  queueMicrotask(() => target.dispatchEvent(new Event(individuationChanged)));
}

export function subscribeIndividuation(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea === window.localStorage && (event.key === individuationStorageKey || event.key === null)) listener();
  };
  window.addEventListener(individuationChanged, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(individuationChanged, listener);
    window.removeEventListener('storage', onStorage);
  };
}
