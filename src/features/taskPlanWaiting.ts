import { uiText } from '../i18n';
import { taskPlanWaitingSchema, type TaskPlanWaiting } from '@cardbush/bush-protocol';
import type { AppLanguage, TurnTerminalSnapshot } from '../types';

export function taskPlanWaitingLabel(kind: TaskPlanWaiting['kind'] | undefined, language: AppLanguage) {
  const labels = ({ user: uiText(language)('taskPlanWaiting.waitingForUserInput'), background: uiText(language)('taskPlanWaiting.waitingForABackgroundTask'), dependency: uiText(language)('taskPlanWaiting.waitingForAPrerequisite'), unspecified: uiText(language)('taskPlanWaiting.waiting') });
  return labels[kind ?? 'unspecified'];
}

export function turnPlanWaiting(terminal: TurnTerminalSnapshot): TaskPlanWaiting | undefined {
  if (terminal.stopReason !== 'task_plan_waiting') return undefined;
  const parsed = taskPlanWaitingSchema.safeParse(terminal.stopDetails?.planWaiting);
  return parsed.success ? parsed.data : { kind: 'unspecified', reason: '' };
}
