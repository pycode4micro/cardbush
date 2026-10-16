import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { fetchSessionMessages, SessionMessagesResult } from '../backend/api';
import type { ChatMessage } from '../types';
import { mergeConversationHistoryPage, type ConversationHistoryPage } from '../shared/conversationHistoryPage';

/** Paging is UI state; the Runtime journal and existing read fences still own facts. */
export function useConversationHistoryPages(input: {
  read: typeof fetchSessionMessages; activeId: string; messages: Record<string, ChatMessage[]>;
  setMessages: Dispatch<SetStateAction<Record<string, ChatMessage[]>>>;
  refresh?: (id: string) => Promise<unknown>;
}) {
  const current = useRef(input); current.current = input;
  const pages = useRef(new Map<string, ConversationHistoryPage>());
  const epochs = useRef(new Map<string, number>());
  const sequence = useRef(0);
  const previousMessages = useRef(input.messages);
  const pending = useRef(new Map<string, AbortController>());
  const invalidated = useRef(new Set<string>());
  const [revision, setRevision] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const changed = useCallback(() => setRevision(value => value + 1), []);
  const advance = (id: string) => { const next = ++sequence.current; epochs.current.set(id, next); return next; };
  const read = useCallback(async (id: string, options: Parameters<typeof fetchSessionMessages>[1] = {}): Promise<SessionMessagesResult> => {
    const epoch = advance(id), baseline = current.current.messages[id], previous = pages.current.get(id);
    const result = await current.current.read(id, { ...options, page: options.page ?? {} });
    if (epochs.current.get(id) !== epoch || current.current.messages[id] !== baseline) return result;
    const merged = mergeConversationHistoryPage(baseline ?? [], result, previous);
    if (merged.historyPage) pages.current.set(id, merged.historyPage); else pages.current.delete(id);
    invalidated.current.delete(id);
    setErrors(value => { if (!value[id]) return value; const next = { ...value }; delete next[id]; return next; });
    changed();
    return merged;
  }, [changed]);
  const readMessages = useCallback(async (id: string, options?: Parameters<typeof fetchSessionMessages>[1]) => (await read(id, options)).messages, [read]);

  const loadOlder = useCallback(async (beforeApply?: () => void) => {
    const id = current.current.activeId, page = pages.current.get(id), baseline = current.current.messages[id];
    if (!page?.nextCursor || !baseline || pending.current.has(id)) return;
    const controller = new AbortController(), epoch = advance(id);
    pending.current.set(id, controller); changed();
    setErrors(value => ({ ...value, [id]: '' }));
    try {
      if (invalidated.current.has(id) && current.current.refresh) {
        await current.current.refresh(id); return;
      }
      const result = await current.current.read(id, { includeSuperseded: true, page: { cursor: page.nextCursor }, signal: controller.signal });
      if (controller.signal.aborted || epochs.current.get(id) !== epoch || !current.current.messages[id]) return;
      if (!result.historyPage || result.historyPage.historyRevision !== page.historyRevision) throw Error('Session history changed. Refresh the conversation.');
      if (current.current.messages[id]?.[0] !== baseline[0]) return;
      if (current.current.activeId === id) beforeApply?.();
      current.current.setMessages(value => {
        const messages = value[id];
        if (!messages || epochs.current.get(id) !== epoch || messages[0] !== baseline[0]) return value;
        const ids = new Set(messages.map(message => message.id));
        pages.current.set(id, { ...result.historyPage!, totalTurns: Math.max(page.totalTurns, result.historyPage!.totalTurns) });
        return { ...value, [id]: [...result.messages.filter(message => !ids.has(message.id)), ...messages] };
      });
    } catch (error) {
      if (!controller.signal.aborted && epochs.current.get(id) === epoch) {
        if (/session_history_changed|Session history changed/.test(String(error))) invalidated.current.add(id);
        setErrors(value => ({ ...value, [id]: String(error) }));
      }
    } finally { if (pending.current.get(id) === controller) pending.current.delete(id); changed(); }
  }, [changed]);

  useEffect(() => {
    for (const id of Object.keys(previousMessages.current)) if (!input.messages[id]) {
      pages.current.delete(id); epochs.current.delete(id); pending.current.get(id)?.abort(); pending.current.delete(id);
      invalidated.current.delete(id);
    }
    previousMessages.current = input.messages;
  }, [input.messages]);
  useEffect(() => () => { for (const controller of pending.current.values()) controller.abort(); }, []);
  void revision;
  return { read, readMessages, loadOlder, hasMore: !!pages.current.get(input.activeId)?.nextCursor,
    loadingOlder: pending.current.has(input.activeId), historyError: errors[input.activeId] ?? '', needsRefresh: invalidated.current.has(input.activeId) };
}

export type ConversationHistoryControls = Pick<ReturnType<typeof useConversationHistoryPages>, 'loadOlder' | 'hasMore' | 'loadingOlder' | 'historyError' | 'needsRefresh'>;
