import { uiText } from '../../i18n';
import { GitBranchMenu } from './GitBranchMenu';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceReview } from '@cardbush/bush-protocol';
import { createDesktopRuntimeSession } from '../../runtime-client/ElectronRuntimeSession';
import './taskWorkspace.css';

export function TaskWorkspaceBar({ sessionId, projectDir, language, busy, gitAvailable = false, revisionKey, onChanged }: {
  sessionId: string; projectDir: string; language: string; busy: boolean; revisionKey?: string;
  gitAvailable?: boolean;
  onChanged: () => Promise<void>;
}) {

  const [review, setReview] = useState<WorkspaceReview | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [supported, setSupported] = useState(false);
  const readSequence = useRef(0);
  const load = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++readSequence.current;
    let runtime: ReturnType<typeof createDesktopRuntimeSession> | undefined;
    setLoading(true);
    try {
      runtime = createDesktopRuntimeSession();
      const capabilities = await runtime.client.getCapabilities(signal);
      if (!capabilities.features.includes('task_workspaces')) return;
      if (signal?.aborted || sequence !== readSequence.current) return;
      setSupported(true);
      const result = await runtime.client.getWorkspace(sessionId, signal);
      if (!signal?.aborted && sequence === readSequence.current) { setReview(result); setError(''); }
    } catch (caught) { if (!signal?.aborted && sequence === readSequence.current) setError((caught as Error).message); }
    finally { runtime?.dispose(); if (sequence === readSequence.current) setLoading(false); }
  }, [sessionId]);
  useEffect(() => {
    const controller = new AbortController();
    if (sessionId && projectDir && !busy) void load(controller.signal);
    return () => controller.abort();
  }, [sessionId, projectDir, busy, revisionKey, load]);

  async function act(action: 'apply' | 'discard' | 'use_direct' | 'checkpoint' | 'stop_terminals' | 'init_git') {
    if (!review || working || busy || loading) return;
    const prompts = {
      apply: uiText(language)('taskWorkspaceBar.applyTheReviewedChangesInFilesTo', { value1: review.changes.length, value2: review.workspace.sourceDir }),
      discard: uiText(language)('taskWorkspaceBar.deleteThisTaskCopyIncludingUnappliedChanges'),
      use_direct: uiText(language)('taskWorkspaceBar.switchToEditingTheSourceProjectDirectly'),
      checkpoint: '',
      stop_terminals: uiText(language)('taskWorkspaceBar.stopTheRunningTerminalsStartedByRuntime'),
      init_git: review.workspace.versioningError
        ? (uiText(language)('taskWorkspaceBar.retryEnablingGitVersionsFor', { value1: review.workspace.sourceDir }))
        : (uiText(language)('taskWorkspaceBar.createAGitRepositoryInToEnable', { value1: review.workspace.sourceDir })),
    };
    if (prompts[action] && !window.confirm(prompts[action])) return;
    setWorking(true); setError('');
    let runtime: ReturnType<typeof createDesktopRuntimeSession> | undefined;
    try {
      runtime = createDesktopRuntimeSession();
      await runtime.client.updateWorkspace({ sessionId, action, expectedRevision: review.workspace.revision, expectedSnapshotId: review.snapshotId });
      await load();
      await onChanged();
    } catch (caught) { setError((caught as Error).message); }
    finally { runtime?.dispose(); setWorking(false); }
  }

  if (!projectDir || (!supported && !error && !gitAvailable)) return null;
  const workspace = review?.workspace;
  const disabled = busy || working || loading;
  const incomplete = review?.checkpoints.some(checkpoint => checkpoint.status === 'failed' || checkpoint.status === 'pending');
  const attention = Boolean(error || review?.error || workspace?.versioningError || incomplete || workspace?.status === 'discarded');
  const count = review?.changes.length ?? 0;
  const summary = attention
    ? (uiText(language)('taskWorkspaceBar.workspaceNeedsAttention'))
    : count > 0
      ? (uiText(language)('taskWorkspaceBar.files', { value1: count, value2: (workspace?.mode === 'worktree' ? uiText(language)('taskWorkspaceBar.pending') : uiText(language)('taskWorkspaceBar.changed')) }))
      : (uiText(language)('taskWorkspaceBar.workspaceActions'));
  return <div className="task-workspace-bar">
    <details className="task-workspace-details">
      <summary className={attention ? 'task-workspace-error' : undefined}>{summary}</summary>
    {!workspace ? <>
      <p>{uiText(language)('taskWorkspaceBar.tasksAutomaticallyUseTheCurrentProjectDirectory')}</p>
    </> : <>
      <div className="task-workspace-heading">
        <span>{workspace.status === 'discarded' ? (uiText(language)('taskWorkspaceBar.taskCopyDiscarded')) : workspace.mode === 'worktree' ? (uiText(language)('taskWorkspaceBar.taskCopy')) : (uiText(language)('taskWorkspaceBar.projectDirectory'))}</span>
        <code title={workspace.workspaceDir}>{workspace.workspaceDir}</code>
      </div>
      {workspace.status === 'ready' && <>
        <div className="task-workspace-actions">
          <button disabled={disabled} onClick={() => void load()}>{uiText(language)('automationPanel.refresh')}</button>
          {workspace.mode === 'worktree' && <button disabled={disabled || !review?.changes.length || Boolean(review.error) || incomplete || review.runningTerminals} onClick={() => void act('apply')}>{uiText(language)('taskWorkspaceBar.applyToSource')}</button>}
          {workspace.mode === 'worktree' && review.checkpoints.length === 0 && <button disabled={disabled || review.runningTerminals} onClick={() => void act('use_direct')}>{uiText(language)('taskWorkspaceBar.useSourceDirectory')}</button>}
          {!workspace.workspaceDir.startsWith('ssh://') && workspace.mode === 'direct' && workspace.versioning === 'none' && <button disabled={disabled || review.runningTerminals} onClick={() => void act('init_git')}>{workspace.versioningError ? (uiText(language)('taskWorkspaceBar.retryGitVersions')) : (uiText(language)('taskWorkspaceBar.createGitRepository'))}</button>}
          {incomplete && <button disabled={disabled || review.runningTerminals} onClick={() => void act('checkpoint')}>{uiText(language)('taskWorkspaceBar.recoverCheckpoint')}</button>}
          {review.runningTerminals && <button disabled={disabled} onClick={() => void act('stop_terminals')}>{uiText(language)('taskWorkspaceBar.stopWorkspaceTerminals')}</button>}
          {workspace.mode === 'worktree' && <button disabled={disabled || Boolean(review.error) || review.runningTerminals} onClick={() => void act('discard')}>{uiText(language)('taskWorkspaceBar.discardCopy')}</button>}
        </div>
        {workspace.versioning === 'none' ? <>
          <p>{workspace.versioningError || (workspace.workspaceDir.startsWith('ssh://') ? (uiText(language)('taskWorkspaceBar.sshFileToolEditsAreAvailableFor')) : (uiText(language)('taskWorkspaceBar.gitIsNotEnabledForThisDirectory')))}</p>
        </> : <details className="task-workspace-review">
          <summary>{uiText(language)('taskWorkspaceBar.reviewChanges', { value1: review.changes.length, value2: (workspace.mode === 'worktree' ? uiText(language)('taskWorkspaceBar.filesPending') : uiText(language)('taskWorkspaceBar.filesChangedInThisTask')) })}</summary>
          <p>{uiText(language)('taskWorkspaceBar.gitVersionsCoverTrackedAndNewNon')}</p>
          {review.changes.map(change => <details key={change.change_id}>
            <summary>{change.status} · {change.path}</summary>
            <pre>{String(change.metadata.diff ?? '')}</pre>
          </details>)}
        </details>}
      </>}
    </>}
    {gitAvailable && (!workspace || (workspace.status === 'ready' && workspace.versioning !== 'none')) && (
      <details className="task-workspace-branches" onToggle={(event) => setBranchesOpen(event.currentTarget.open)}>
        <summary>{uiText(language)('taskWorkspaceBar.gitBranches')}</summary>
        {branchesOpen && <GitBranchMenu key={workspace?.workspaceDir || projectDir} language={language} activeProjectDir={workspace?.workspaceDir || projectDir} disabled={disabled} onChanged={onChanged} />}
      </details>
    )}
    {(error || review?.error) && <p className="task-workspace-error" role="alert">{error || review?.error}</p>}
    {review?.runningTerminals && <p>{uiText(language)('taskWorkspaceBar.workspaceTerminalsAreRunningYouCanContinue')}</p>}
    {review?.checkpoints.filter(checkpoint => checkpoint.status === 'failed' || checkpoint.status === 'pending').map(checkpoint =>
      <p className="task-workspace-error" key={checkpoint.turnId}>{checkpoint.error || (uiText(language)('taskWorkspaceBar.checkpointIsIncomplete'))}</p>)}
    </details>
  </div>;
}
