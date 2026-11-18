import { useCallback, useEffect, useRef, useState } from 'react';
import type { RuntimeSolutionSelection } from '@cardbush/bush-protocol';
import { api } from './api';

type Read = { items: RuntimeSolutionSelection[]; unavailable: boolean };

/** Independent requests and timers keep an offline worker from delaying local questions. */
function useQuestionRead(sessionId: string | null, scope: 'local' | 'remote') {
  const [state, setState] = useState<Read & { sessionId: string }>();
  const trigger = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (!sessionId) { trigger.current = async () => {}; return; }
    const controller = new AbortController();
    let pending: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      if (pending) return pending;
      pending = api<RuntimeSolutionSelection[] | Read>(`/sessions/${sessionId}/solutions?scope=${scope}`, 'GET', undefined,
        AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]))
        .then(result => {
          const next = Array.isArray(result) ? { items: result, unavailable: false } : result;
          if (!controller.signal.aborted) setState(prior => prior?.sessionId === sessionId && prior.unavailable === next.unavailable && JSON.stringify(prior.items) === JSON.stringify(next.items)
            ? prior : { sessionId, ...next });
        }).catch(() => {
          if (!controller.signal.aborted) setState(prior => ({ sessionId, items: prior?.sessionId === sessionId ? prior.items : [], unavailable: true }));
        }).finally(() => { pending = undefined; });
      return pending;
    };
    const poll = async () => {
      if (!document.hidden) await read();
      if (!controller.signal.aborted) timer = setTimeout(poll, 5_000);
    };
    const refresh = async () => {
      // A read started before an answer must not restore the answered question.
      await pending;
      if (!controller.signal.aborted) await read();
    };
    trigger.current = refresh;
    const focus = () => { if (!document.hidden) void read(); };
    document.addEventListener('visibilitychange', focus);
    window.addEventListener('focus', focus);
    void poll();
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', focus); window.removeEventListener('focus', focus); };
  }, [sessionId, scope]);
  return { items: state?.sessionId === sessionId ? state.items : undefined,
    unavailable: state?.sessionId === sessionId && state.unavailable,
    refresh: useCallback(() => trigger.current(), []) };
}

export function useConversationSolutions(sessionId: string | null) {
  const local = useQuestionRead(sessionId, 'local');
  const remote = useQuestionRead(sessionId, 'remote');
  return {
    items: local.items || remote.items ? [...local.items ?? [], ...remote.items ?? []] : undefined,
    unavailable: local.unavailable,
    remoteUnavailable: remote.unavailable,
    refresh: useCallback(async (selectionId?: string) => {
      if (selectionId) await (selectionId.startsWith('remote_solution_') ? remote.refresh() : local.refresh());
      else await Promise.all([local.refresh(), remote.refresh()]);
    }, [local.refresh, remote.refresh]),
  };
}
