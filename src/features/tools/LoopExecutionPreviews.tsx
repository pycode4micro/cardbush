import { ConversationHostContext } from '../conversationHost';
import { useContext, useEffect, useId, useState, type ReactNode } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, CircleStop, GitFork, LoaderCircle, TriangleAlert, Images } from 'lucide-react';
import type { AppLanguage, ChatMessage, ChatToolArtifact, ChatToolExecution } from '../../types';
import { fetchRuntimeTurnToolExecutionDetails } from '../../backend/api';
import { mediaPresentationKey, ToolMediaContext } from '../chatMessages/mediaPresentation';
import { preserveScrollPositionForToggle } from '../preserveScrollPosition';
import { openWorkSummaryInspector } from '../subagents/subagentObservabilityEvents';
import { subagentTaskPresentation } from '../subagents/subagentTaskPresentation';
import { useLoopSubagentTasks } from '../subagents/useLoopSubagentTasks';
import { ToolImageArtifactViewer } from './ToolImageArtifactViewer';
import { asRecord, parseToolOutputJson } from './toolPayload';
import { activeToolStatusLabel, isToolRunningInContext } from './toolExecutionState';

// Only dispatches create child previews; waiting uses the ordinary tool row.
const agentTools = new Set(['subagent', 'team_delegate']);
const imageTools = new Set(['inject_image_input', 'view_image']);
export const isLoopPreviewExecution = (execution: ChatToolExecution) => agentTools.has(execution.name) || imageTools.has(execution.name);

