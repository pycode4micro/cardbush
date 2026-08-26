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

function normalizedWorkspacePath(value: unknown) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function hasTaskWorkspaceIdentity(
  conversation?: ConversationSummary | null,
) {
  if (!conversation) return false;
  const metadata = conversation.metadata ?? {};
  const taskRoots = [
    conversation.workspaceContext?.taskDir,
    metadata.task_dir,
    metadata.taskDir,
    metadata.session_workspace_dir,
    metadata.sessionWorkspaceDir,
    metadata.session_workspace_alias_path,
    metadata.sessionWorkspaceAliasPath,
  ]
    .map(normalizedWorkspacePath)
    .filter(Boolean);
  if (taskRoots.length === 0) return false;

  const executionRoots = [
    conversation.projectDir,
    conversation.workspaceContext?.projectDir,
    conversation.workspaceContext?.executionRoot,
    metadata.project_dir,
    metadata.projectDir,
    metadata.user_project_dir,
    metadata.userProjectDir,
    metadata.workspace_dir,
    metadata.workspaceDir,
  ]
    .map(normalizedWorkspacePath)
    .filter(Boolean);

  return executionRoots.length === 0 || executionRoots.every((root) => taskRoots.includes(root));
}

export function conversationWorkspaceMode(
  conversation?: ConversationSummary | null,
) {
  // A task session can be polluted by an older client that echoed its
  // generated task directory back as project_dir. The task directory is an
  // execution root, not a user project, so its stronger identity wins over
  // stale workspace_mode/project_dir metadata.
  if (hasTaskWorkspaceIdentity(conversation)) return 'task';
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
