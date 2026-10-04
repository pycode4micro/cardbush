import { createContext, useContext, useMemo, type ReactNode } from 'react';

export const FileMemoScopeContext = createContext({ sessionId: '', turnId: '', sourceReferences: false });

export function FileMemoScope({ sessionId, turnId, sourceReferences, children }: { sessionId?: string; turnId?: string; sourceReferences?: boolean; children: ReactNode }) {
  const parent = useContext(FileMemoScopeContext);
  const effectiveSession = sessionId || parent.sessionId;
  const effectiveTurn = turnId || (effectiveSession === parent.sessionId ? parent.turnId : '');
  const allowSourceReferences = sourceReferences ?? parent.sourceReferences;
  const value = useMemo(() => ({ sessionId: effectiveSession, turnId: effectiveTurn, sourceReferences: allowSourceReferences }), [effectiveSession, effectiveTurn, allowSourceReferences]);
  return <FileMemoScopeContext.Provider value={value}>{children}</FileMemoScopeContext.Provider>;
}
