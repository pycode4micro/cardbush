import type { SessionAttentionState } from '../../types';
import type { ConversationEventResult } from '../automations/conversationEventResults';

export type WorkspaceNotice =
  | { type: 'event'; key: string; at: string; item: ConversationEventResult }
  | { type: 'session'; key: string; at: string; item: SessionAttentionState };

/** Each result keeps its scheduler receipt; opening a session only clears its own completion. */
export function workspaceInbox(sessions: Record<string, SessionAttentionState>, events: ConversationEventResult[]) {
  const attentionByConversation = { ...sessions };
  const notices: WorkspaceNotice[] = Object.values(sessions).map(item => ({
    type: 'session', key: 'session:' + item.sessionId, at: item.updatedAt, item,
  }));
  for (const item of events) {
    notices.push({ type: 'event', key: 'event:' + item.runId, at: item.finishedAt, item });
    // The sidebar has one indicator per conversation. Never replace an actionable session request.
    attentionByConversation[item.sourceId] ??= { sessionId: item.sourceId, turnId: item.turnId,
      kind: item.status === 'failed' || item.status === 'interrupted' ? 'error' : 'completed',
      title: item.title, body: item.summary, updatedAt: item.finishedAt };
  }
  notices.sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key));
  return { notices, attentionByConversation };
}
