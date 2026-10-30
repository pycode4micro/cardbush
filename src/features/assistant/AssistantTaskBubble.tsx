import { uiText } from '../../i18n';
import { Check, ChevronRight, CircleAlert, LoaderCircle, Square } from 'lucide-react';
import type { SubagentTaskSnapshot } from '../../types';
import { openWorkSummaryInspector } from '../subagents/subagentObservabilityEvents';
import { subagentTaskPresentation } from '../subagents/subagentTaskPresentation';
import '../subagents/subagent-activity.css';

export function AssistantTaskBubble({ task, language }: { task: SubagentTaskSnapshot; language: string }) {
  const state = subagentTaskPresentation(task, language);
  const title = task.requestPrompt?.trim() || (uiText(language)('assistantTaskBubble.doSomething'));
  const Icon = task.status === 'running' ? LoaderCircle : task.status === 'completed' ? Check : task.status === 'failed' ? CircleAlert : Square;
  return <div className="message-list-item assistant-message-row" data-message-id={task.taskId}>
    <button type="button" className="assistant-task-bubble" data-status={task.status}
      title={title} aria-label={`${state.label} · ${title} · ${uiText(language)('assistantTaskBubble.viewExecution')}`}
      onClick={() => openWorkSummaryInspector({ kind: 'subagent-task', sessionId: task.parentSessionId, task, title })}>
      <Icon className={task.status === 'running' ? 'subagent-activity-spinner' : undefined}/>
      <span><strong>{title}</strong><small>{state.label} · {uiText(language)('assistantTaskBubble.viewExecution')}</small></span>
      <ChevronRight/>
    </button>
  </div>;
}
