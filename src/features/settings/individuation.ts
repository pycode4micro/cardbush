import { normalizeIndividuation, type IndividuationSettings } from '@cardbush/bush-protocol';
export { normalizeIndividuation };
export const individuationStorageKey = 'cardbush_individuation';

export function readIndividuation(): IndividuationSettings {
  try { return normalizeIndividuation(JSON.parse(window.localStorage.getItem(individuationStorageKey) ?? 'null')); }
  catch { return normalizeIndividuation(undefined); }
}
export function saveIndividuation(value: unknown): void {
  window.localStorage.setItem(individuationStorageKey, JSON.stringify(normalizeIndividuation(value)));
}