export function LoopExecutionPreviews({ executions, message, language, active }: {
  executions: ChatToolExecution[]; message: ChatMessage; language: AppLanguage; active: boolean;
}) {
  const media = useContext(ToolMediaContext);
  const [details, setDetails] = useState<ChatToolExecution[]>([]);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const deferred = executions.filter(execution => isLoopPreviewExecution(execution) && execution.metadata.nativeResultDeferred === true)
    .map(execution => execution.id).join('\0');
  const sessionId = message.conversationId ?? '';
  const turnId = executions[0]?.turnId ?? message.turnId ?? '';
  useEffect(() => {
    setDetails([]); setFailed(false);
    if (!deferred || !sessionId || !turnId) return;
    let disposed = false;
    void fetchRuntimeTurnToolExecutionDetails({ sessionId, turnId }).then(value => {
      if (!disposed) setDetails(value);
    }).catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; };
  }, [sessionId, turnId, deferred, retry]);
  const agents = executions.filter(execution => agentTools.has(execution.name));
  const host = useContext(ConversationHostContext);
  const openSummary = host?.openWorkSummary ?? openWorkSummaryInspector;
  const tasks = useLoopSubagentTasks(sessionId, agents.length > 0, active);
  const zh = language === 'zh';
  const imagesByPath = new Map<string, ChatToolArtifact>();
  const imageStates: ReactNode[] = [];
  const agentRows = new Map<string, ReactNode>();
  let viewedImages = true;
  let pendingImages = 0, failedImages = 0, runningAgents = 0, failedAgents = 0;
  for (const base of executions) {
    const execution = details.find(detail => detail.id === base.id) ?? base;
    const images = media.get(execution.id) ?? execution.artifacts ?? [];
    if (!isLoopPreviewExecution(execution) && !images.some(artifact => artifact.type === 'image')) continue;
    if (!agentTools.has(execution.name)) {
      const pending = isToolRunningInContext(execution, active);
      // Pending and cancelled executions also have success=false; state is authoritative.
      const failed = execution.state === 'failed';
      pendingImages += Number(pending);
      failedImages += Number(failed);
      viewedImages &&= imageTools.has(execution.name) && execution.state === 'completed' && !failed;
      for (const artifact of images) if (artifact.type === 'image') {
        imagesByPath.set(mediaPresentationKey(artifact.path), artifact);
      }
      if (!images.some(artifact => artifact.type === 'image')) imageStates.push(
        <span key={execution.id} className="loop-image-status" data-execution-id={execution.id}>
          {pending ? <LoaderCircle size={16} className="spin" /> : failed ? <TriangleAlert size={16} /> :
            execution.state === 'cancelled' ? <CircleStop size={16} /> : <Images size={16} />}
          <span>{pending ? activeToolStatusLabel(execution, language) : failed ? (zh ? '执行失败' : 'Failed') :
            execution.state === 'cancelled' ? (zh ? '已停止' : 'Stopped') : (zh ? '暂无预览' : 'No preview')}</span>
        </span>,
      );
      continue;
    }
    const output = execution.metadata.nativeResult ? asRecord(execution.metadata.nativeResult) : parseToolOutputJson(execution.output);
    const members = Array.isArray(output.members) ? output.members.map(asRecord) : [output];
    const ids = new Set(members.map(item => String(item.taskId ?? '')).filter(Boolean));
    if (Array.isArray(output.taskIds)) output.taskIds.forEach(id => ids.add(String(id)));
    const slots = ids.size ? [...ids] : [''];
    for (const taskId of slots) {
      const key = taskId || execution.id;
      // Repeated dispatch results can refer to the same child. Show that task once.
      if (agentRows.has(key)) continue;
      const task = tasks.find(item => item.parentTurnId === (execution.turnId ?? turnId) && item.taskId === taskId);
      const running = task ? task.status === 'running' : isToolRunningInContext(execution, active) || output.status === 'running';
      runningAgents += Number(running);
      failedAgents += Number(task ? task.status === 'failed' : execution.state === 'failed');
      const status = task ? subagentTaskPresentation(task, language).label :
        running ? (zh ? '运行中' : 'Running') : execution.state === 'failed' ? (zh ? '执行失败' : 'Failed') :
        execution.state === 'cancelled' ? (zh ? '已停止' : 'Stopped') : (zh ? '已派发' : 'Dispatched');
      const title = task?.agentName || task?.agentProfileId || task?.teamMemberId || (zh ? '子 Agent' : 'Subagent');
      const Icon = running ? LoaderCircle : task?.status === 'failed' || execution.state === 'failed' ? TriangleAlert :
        task?.status === 'stopped' || execution.state === 'cancelled' ? CircleStop : task?.status === 'completed' ? CheckCircle2 : GitFork;
      agentRows.set(key, <button key={key} type="button" className="tool-preview-card loop-subagent-preview"
        data-execution-id={execution.id} data-task-id={taskId || undefined} disabled={!task} title={`${title} · ${status}`}
        onClick={() => task && openSummary({ kind: 'subagent-task', sessionId, task, title })}>
        <span className="tool-preview-icon" aria-hidden="true"><Icon size={14} className={running ? 'spin' : undefined} /></span>
        <span className="tool-preview-content"><strong>{title}</strong><small>{status}</small></span>
        {task && <ChevronRight size={14} aria-hidden="true" />}
      </button>);
    }
  }
  const images = [...imagesByPath.values()];
  if (!agentRows.size && !images.length && !imageStates.length) return null;
  const statusLabel = (running: number, failed: number) => [
    running ? (zh ? `${running} 项进行中` : `${running} running`) : '',
    failed ? (zh ? `${failed} 项失败` : `${failed} failed`) : '',
  ].filter(Boolean).join(' · ');
  return <div className="loop-execution-previews" aria-label={zh ? '执行预览' : 'Execution previews'}>
    {agentRows.size > 0 && <LoopPreviewGroup kind="subagent" icon={<GitFork size={15} />}
      label={zh ? `${agentRows.size} 个子 Agent` : `${agentRows.size} subagents`}
      status={statusLabel(runningAgents, failedAgents)}>
      {[...agentRows.values()]}
    </LoopPreviewGroup>}
    {(images.length > 0 || imageStates.length > 0) && <LoopPreviewGroup kind="image" icon={<Images size={15} />}
      label={images.length ? (zh ? `${viewedImages ? '已查看 ' : ''}${images.length} 张图像` :
        `${images.length} images${viewedImages ? ' viewed' : ''}`) : (zh ? '查看图像' : 'View images')}
      status={statusLabel(pendingImages, failedImages)}>
      <ToolImageArtifactViewer artifacts={images} language={language} variant="thumbnail" />
      {imageStates}
    </LoopPreviewGroup>}
    {failed && <button className="loop-preview-retry" type="button" onClick={() => setRetry(value => value + 1)}>{zh ? '重试读取预览' : 'Retry previews'}</button>}
  </div>;
}

function LoopPreviewGroup({ kind, icon, label, status, children }: {
  kind: 'image' | 'subagent'; icon: ReactNode; label: string; status: string; children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  const id = useId();
  return <section className={`loop-preview-section loop-${kind}-previews`}>
    <button type="button" className="loop-preview-summary" aria-expanded={expanded} aria-controls={id}
      onClick={event => preserveScrollPositionForToggle(event.currentTarget, () => setExpanded(value => !value))}>
      <span className="loop-preview-summary-icon" aria-hidden="true">{icon}</span>
      <span>{label}</span>
      {status && <small>· {status}</small>}
      <ChevronDown size={13} className="loop-preview-chevron" aria-hidden="true" />
    </button>
    <div id={id} className="loop-execution-preview-group" hidden={!expanded}>{children}</div>
  </section>;
}
