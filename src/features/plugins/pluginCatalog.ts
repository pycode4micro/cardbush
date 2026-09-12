import { useSyncExternalStore } from 'react';
import { fetchCardbushAppsConfiguration } from '../../backend/api';
import type { CardbushAppPlugin } from '../../types';

// Composer and transcript share one catalog, including while either view remounts.
let plugins: CardbushAppPlugin[] = [];
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | undefined;
let revision = 0;
let pending: Promise<void> | undefined;

function refresh() {
  revision += 1;
  load();
}

function load() {
  if (pending) return;
  const started = revision;
  pending = fetchCardbushAppsConfiguration().then(configuration => {
    if (started !== revision) return;
    plugins = configuration.plugins.filter(plugin => plugin.installed);
    for (const notify of listeners) notify();
  }).catch(() => {
    // Keep the last observed names and icons during a transient catalog outage.
  }).finally(() => {
    pending = undefined;
    if (started !== revision && listeners.size) load();
  });
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  if (listeners.size === 1) {
    unsubscribe = window.cardbushDesktop?.onCapabilityCatalogChanged?.(refresh);
    window.addEventListener('focus', refresh);
    if (!pending) refresh();
  }
  return () => {
    listeners.delete(notify);
    if (!listeners.size) {
      unsubscribe?.();
      unsubscribe = undefined;
      window.removeEventListener('focus', refresh);
    }
  };
}

const snapshot = () => plugins;

export function usePluginCatalog(): CardbushAppPlugin[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
