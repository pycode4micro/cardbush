import { useContext, useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2, ChevronRight, CircleStop, GitFork, LoaderCircle, TriangleAlert, Image } from 'lucide-react';
import type { AppLanguage, ChatMessage, ChatToolExecution, SubagentTaskSnapshot } from '../../types';
import { fetchRuntimeTurnToolExecutionDetails } from '../../backend/api';
import { ToolMediaContext } from '../chatMessages/mediaPresentation';
import { openWorkSummaryInspector } from '../subagents/subagentObservabilityEvents';
import { subagentTaskPresentation } from '../subagents/subagentTaskPresentation';
import { useLoopSubagentTasks } from '../subagents/useLoopSubagentTasks';
import { ToolImageArtifactViewer } from './ToolImageArtifactViewer';
import { asRecord, parseToolOutputJson } from './toolPayload';
import { activeToolStatusLabel, isToolRunningInContext } from './toolExecutionState';

const agentTools = new Set(['subagent', 'await_subagents', 'team_delegate']);
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
  const tasks = useLoopSubagentTasks(sessionId, agents.length > 0, active);
  const zh = language === 'zh';
  const imageRows: ReactNode[] = [];
  const agentRows: ReactNode[] = [];
  for (const base of executions) {
    const execution = details.find(detail => detail.id === base.id) ?? base;
    const images = media.get(execution.id) ?? execution.artifacts ?? [];
    if (!isLoopPreviewExecution(execution) && !images.some(artifact => artifact.type === 'image')) continue;
    if (!agentTools.has(execution.name)) {
      const pending = isToolRunningInContext(execution, active);
      imageRows.push(<div key={execution.id} className="loop-image-preview" data-execution-id={execution.id}>
        {images.some(artifact => artifact.type === 'image') ? <ToolImageArtifactViewer artifacts={images} language={language} />
          : <span className="tool-preview-card loop-execution-preview-label">
            <span className="tool-preview-icon" aria-hidden="true">{pending ? <LoaderCircle size={14} className="spin" /> : <Image size={14} />}</span>
            <span className="tool-preview-content"><strong>{zh ? '查看图像' : 'View image'}</strong>
              <small>{pending ? activeToolStatusLabel(execution, language) : execution.success === false ? (zh ? '执行失败' : 'Failed') : (zh ? '已执行' : 'Executed')}</small></span>
          </span>}
      </div>);
      continue;
    }
    const output = execution.metadata.nativeResult ? asRecord(execution.metadata.nativeResult) : parseToolOutputJson(execution.output);
    const members = Array.isArray(output.members) ? output.members.map(asRecord) : [output];
    const ids = new Set(members.map(item => String(item.taskId ?? '')).filter(Boolean));
    if (Array.isArray(output.taskIds)) output.taskIds.forEach(id => ids.add(String(id)));
    const matched = tasks.filter(task => task.parentTurnId === (execution.turnId ?? turnId) && task.taskId && ids.has(task.taskId));
    const slots: Array<SubagentTaskSnapshot | undefined> = matched.length ? matched : [undefined];
    agentRows.push(...slots.map((task, index) => {
      const running = task ? task.status === 'running' : isToolRunningInContext(execution, active) || output.status === 'running';
      const status = task ? subagentTaskPresentation(task, language).label :
        running ? (zh ? '运行中' : 'Running') : execution.state === 'failed' ? (zh ? '执行失败' : 'Failed') :
        execution.state === 'cancelled' ? (zh ? '已停止' : 'Stopped') :
        execution.name === 'await_subagents' ? (zh ? '等待结束' : 'Wait ended') : (zh ? '已派发' : 'Dispatched');
      const title = task?.agentName || task?.agentProfileId || task?.teamMemberId || (execution.name === 'await_subagents' ? (zh ? '等待子 Agent' : 'Wait for subagents') : (zh ? '子 Agent' : 'Subagent'));
      const Icon = running ? LoaderCircle : task?.status === 'failed' || execution.state === 'failed' ? TriangleAlert :
        task?.status === 'stopped' || execution.state === 'cancelled' ? CircleStop : task?.status === 'completed' ? CheckCircle2 : GitFork;
      return <button key={`${execution.id}:${task?.taskId ?? index}`} type="button" className="tool-preview-card loop-subagent-preview"
        data-execution-id={execution.id} data-task-id={task?.taskId} disabled={!task} title={`${title} · ${status}`}
        onClick={() => task && openWorkSummaryInspector({ kind: 'subagent-task', sessionId, task, title })}>
        <span className="tool-preview-icon" aria-hidden="true"><Icon size={14} className={running ? 'spin' : undefined} /></span>
        <span className="tool-preview-content"><strong>{title}</strong><small>{status}</small></span>
        {task && <ChevronRight size={14} aria-hidden="true" />}
      </button>;
    }));
  }
  if (!agentRows.length && !imageRows.length) return null;
  return <div className="loop-execution-previews" aria-label={zh ? '执行预览' : 'Execution previews'}>
    {agentRows.length > 0 && <div className="loop-execution-preview-group loop-subagent-previews">{agentRows}</div>}
    {imageRows.length > 0 && <div className="loop-execution-preview-group loop-image-previews">{imageRows}</div>}
    {failed && <button className="loop-preview-retry" type="button" onClick={() => setRetry(value => value + 1)}>{zh ? '重试读取预览' : 'Retry previews'}</button>}
  </div>;
}
