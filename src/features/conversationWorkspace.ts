import type { ConversationSummary } from '../types';

function metadataText(
  conversation: ConversationSummary | null | undefined,
  ...keys: string[]
) {
  const metadata = conversation?.metadata;
  if (!metadata) return '';
  for (const key of keys) {
    const value = String(metadata[key] ?? '').trim();
    if (value) return value;
  }
  return '';
}

export function conversationWorkspaceMode(
  conversation?: ConversationSummary | null,
) {
  const metadataMode = metadataText(
    conversation,
    'workspace_mode',
    'workspaceMode',
  ).toLowerCase();
  if (metadataMode === 'task') return 'task';
  if (metadataMode === 'project' || metadataMode === 'workspace') return 'project';
  return conversation?.workspaceContext?.mode;
}

export function conversationProjectDir(conversation?: ConversationSummary | null) {
  if (conversationWorkspaceMode(conversation) === 'task') {
    return '';
  }
  return (
    conversation?.projectDir?.trim() ||
    (conversationWorkspaceMode(conversation) === 'project'
      ? conversation?.workspaceContext?.projectDir?.trim() || ''
      : '') ||
    ''
  );
}

export function isOnlyTalkConversation(
  conversation?: ConversationSummary | null,
) {
  if (!conversation) return false;
  const metadata = conversation.metadata;
  const runtimeMode = metadataText(
    conversation,
    'runtime_mode',
    'runtimeMode',
  ).toLowerCase();
  if (
    metadata?.os_mode_enabled === true ||
    metadata?.osModeEnabled === true ||
    runtimeMode === 'desktop_os'
  ) {
    return false;
  }
  const mode = conversationWorkspaceMode(conversation);
  if (mode === 'task') return true;
  if (mode === 'project') return false;
  return !conversationProjectDir(conversation);
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
