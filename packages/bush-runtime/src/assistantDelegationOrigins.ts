import { PERSONAL_ASSISTANT_SESSION, type ConversationEntry, type ModelMessage, type ModelRequest } from '@cardbush/bush-protocol';

/** Snapshot the journal references at dispatch, before another turn can change the active request. */
export function assistantDelegationOrigins(request?: ModelRequest) {
  if (request?.sessionId !== PERSONAL_ASSISTANT_SESSION) return {};
  const evidence = request.metadata.assistantEventEvidence;
  if (!Array.isArray(evidence)) return {};
  const ids = evidence.flatMap(item => typeof item?.id === 'string' && item.id.length > 0 && item.id.length <= 220 ? [item.id as string] : []);
  return { originMessageIds: [...new Set(ids)].slice(-256) };
}

export function delegatedRequestContext(origins: ConversationEntry[], journal: ConversationEntry[]): ModelMessage {
  const reference = (entry: ConversationEntry) => ({
    messageId: entry.id, createdAt: entry.createdAt, text: entry.content.slice(0, 2000), truncated: entry.content.length > 2000,
    ...(entry.replyTo ? { replyTo: entry.replyTo } : {}),
  });
  const last = origins.at(-1);
  const later = last ? journal.slice(journal.indexOf(last) + 1).filter(item =>
    item.role === 'user' && ['text', 'voice'].includes(item.source) && !item.id.startsWith('memory-') &&
    (item.botSourceRef === last.botSourceRef || (last.botRecipientKey && item.botRecipientKey === last.botRecipientKey))) : [];
  return { role: 'user', name: 'delegated_user_request', visibility: 'internal', content: JSON.stringify({
    kind: 'historical_assignment', requests: origins.slice(-8).map(reference),
    laterUserMessages: later.slice(-8).map(reference),
  }) };
}
