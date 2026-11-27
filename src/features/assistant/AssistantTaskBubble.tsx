import { Bot, ChevronRight } from 'lucide-react';
import { uiText } from '../../i18n';
import type { SubagentTaskSnapshot } from '../../types';
import { openWorkSummaryInspector } from '../subagents/subagentObservabilityEvents';
import { subagentTaskPresentation } from '../subagents/subagentTaskPresentation';

export function AssistantTaskBubble({ task, language, onOpen }: { task: SubagentTaskSnapshot; language: string; onOpen?: () => void }) {
  const t = uiText(language);
  const state = subagentTaskPresentation(task, language);
  const id = task.childSessionId || task.taskId;
  const name = task.agentName?.trim() || (id ? t('runtime.subagentName', { id: id.slice(-8) }) : t('employeePresentation.subagent'));
  const title = task.requestPrompt?.trim() || t('assistantTaskBubble.doSomething');
  return <button type="button" className="assistant-task-bubble" data-status={task.status} data-tone={state.tone} data-message-id={task.taskId}
    title={name} aria-label={t('assistantTaskBubble.viewExecution', { name, state: state.label })}
    onClick={() => {
      onOpen?.();
      openWorkSummaryInspector({ kind: 'subagent-task', sessionId: task.parentSessionId, task, title });
    }}>
    <span className="assistant-task-glyph"><Bot aria-hidden="true" /></span>
    <span className="assistant-task-copy">
      <span className="assistant-task-name">{name}</span>
      <span className="assistant-task-meta">
        <span>{t('employeePresentation.subagent')}</span>
        <span className="assistant-task-status">{state.label}</span>
      </span>
    </span>
    <ChevronRight className="assistant-task-arrow" aria-hidden="true" />
  </button>;
}
