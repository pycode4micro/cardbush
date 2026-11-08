import { useCallback, useEffect, useRef, useState } from 'react';
import type { FriendsSnapshot } from '@cardbush/bush-protocol';
import { eventBackend } from './eventBackend';

export function useEventExecution(enabled: boolean, refreshInterval = 1500) {
  const [snapshot, setSnapshot] = useState<FriendsSnapshot>();
  const [error, setError] = useState(false);
  const mounted = useRef(true), refreshTask = useRef<Promise<void> | undefined>(undefined);
  const refresh = useCallback(() => {
    return refreshTask.current ??= eventBackend.read().then(value => {
      if (mounted.current) { setSnapshot(previous => JSON.stringify(previous) === JSON.stringify(value) ? previous : value); setError(false); }
    }, () => { if (mounted.current) setError(true); }).finally(() => { refreshTask.current = undefined; });
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (!enabled) return () => { mounted.current = false; };
    let timer: ReturnType<typeof setTimeout>, disposed = false;
    const poll = async () => {
      if (!document.hidden) await refresh();
      if (!disposed) timer = setTimeout(() => void poll(), refreshInterval);
    };
    void poll();
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { disposed = true; mounted.current = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [enabled, refresh, refreshInterval]);
  return { snapshot, setSnapshot, error, refresh };
}
