import { Check, ChevronRight, CircleAlert, LoaderCircle, Square } from 'lucide-react';
import type { SubagentTaskSnapshot } from '../../types';
import { openWorkSummaryInspector } from '../subagents/subagentObservabilityEvents';
import { subagentTaskPresentation } from '../subagents/subagentTaskPresentation';

export function AssistantTaskBubble({ task, language }: { task: SubagentTaskSnapshot; language: 'zh' | 'en' }) {
  const state = subagentTaskPresentation(task, language);
  const title = task.requestPrompt?.trim() || (language === 'zh' ? '处理任务' : 'Do something');
  const Icon = task.status === 'running' ? LoaderCircle : task.status === 'completed' ? Check : task.status === 'failed' ? CircleAlert : Square;
  return <div className="message-list-item assistant-message-row" data-message-id={task.taskId}>
    <button type="button" className="assistant-task-bubble" data-status={task.status}
      title={title} aria-label={`${state.label} · ${title} · ${language === 'zh' ? '查看执行' : 'View execution'}`}
      onClick={() => openWorkSummaryInspector({ kind: 'subagent-task', sessionId: task.parentSessionId, task, title })}>
      <Icon size={16} className={task.status === 'running' ? 'assistant-task-spinner' : undefined}/>
      <span><strong>{title}</strong><small>{state.label} · {language === 'zh' ? '查看执行' : 'View execution'}</small></span>
      <ChevronRight size={15}/>
    </button>
  </div>;
}
