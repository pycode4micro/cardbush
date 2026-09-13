import { RUNTIME_REVERTED_WORKSPACE_CHANGE_IDS_METADATA_KEY, type WorkspaceReview } from '@cardbush/bush-protocol';
import type { ChatToolExecution } from '../types';

/** Keep reverted changes reviewable so users can restore them, including after a restart. */
export function markRevertedWorkspaceToolExecution(
  execution: ChatToolExecution,
  sessionMetadata: Record<string, unknown> | undefined,
): ChatToolExecution {
  const ids = sessionMetadata?.[RUNTIME_REVERTED_WORKSPACE_CHANGE_IDS_METADATA_KEY];
  const changes = execution.metadata?.workspaceChanges;
  if (!Array.isArray(ids) || !Array.isArray(changes) || changes.length === 0) return execution;
  const reverted = new Set(ids);
  const status = changes.every(change => reverted.has((change as { change_id?: string }).change_id)) ? 'reverted' : 'active';
  return { ...execution, metadata: { ...execution.metadata, revert_status: status } };
}

/** Renderer projection of workspace facts; these rows are never model Tool calls. */
export function workspaceCheckpointExecutions(review: WorkspaceReview | null): ChatToolExecution[] {
  return (review?.checkpoints ?? []).filter(checkpoint => checkpoint.status === 'complete' || checkpoint.status === 'reverted')
    .map(checkpoint => ({
      id: `workspace_checkpoint:${review!.workspace.sessionId}:${checkpoint.turnId}`,
      name: 'workspace_checkpoint', state: 'completed', summary: 'Workspace changes', output: '', success: true,
      durationMs: 0, createdAt: checkpoint.createdAt, contentOffset: 0, sequence: Number.MAX_SAFE_INTEGER,
      turnId: checkpoint.turnId,
      metadata: {
        kind: 'file_change', workspaceCheckpoint: true, workspaceChanges: checkpoint.changes,
        revert_status: checkpoint.status === 'reverted' ? 'reverted' : 'active',
      },
    }));
}

export function coverWorkspaceToolExecution(execution: ChatToolExecution, review: WorkspaceReview | null): ChatToolExecution {
  const checkpoint = review?.checkpoints.find(item => item.turnId === execution.turnId);
  if (!checkpoint || (checkpoint.status !== 'complete' && checkpoint.status !== 'reverted')) return execution;
  const changes = execution.metadata?.workspaceChanges;
  if (Array.isArray(changes) && changes.some(change => {
    const value = change as { path?: string; metadata?: { workspaceVersioned?: boolean } };
    return value.metadata?.workspaceVersioned === false || (value.metadata?.workspaceVersioned !== true && !checkpoint.changes.some(item => item.path === value.path));
  })) return execution;
  return { ...execution, metadata: { ...execution.metadata, workspaceCheckpointCovered: true, workspaceChangeDetailsDeferred: false } };
}
