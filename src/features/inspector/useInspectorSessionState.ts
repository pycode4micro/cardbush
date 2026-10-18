import { useCallback, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { adoptInspectorSessionState, onInspectorDraftAdopted } from './inspectorSessions';

/** Bind updates to their originating conversation, including delayed callbacks. */
export function useInspectorSessionState<T>(workspaceId: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [values, setValues] = useState<Record<string, T>>({});
  const owner = useInspectorSessionRef(workspaceId, null);
  useLayoutEffect(() => onInspectorDraftAdopted(adoption => setValues(current => adoptInspectorSessionState(current, adoption))), []);
  const value = workspaceId in values ? values[workspaceId] : initial;
  const update = useCallback<Dispatch<SetStateAction<T>>>(next => {
    const workspaceId = owner.workspaceId;
    setValues(current => {
      const previous = workspaceId in current ? current[workspaceId] : initial;
      const value = typeof next === 'function' ? (next as (previous: T) => T)(previous) : next;
      return Object.is(previous, value) ? current : { ...current, [workspaceId]: value };
    });
  }, [owner, initial]);
  return [value, update];
}

export function useInspectorSessionRef<T>(workspaceId: string, initial: T) {
  const refs = useRef(new Map<string, { current: T; workspaceId: string }>());
  useLayoutEffect(() => onInspectorDraftAdopted(({ from, to }) => {
    const ref = refs.current.get(from);
    if (!ref || from === to) return;
    ref.workspaceId = to;
    refs.current.set(to, ref);
    refs.current.delete(from);
  }), []);
  let ref = refs.current.get(workspaceId);
  if (!ref) { ref = { current: initial, workspaceId }; refs.current.set(workspaceId, ref); }
  return ref;
}
