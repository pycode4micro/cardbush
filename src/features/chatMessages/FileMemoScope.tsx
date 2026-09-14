import { createContext, useContext, useMemo, type ReactNode } from 'react';

export const FileMemoScopeContext = createContext({ sessionId: '', turnId: '' });

export function FileMemoScope({ sessionId, turnId, children }: { sessionId?: string; turnId?: string; children: ReactNode }) {
  const parent = useContext(FileMemoScopeContext);
  const effectiveSession = sessionId || parent.sessionId;
  const effectiveTurn = turnId || (effectiveSession === parent.sessionId ? parent.turnId : '');
  const value = useMemo(() => ({ sessionId: effectiveSession, turnId: effectiveTurn }), [effectiveSession, effectiveTurn]);
  return <FileMemoScopeContext.Provider value={value}>{children}</FileMemoScopeContext.Provider>;
}
