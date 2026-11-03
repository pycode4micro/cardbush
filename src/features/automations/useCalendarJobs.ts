import { useSyncExternalStore } from 'react';
import type { AutomationJob, AutomationOverview } from '@cardbush/bush-protocol';
import { getRuntimeStartupStatusStore } from '../../shared/useRuntimeStartupStatus';

const empty: AutomationJob[] = [];
let jobs = empty, error = '', revision = 0, timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
let detach: (() => void) | undefined;
let snapshot = { jobs, error };
function publish() { snapshot = { jobs, error }; for (const listener of listeners) listener(); }
async function refresh() {
  if (getRuntimeStartupStatusStore().getSnapshot().phase !== 'ready') return;
  const command = window.cardbushDesktop?.automationCommand; if (!command) return;
  const ticket = ++revision;
  try { const result = await command({ action: 'list' }) as AutomationOverview;
    if (ticket === revision && listeners.size) { jobs = result.jobs; error = ''; publish(); }
  } catch { if (ticket === revision && listeners.size) { error = 'unavailable'; publish(); } }
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const update = () => { clearTimeout(timer); timer = setTimeout(() => void refresh(), 120); };
    const unsubscribe = window.cardbushDesktop?.onAutomationChanged?.(update);
    const runtime = getRuntimeStartupStatusStore();
    const runtimeChanged = () => { revision++; clearTimeout(timer); void refresh(); };
    const unsubscribeRuntime = runtime.subscribe(runtimeChanged);
    window.addEventListener('focus', update); void refresh();
    detach = () => { revision++; clearTimeout(timer); unsubscribe?.(); unsubscribeRuntime(); window.removeEventListener('focus', update); };
  }
  return () => { listeners.delete(listener); if (!listeners.size) { detach?.(); detach = undefined; jobs = empty; error = ''; snapshot = { jobs, error }; } };
}
/** Read-only, shared among calendar widgets; hover never issues a request. */
export function useCalendarJobs() { return useSyncExternalStore(subscribe, () => snapshot); }
