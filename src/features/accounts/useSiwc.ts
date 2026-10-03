import { useCallback, useEffect, useRef, useState } from 'react';
import { siwcSnapshotSchema, type SiwcSnapshot, type SiwcAction } from '@cardbush/bush-protocol';
import { agentErrorText } from '../agents/agentErrorText';

export function useSiwc() {
  const [snapshot, setSnapshot] = useState<SiwcSnapshot>();
  const [error, setError] = useState('');
  const version = useRef(0), mounted = useRef(false);
  const refresh = useCallback(async () => {
    const current = ++version.current;
    try {
      const value = siwcSnapshotSchema.parse(await window.cardbushDesktop?.siwcSnapshot());
      if (mounted.current && current === version.current) { setSnapshot(value); setError(''); }
    } catch (failure) { if (mounted.current && current === version.current) setError(agentErrorText(failure)); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (!window.cardbushDesktop?.siwcSnapshot) return;
    void refresh(); const unsubscribe = window.cardbushDesktop.onAccountsChanged(refresh);
    return () => { mounted.current = false; version.current++; unsubscribe(); };
  }, [refresh]);
  const action = useCallback(async (input: SiwcAction) => {
    try {
      if (!window.cardbushDesktop?.siwcAction) throw Error('ChatGPT sign-in requires the local CardBush desktop.');
      const value = siwcSnapshotSchema.parse(await window.cardbushDesktop.siwcAction(input));
      if (mounted.current) { version.current++; setSnapshot(value); setError(''); }
      return value;
    } catch (failure) { if (mounted.current) setError(agentErrorText(failure)); return undefined; }
  }, []);
  return { snapshot, error, action, refresh };
}
