import { useSyncExternalStore } from 'react';
import type { BrowserFrequentSite } from '../../../electron/browserLibrary';

type Snapshot = { sites: BrowserFrequentSite[]; loading: boolean; failed: boolean };
const initial: Snapshot = { sites: [], loading: true, failed: false };
const listeners = new Set<() => void>();
let snapshot = initial;
let stop: (() => void) | undefined;
let refresh: (() => void) | undefined;

function publish(next: Snapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

// All start pages in this renderer show the same browser history. Keep one
// subscription while at least one is mounted and coalesce overlapping reads.
function observe() {
  const api = window.cardbushDesktop?.browser;
  if (!api?.frequentSites) {
    publish({ ...initial, loading: false });
    return;
  }
  let active = true, pending = false, dirty = false;
  const load = async () => {
    if (pending) { dirty = true; return; }
    pending = true;
    do {
      dirty = false;
      let next: Snapshot;
      try { next = { sites: await api.frequentSites(), loading: false, failed: false }; }
      catch { next = { sites: [], loading: false, failed: true }; }
      if (active && !dirty) publish(next);
    } while (active && dirty);
    pending = false;
  };
  refresh = load;
  const unsubscribe = api.onHistoryChanged?.(load);
  stop = () => { active = false; unsubscribe?.(); };
  queueMicrotask(() => { if (active) void load(); });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) observe();
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    stop?.();
    stop = undefined;
    refresh = undefined;
    snapshot = initial;
  };
}

const read = () => snapshot;
function retry() {
  if (!refresh) return;
  publish({ ...snapshot, loading: true });
  refresh();
}

export function useFrequentSites() {
  return { ...useSyncExternalStore(subscribe, read, read), retry };
}
