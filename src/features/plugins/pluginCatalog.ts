import { useContext, useSyncExternalStore } from 'react';
import { ConversationHostContext } from '../conversationHost';
import { fetchCardbushAppsConfiguration } from '../../backend/api';
import type { CardbushAppPlugin, PluginCommandSummary } from '../../types';

// Composer and transcript share cached catalogs, including while either view
// remounts. History rows subscribe to the store, not individual IPC requests.
function createCatalog<T>(read: () => Promise<T[]>) {
  let items: T[] = [];
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
    pending = read().then(next => {
      if (started !== revision) return;
      items = next;
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

  return { subscribe, snapshot: () => items };
}

const plugins = createCatalog<CardbushAppPlugin>(async () =>
  (await fetchCardbushAppsConfiguration()).plugins.filter(plugin => plugin.installed));
const commands = createCatalog<PluginCommandSummary>(() => window.cardbushDesktop?.pluginCommands?.() ?? Promise.resolve([]));
const noSubscribe = () => () => {};

export function usePluginCatalog(): CardbushAppPlugin[] {
  const host = useContext(ConversationHostContext);
  const local = useSyncExternalStore(host ? noSubscribe : plugins.subscribe, plugins.snapshot, plugins.snapshot);
  return host?.plugins ?? local;
}

export function usePluginCommandCatalog(enabled = true): PluginCommandSummary[] {
  const host = useContext(ConversationHostContext);
  const local = useSyncExternalStore(host || !enabled ? noSubscribe : commands.subscribe, commands.snapshot, commands.snapshot);
  return host?.pluginCommands ?? local;
}
