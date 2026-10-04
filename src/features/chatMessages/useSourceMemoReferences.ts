import { useContext, useEffect, useMemo, useState } from 'react';
import type { SourceReferences } from '@cardbush/bush-protocol';
import { fetchSourceReferences } from '../../backend/sourceMemo';
import type { ConversationRuntime } from '../../backend/conversationRuntime';
import { ConversationHostContext } from '../conversationHost';
import { FileMemoScopeContext } from './FileMemoScope';
import { sourceMemoCandidates } from './sourceMemoShorthand';

const empty: ReadonlyMap<number, string> = new Map();
export function useSourceMemoReferences(content: string, rich: boolean): ReadonlyMap<number, string> {
  const host = useContext(ConversationHostContext), scope = useContext(FileMemoScopeContext);
  const key = useMemo(() => {
    if (!rich || !scope.sourceReferences || !scope.sessionId || !scope.turnId) return '';
    const numbers = sourceMemoCandidates(content);
    return numbers.length ? JSON.stringify({ sessionId: scope.sessionId, turnId: scope.turnId, numbers }) : '';
  }, [content, rich, scope]);
  const runtime = host?.runtime;
  const [loaded, setLoaded] = useState<{ key: string; runtime?: ConversationRuntime; references: SourceReferences }>();
  useEffect(() => {
    if (!key) return;
    let current = true;
    void fetchSourceReferences(JSON.parse(key), runtime).then(references => {
      if (current) setLoaded({ key, runtime, references });
    }).catch(() => { /* Missing/older hosts leave shorthand as ordinary text. */ });
    return () => { current = false; };
  }, [key, runtime]);
  return useMemo(() => loaded?.key === key && loaded.runtime === runtime
    ? new Map(loaded.references.map(item => [item.number, item.reference])) : empty, [key, runtime, loaded]);
}
