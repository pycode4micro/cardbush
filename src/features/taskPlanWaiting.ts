import { taskPlanWaitingSchema, type TaskPlanWaiting } from '@cardbush/bush-protocol';
import type { AppLanguage, TurnTerminalSnapshot } from '../types';

export function taskPlanWaitingLabel(kind: TaskPlanWaiting['kind'] | undefined, language: AppLanguage) {
  const labels = language === 'zh'
    ? { user: '等待用户确认', background: '等待后台任务', dependency: '等待前置步骤', unspecified: '等待中' }
    : { user: 'Waiting for user input', background: 'Waiting for a background task', dependency: 'Waiting for a prerequisite', unspecified: 'Waiting' };
  return labels[kind ?? 'unspecified'];
}

export function turnPlanWaiting(terminal: TurnTerminalSnapshot): TaskPlanWaiting | undefined {
  if (terminal.stopReason !== 'task_plan_waiting') return undefined;
  const parsed = taskPlanWaitingSchema.safeParse(terminal.stopDetails?.planWaiting);
  return parsed.success ? parsed.data : { kind: 'unspecified', reason: '' };
}
