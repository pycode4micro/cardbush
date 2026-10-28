import type { MessageKey } from '../../i18n';
import { uiText } from '../../i18n';
import type { AppLanguage, SubagentTaskSnapshot, SubagentTaskStatus } from '../../types';

const taskStates = {
  running: { tone: 'running', labelKey: 'cardlingWindow.running' as const },
  completed: { tone: 'complete', labelKey: 'automationPanel.completed' as const },
  failed: { tone: 'failed', labelKey: 'loopExecutionPreviews.failed' as const },
  stopped: { tone: 'stopped', labelKey: 'automationPanel.stopped' as const },
} as const satisfies Record<SubagentTaskStatus, { tone: string; labelKey: MessageKey }>;

// Execution status comes from the Runtime. Finishing does not imply either
// acceptance of the result or a pending parent-review workflow.
export function subagentTaskPresentation(task: Pick<SubagentTaskSnapshot, 'status'>, language: AppLanguage) {
  const state = taskStates[task.status];
  return { tone: state.tone, label: uiText(language)(state.labelKey) };
}
