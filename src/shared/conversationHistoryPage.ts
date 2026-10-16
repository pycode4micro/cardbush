import type { SessionMessagesResult } from '../backend/api';
import type { ChatMessage } from '../types';

export type ConversationHistoryPage = NonNullable<SessionMessagesResult['historyPage']>;

/** Retain a contiguous window already read by the user when refreshing its tail. */
export function mergeConversationHistoryPage(existing: ChatMessage[], result: SessionMessagesResult, previous?: ConversationHistoryPage): SessionMessagesResult {
  const page = result.historyPage;
  if (!page || !previous || page.historyRevision !== previous.historyRevision) return result;
  const lastSequence = Math.max(0, ...existing.map(message => message.turnSequence ?? 0));
  if (lastSequence < page.firstTurnSequence - 1) return result;
  const oldestDate = result.messages[0]?.createdAt;
  const older = existing.filter(message => message.turnSequence
    ? message.turnSequence < page.firstTurnSequence
    : message.metadata?.conversation_journal && oldestDate && message.createdAt && message.createdAt < oldestDate);
  if (!older.length) return result;
  return { ...result, messages: [...older, ...result.messages], historyPage: { ...page,
    nextCursor: previous.nextCursor, firstTurnSequence: previous.firstTurnSequence } };
}
