import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceReview } from '@cardbush/bush-protocol';
import { createDesktopRuntimeSession } from '../../runtime-client/ElectronRuntimeSession';
import './taskWorkspace.css';

export function TaskWorkspaceBar({ sessionId, projectDir, language, busy, revisionKey, onChanged }: {
  sessionId: string; projectDir: string; language: 'zh' | 'en'; busy: boolean; revisionKey?: string;
  onChanged: () => Promise<void>;
}) {
  const zh = language === 'zh';
  const [review, setReview] = useState<WorkspaceReview | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [supported, setSupported] = useState(false);
  const readSequence = useRef(0);
  const [mode, setMode] = useState(() => window.localStorage.getItem('cardbush.workspace.mode') === 'worktree' ? 'worktree' : 'direct');
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
      apply: zh ? `将审查中的 ${review.changes.length} 个文件修改应用到 ${review.workspace.sourceDir}？` : `Apply the reviewed changes in ${review.changes.length} files to ${review.workspace.sourceDir}?`,
      discard: zh ? '删除此任务的独立副本，包括未应用的修改和忽略文件？原项目保持原样。' : 'Delete this task copy, including unapplied changes and ignored files? The source project will remain unchanged.',
      use_direct: zh ? '切换到直接修改原项目？仅在任务尚未开始且副本没有新修改时可切换。' : 'Switch to editing the source project directly? This requires an unused, unchanged task copy.',
      checkpoint: '',
      stop_terminals: zh ? '停止 Runtime 在此工作区内启动的运行中终端？' : 'Stop the running terminals started by Runtime inside this workspace?',
      init_git: review.workspace.versioningError
        ? (zh ? `为 ${review.workspace.sourceDir} 重试启用 Git 版本？` : `Retry enabling Git versions for ${review.workspace.sourceDir}?`)
        : (zh ? `在 ${review.workspace.sourceDir} 创建 Git 仓库，启用文件版本与任务撤回？不会自动提交文件。` : `Create a Git repository in ${review.workspace.sourceDir} to enable file versions and task undo? Files will not be committed automatically.`),
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

  if (!projectDir || (!supported && !error)) return null;
  const workspace = review?.workspace;
  const disabled = busy || working || loading;
  const incomplete = review?.checkpoints.some(checkpoint => checkpoint.status === 'failed' || checkpoint.status === 'pending');
  const modeSelector = <label>
    {zh ? '新任务执行位置：' : 'New task environment: '}
    <select aria-label={zh ? '新任务工作区模式' : 'New task workspace mode'} value={mode} onChange={event => {
      const value = event.target.value;
      window.localStorage.setItem('cardbush.workspace.mode', value);
      setMode(value);
    }}>
      <option value="direct">{zh ? 'Local · 原目录' : 'Local · project directory'}</option>
      <option value="worktree">{zh ? 'Worktree · Git 独立副本' : 'Worktree · Git checkout'}</option>
    </select>
  </label>;
  return <div className="task-workspace-bar">
    {!workspace ? <>
      <p>{zh ? 'Local · 当前任务在原项目目录执行。' : 'Local · This task runs in the project directory.'}</p>
      {modeSelector}
    </> : <>
      <div className="task-workspace-heading">
        <span>{workspace.status === 'discarded' ? (zh ? '任务副本已丢弃' : 'Task copy discarded') : workspace.mode === 'worktree' ? 'Worktree' : 'Local'}</span>
        <code title={workspace.workspaceDir}>{workspace.workspaceDir}</code>
      </div>
      {workspace.status === 'ready' && <>
        <div className="task-workspace-actions">
          <button disabled={disabled} onClick={() => void load()}>{zh ? '刷新' : 'Refresh'}</button>
          {workspace.mode === 'worktree' && <button disabled={disabled || !review?.changes.length || Boolean(review.error) || incomplete || review.runningTerminals} onClick={() => void act('apply')}>{zh ? '应用到原项目' : 'Apply to source'}</button>}
          {workspace.mode === 'worktree' && review.checkpoints.length === 0 && <button disabled={disabled || review.runningTerminals} onClick={() => void act('use_direct')}>{zh ? '改为原目录执行' : 'Use source directory'}</button>}
          {workspace.mode === 'direct' && workspace.versioning === 'none' && <button disabled={disabled || review.runningTerminals} onClick={() => void act('init_git')}>{workspace.versioningError ? (zh ? '重试 Git 版本' : 'Retry Git versions') : (zh ? '创建 Git 仓库' : 'Create Git repository')}</button>}
          {incomplete && <button disabled={disabled || review.runningTerminals} onClick={() => void act('checkpoint')}>{zh ? '补建检查点' : 'Recover checkpoint'}</button>}
          {review.runningTerminals && <button disabled={disabled} onClick={() => void act('stop_terminals')}>{zh ? '停止工作区终端' : 'Stop workspace terminals'}</button>}
          {workspace.mode === 'worktree' && <button disabled={disabled || Boolean(review.error) || review.runningTerminals} onClick={() => void act('discard')}>{zh ? '丢弃副本' : 'Discard copy'}</button>}
        </div>
        {workspace.versioning === 'none' ? <>
          <p>{workspace.versioningError || (zh ? '此目录尚未启用 Git。文件工具保留原有撤回能力；Git 版本还可记录终端和脚本的文件修改。' : 'Git is not enabled for this directory. File tools retain their existing undo support; Git versions can also capture file edits made by terminals and scripts.')}</p>
          {modeSelector}
        </> : <details className="task-workspace-review">
          <summary>{zh ? `${review.changes.length} 个文件${workspace.mode === 'worktree' ? '待应用' : '有任务修改'} · 查看修改` : `${review.changes.length} ${workspace.mode === 'worktree' ? 'files pending' : 'files changed in this task'} · Review changes`}</summary>
          <p>{zh ? 'Git 版本覆盖已跟踪文件及未被忽略的新文件。任务修改包含终端、脚本和文件工具产生的变更。' : 'Git versions cover tracked and new non-ignored files, including edits made by terminals, scripts and file tools.'}</p>
          {modeSelector}
          {review.changes.map(change => <details key={change.change_id}>
            <summary>{change.status} · {change.path}</summary>
            <pre>{String(change.metadata.diff ?? '')}</pre>
          </details>)}
        </details>}
      </>}
    </>}
    {(error || review?.error) && <p className="task-workspace-error" role="alert">{error || review?.error}</p>}
    {review?.runningTerminals && <p>{zh ? '工作区终端仍在运行。可继续对话；应用、撤回或丢弃副本前需停止终端。' : 'Workspace terminals are running. You can continue chatting; stop them before applying, reverting or discarding files.'}</p>}
    {review?.checkpoints.filter(checkpoint => checkpoint.status === 'failed' || checkpoint.status === 'pending').map(checkpoint =>
      <p className="task-workspace-error" key={checkpoint.turnId}>{checkpoint.error || (zh ? '检查点尚未完成。' : 'Checkpoint is incomplete.')}</p>)}
  </div>;
}
