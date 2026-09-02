import type { ConversationSummary } from '../types';
import {
  isAbsoluteLocalPath,
  samePath,
  stripWrappingQuotes,
} from '../shared/localPaths';
import {
  conversationProjectDir,
  isOnlyTalkConversation,
} from './conversationWorkspace';

export type ConversationScope =
  | { mode: 'task' }
  | { mode: 'project'; projectId?: string; projectDir: string };

export interface ProjectPathAlias {
  from: string;
  to: string;
}

export function conversationProjectId(
  conversation?: ConversationSummary | null,
): string {
  if (!conversation) return '';
  const direct = conversation.projectId?.trim();
  if (direct) return direct;
  const metadata = conversation.metadata ?? {};
  for (const value of [metadata.project_id, metadata.projectId]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function conversationProjectPathAliases(
  conversation?: ConversationSummary | null,
): ProjectPathAlias[] {
  const value = conversation?.metadata?.project_path_aliases;
  if (!Array.isArray(value)) return [];
  const projectRoot = conversationProjectDir(conversation);
  if (!projectRoot) return [];
  const aliases = value.flatMap((candidate) => {
    if (candidate == null || typeof candidate !== 'object') return [];
    const record = candidate as Record<string, unknown>;
    const from = String(record.from ?? '').trim();
    const to = String(record.to ?? '').trim();
    return from &&
      to &&
      isAbsoluteLocalPath(from) &&
      isAbsoluteLocalPath(to) &&
      !samePath(from, to)
      ? [{ from, to }]
      : [];
  });
  return aliases.filter((alias) => aliasReachesProjectRoot(alias, aliases, projectRoot));
}

function aliasReachesProjectRoot(
  alias: ProjectPathAlias,
  aliases: ProjectPathAlias[],
  projectRoot: string,
) {
  let current = alias.to;
  const visited = new Set<string>();
  for (let step = 0; step <= aliases.length; step += 1) {
    if (samePath(current, projectRoot)) return true;
    const identity = current.replaceAll('\\', '/').toLocaleLowerCase();
    if (visited.has(identity)) return false;
    visited.add(identity);
    const next = aliases.find((candidate) => samePath(candidate.from, current));
    if (!next) return false;
    current = next.to;
  }
  return false;
}

export function remapProjectPath(pathValue: string, aliases: ProjectPathAlias[]) {
  let current = stripWrappingQuotes(pathValue.trim());
  if (!current || !isAbsoluteLocalPath(current) || aliases.length === 0) return current;
  const visited = new Set<string>();
  for (let step = 0; step <= aliases.length; step += 1) {
    const normalizedCurrent = current.replaceAll('\\', '/');
    const identity = normalizedCurrent.toLocaleLowerCase();
    if (visited.has(identity)) break;
    visited.add(identity);
    const alias = aliases.find((candidate) => {
      const from = candidate.from.trim().replaceAll('\\', '/').replace(/\/+$/, '');
      const normalizedFrom = from.toLocaleLowerCase();
      return identity === normalizedFrom || identity.startsWith(`${normalizedFrom}/`);
    });
    if (!alias) break;
    const from = alias.from.trim().replaceAll('\\', '/').replace(/\/+$/, '');
    const suffix = normalizedCurrent.slice(from.length).replace(/^\/+/, '');
    const separator = alias.to.includes('\\') ? '\\' : '/';
    current = suffix
      ? `${alias.to.replace(/[\\/]+$/, '')}${separator}${suffix.replaceAll('/', separator)}`
      : alias.to;
  }
  return current;
}

export function conversationMatchesScope(
  conversation: ConversationSummary | null | undefined,
  scope: ConversationScope,
): boolean {
  if (!conversation) return false;
  if (scope.mode === 'task') return isOnlyTalkConversation(conversation);
  if (isOnlyTalkConversation(conversation)) return false;
  const sessionProjectId = conversationProjectId(conversation);
  const scopeProjectId = scope.projectId?.trim() ?? '';
  if (sessionProjectId && scopeProjectId) return sessionProjectId === scopeProjectId;
  const projectDir = conversationProjectDir(conversation);
  return Boolean(projectDir && scope.projectDir && samePath(projectDir, scope.projectDir));
}

export function firstConversationInScope(
  conversations: ConversationSummary[],
  scope: ConversationScope,
): ConversationSummary | undefined {
  return conversations.find((conversation) => conversationMatchesScope(conversation, scope));
}

export function conversationScopeKey(scope: ConversationScope): string {
  if (scope.mode === 'task') return 'task';
  const projectId = scope.projectId?.trim();
  if (projectId) return `project:${projectId}`;
  return `project-path:${scope.projectDir.trim().replaceAll('\\', '/').toLowerCase()}`;
}
