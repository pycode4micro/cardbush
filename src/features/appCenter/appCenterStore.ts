import { useMemo, useSyncExternalStore } from 'react';
import { usePluginCatalog } from '../plugins/pluginCatalog';
import type { AppLanguage } from '../../types';
import type { ApplicationPromptReference } from '../../shared/promptReferences';
import { applicationCatalog, defaultAppCenterPreferences, normalizeAppCenterPreferences, type AppCenterPreferences } from './appCenterModel';

export const appCenterStorageKey = 'cardbush_app_center_v1';
let cached = defaultAppCenterPreferences, raw: string | null | undefined;
const listeners = new Set<() => void>();
function read() {
  try { const next = localStorage.getItem(appCenterStorageKey); if (next !== raw) { raw = next; cached = normalizeAppCenterPreferences(next ? JSON.parse(next) : null); } }
  catch { cached = defaultAppCenterPreferences; }
  return cached;
}
function changed(event: StorageEvent) { if (event.key === appCenterStorageKey || event.key === null) { read(); listeners.forEach(fn => fn()); } }
function subscribe(fn: () => void) {
  if (!listeners.size) { read(); window.addEventListener('storage', changed); } listeners.add(fn);
  return () => { listeners.delete(fn); if (!listeners.size) window.removeEventListener('storage', changed); };
}
export function saveAppCenterPreferences(next: AppCenterPreferences) {
  const value = normalizeAppCenterPreferences(next);
  localStorage.setItem(appCenterStorageKey, JSON.stringify(value)); read(); listeners.forEach(fn => fn());
}
export function useAppCenterPreferences() { return useSyncExternalStore(subscribe, () => raw === undefined ? read() : cached, () => defaultAppCenterPreferences); }
export function useApplications(language: AppLanguage) {
  const plugins = usePluginCatalog(), preferences = useAppCenterPreferences();
  return useMemo(() => applicationCatalog(language, plugins, preferences), [language, plugins, preferences]);
}
export const OPEN_APPLICATION_EVENT = 'cardbush-open-application';
export const OPEN_APP_CENTER_EVENT = 'cardbush-open-app-center';
export function requestApplication(id: string, environmentId?: string, reference?: ApplicationPromptReference) { window.dispatchEvent(new CustomEvent(OPEN_APPLICATION_EVENT, { detail: { id, environmentId, reference } })); }
export function requestAppCenter() { window.dispatchEvent(new Event(OPEN_APP_CENTER_EVENT)); }
