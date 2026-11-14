import { useCallback, useEffect, useRef, useState } from 'react';
import type { RuntimeSolutionSelection } from '@cardbush/bush-protocol';
import { api } from './api';

/** Questions can arrive while the parent's SSE is idle in await_subagents.
 * Poll only this small resource; never reload the transcript or replay a task. */
export function useConversationSolutions(sessionId: string | null) {
  const [state, setState] = useState<{ sessionId: string; items: RuntimeSolutionSelection[]; unavailable: boolean }>();
  const trigger = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (!sessionId) { trigger.current = async () => {}; return; }
    const controller = new AbortController();
    let pending: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      if (pending) return pending;
      pending = api<RuntimeSolutionSelection[]>(`/sessions/${sessionId}/solutions`, 'GET', undefined,
        AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]))
        .then(items => {
          if (!controller.signal.aborted) setState(prior => prior?.sessionId === sessionId && !prior.unavailable && JSON.stringify(prior.items) === JSON.stringify(items)
            ? prior : { sessionId, items, unavailable: false });
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
  }, [sessionId]);
  return { items: state?.sessionId === sessionId ? state.items : undefined,
    unavailable: state?.sessionId === sessionId && state.unavailable,
    refresh: useCallback(() => trigger.current(), []) };
}
