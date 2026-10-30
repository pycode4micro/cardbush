import { useContext, useEffect, useMemo, useState } from 'react';
import type { SourceReferences } from '@cardbush/bush-protocol';
import { fetchSourceReferences } from '../../backend/sourceMemo';
import type { ConversationRuntime } from '../../backend/conversationRuntime';
import { ConversationHostContext } from '../conversationHost';
import { FileMemoScopeContext } from './FileMemoScope';
import { sourceMemoCandidates } from './sourceMemoShorthand';

const empty = { references: new Map<number, string>(), unresolved: new Set<number>() };
export function useSourceMemoReferences(content: string) {
  const host = useContext(ConversationHostContext), scope = useContext(FileMemoScopeContext);
  const key = useMemo(() => {
    if (!scope.sourceReferences || !scope.sessionId || !scope.turnId) return '';
    const numbers = sourceMemoCandidates(content);
    return numbers.length ? JSON.stringify({ sessionId: scope.sessionId, turnId: scope.turnId, numbers }) : '';
  }, [content, scope]);
  const runtime = host?.runtime;
  const [loaded, setLoaded] = useState<{ key: string; runtime?: ConversationRuntime; references: SourceReferences }>();
  useEffect(() => {
    if (!key) return;
    let current = true;
    void fetchSourceReferences(JSON.parse(key), runtime).then(references => {
      if (current) setLoaded({ key, runtime, references });
    }).catch(() => {
      if (current) setLoaded({ key, runtime, references: [] });
    });
    return () => { current = false; };
  }, [key, runtime]);
  return useMemo(() => {
    if (!key || loaded?.key !== key || loaded.runtime !== runtime) return empty;
    const references = new Map(loaded.references.map(item => [item.number, item.reference]));
    // A display number is not a source identity. Never guess a prior turn's memo.
    const numbers: number[] = JSON.parse(key).numbers;
    return { references, unresolved: new Set(numbers.filter(number => !references.has(number))) };
  }, [key, runtime, loaded]);
}
