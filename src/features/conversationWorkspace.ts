import type { ConversationSummary } from '../types';

export function conversationProjectDir(conversation?: ConversationSummary | null) {
  if (conversation?.workspaceContext?.mode === 'task') {
    return '';
  }
  return (
    conversation?.projectDir?.trim() ||
    (conversation?.workspaceContext?.mode === 'project'
      ? conversation.workspaceContext.projectDir?.trim() || ''
      : '') ||
    ''
  );
}

export function conversationWorkspaceRoot(conversation?: ConversationSummary | null) {
  return (
    conversationProjectDir(conversation) ||
    conversation?.workspaceContext?.executionRoot?.trim() ||
    ''
  );
}

export function changeRootForConversation(conversation?: ConversationSummary | null) {
  return conversationWorkspaceRoot(conversation);
}
