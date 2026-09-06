import { useEffect } from 'react';

/** Refresh catalog state without reloading the conversation or an open editor. */
export function useCapabilityCatalogRefresh(
  refresh: (isCurrent: () => boolean) => Promise<unknown>,
) {
  useEffect(() => {
    let disposed = false;
    let generation = 0;
    let running = false;
    let timer = 0;
    const run = async () => {
      if (running || disposed) return;
      running = true;
      const started = generation;
      try {
        await refresh(() => !disposed && started === generation);
      } catch (error) {
        if (!disposed) console.warn('Capability catalog refresh failed', error);
      } finally {
        running = false;
        if (!disposed && started !== generation) schedule();
      }
    };
    const schedule = () => {
      generation += 1;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void run(), 100);
    };
    const visible = () => { if (document.visibilityState === 'visible') schedule(); };
    const unsubscribe = window.cardbushDesktop?.onCapabilityCatalogChanged?.(schedule);
    window.addEventListener('focus', schedule);
    document.addEventListener('visibilitychange', visible);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      unsubscribe?.();
      window.removeEventListener('focus', schedule);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);
}
