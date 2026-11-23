import { uiText } from '../../i18n';
import type { SubagentTaskSnapshot } from '../../types';
import { openWorkSummaryInspector } from '../subagents/subagentObservabilityEvents';
import { subagentTaskPresentation } from '../subagents/subagentTaskPresentation';

export function AssistantTaskBubble({ task, language }: { task: SubagentTaskSnapshot; language: string }) {
  const t = uiText(language);
  const state = subagentTaskPresentation(task, language);
  const id = task.childSessionId || task.taskId;
  const name = task.agentName?.trim() || (id ? t('runtime.subagentName', { id: id.slice(-8) }) : t('employeePresentation.subagent'));
  const title = task.requestPrompt?.trim() || t('assistantTaskBubble.doSomething');
  return <button type="button" className="assistant-task-bubble" data-status={task.status} data-message-id={task.taskId}
    title={name} aria-label={t('assistantTaskBubble.viewExecution', { name, state: state.label })}
    onClick={() => openWorkSummaryInspector({ kind: 'subagent-task', sessionId: task.parentSessionId, task, title })}>
    <span>{name}</span>
  </button>;
}
