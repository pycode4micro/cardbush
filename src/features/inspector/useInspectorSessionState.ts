import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';

/** Bind updates to their originating conversation, including delayed callbacks. */
export function useInspectorSessionState<T>(workspaceId: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [values, setValues] = useState<Record<string, T>>({});
  const value = workspaceId in values ? values[workspaceId] : initial;
  const update = useCallback<Dispatch<SetStateAction<T>>>(next => {
    setValues(current => {
      const previous = workspaceId in current ? current[workspaceId] : initial;
      const value = typeof next === 'function' ? (next as (previous: T) => T)(previous) : next;
      return Object.is(previous, value) ? current : { ...current, [workspaceId]: value };
    });
  }, [workspaceId, initial]);
  return [value, update];
}

export function useInspectorSessionRef<T>(workspaceId: string, initial: T) {
  const refs = useRef(new Map<string, { current: T }>());
  let ref = refs.current.get(workspaceId);
  if (!ref) { ref = { current: initial }; refs.current.set(workspaceId, ref); }
  return ref;
}
