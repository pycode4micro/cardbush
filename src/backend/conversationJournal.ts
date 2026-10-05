import { ASSISTANT_CONVERSATION_COMMAND, type ConversationEntry } from '@cardbush/bush-protocol';
import { createDesktopRuntimeSession } from '../runtime-client/ElectronRuntimeSession';
import type { ChatMessage } from '../types';

export interface ConversationJournalSnapshot { entries: ConversationEntry[]; cursor: number; busy: boolean; error: string; workingTasks?: number; generation?: number }
export async function conversationJournalCommand<T = unknown>(payload: unknown): Promise<T> {
  const runtime = createDesktopRuntimeSession();
  try { return await runtime.client.command({ kind: ASSISTANT_CONVERSATION_COMMAND, payload }, value => value as T); }
  finally { runtime.dispose(); }
}
export const readConversationJournal = (sessionId: string, after = 0) => conversationJournalCommand<ConversationJournalSnapshot>({ action: 'read', sessionId, after });
export async function appendConversationEntry(sessionId: string, entry: ConversationEntry, generation?: number) {
  await conversationJournalCommand({ action: 'append', sessionId, entry, generation });
  window.dispatchEvent(new CustomEvent('cardbush:conversation-entry', { detail: { sessionId, entry } }));
}
export function journalMessages(entries: ConversationEntry[], sessionId: string): ChatMessage[] {
  return entries.filter(entry => entry.visibility !== 'internal').map(entry => ({ ...entry, conversationId: sessionId,
    status: 'completed', metadata: { conversation_journal: true, cardbush_terminal_snapshot: entry.role === 'assistant', voice_transcript: entry.source === 'voice' } }));
}
