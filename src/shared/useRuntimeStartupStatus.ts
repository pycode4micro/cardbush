import { useSyncExternalStore } from 'react';
import type { RuntimeStartupStatus } from '../types';

type StartupSource = {
  runtimeStartupStatus?: () => Promise<RuntimeStartupStatus>;
  onRuntimeStartupStatus?: (listener: (status: RuntimeStartupStatus) => void) => () => void;
};
const readyStatus: RuntimeStartupStatus = { phase: 'ready', attempt: 0, startedAt: '' };

/** One startup snapshot/subscription per renderer, independent of conversation mounts. */
export function createRuntimeStartupStatusStore(desktop?: StartupSource) {
  let status: RuntimeStartupStatus = desktop?.runtimeStartupStatus
    ? { phase: 'initializing', attempt: 0, startedAt: new Date().toISOString() } : readyStatus;
  const listeners = new Set<() => void>();
  let connected = false, revision = 0;
  const publish = (next: RuntimeStartupStatus) => {
    status = next;
    for (const listener of listeners) listener();
  };
  const connect = () => {
    if (connected || !desktop?.runtimeStartupStatus) return;
    connected = true;
    const readRevision = revision;
    // Keep this single IPC listener for the renderer lifetime so a real restart
    // is observed even while no local conversation/composer is mounted.
    desktop.onRuntimeStartupStatus?.(next => { revision++; publish(next); });
    void Promise.resolve().then(() => desktop.runtimeStartupStatus!()).then(next => {
      if (revision === readRevision) publish(next);
    }).catch(error => {
      if (revision === readRevision) publish({ phase: 'error', attempt: status.attempt,
        startedAt: status.startedAt, error: error instanceof Error ? error.message : String(error) });
    });
  };
  return {
    getSnapshot: () => status,
    subscribe: (listener: () => void) => {
      listeners.add(listener); connect();
      return () => { listeners.delete(listener); };
    },
  };
}

let localStore: ReturnType<typeof createRuntimeStartupStatusStore> | undefined;
const bypassStore = { getSnapshot: () => readyStatus, subscribe: () => () => {} };

export function useRuntimeStartupStatus(enabled = true): RuntimeStartupStatus {
  const store = enabled
    ? localStore ??= createRuntimeStartupStatusStore(window.cardbushDesktop)
    : bypassStore;
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
