import { conversationWorkspaceRoot } from '../conversationWorkspace';
import type { ConversationSummary } from '../../types';

type TeamConversation = { sessionId: string; root: string; draft?: boolean };
const storageKey = 'cardbush.team-conversations.v1';
const conversations = new Map<string, TeamConversation>();
try {
  const stored: unknown = JSON.parse(localStorage.getItem(storageKey) || '{}');
  if (stored && typeof stored === 'object') for (const [id, value] of Object.entries(stored)) {
    if (value && typeof value.sessionId === 'string' && typeof value.root === 'string' && value.sessionId && (value.root || value.draft === true)) conversations.set(id, value);
  }
} catch { /* A corrupt UI preference must not prevent a new conversation. */ }

function persist() { try { localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(conversations))); } catch { /* Keep this session available in memory. */ } }

/** Start a fresh chat without deleting the workflow or any previous conversation. */
export function resetTeamConversation(teamId: string) {
  conversations.delete(teamId); persist();
}

export function prepareTeamConversation(teamId: string): TeamConversation {
  const existing = conversations.get(teamId);
  if (existing) return existing;
  const value = { sessionId: `local-${crypto.randomUUID()}`, root: '', draft: true };
  conversations.set(teamId, value); persist(); return value;
}

export function persistTeamConversation(teamId: string, conversation: ConversationSummary) {
  // A previous chat can finish creating after the user starts a fresh one.
  if (conversations.get(teamId)?.sessionId !== conversation.id) return;
  conversations.set(teamId, { sessionId: conversation.id, root: conversationWorkspaceRoot(conversation) }); persist();
}
