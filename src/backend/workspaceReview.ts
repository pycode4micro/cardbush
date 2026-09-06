import type { WorkspaceReview } from '@cardbush/bush-protocol';
import type { ChatToolExecution } from '../types';

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
        ...(checkpoint.status === 'reverted' ? { revert_status: 'reverted' } : {}),
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
