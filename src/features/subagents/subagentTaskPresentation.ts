import type { AppLanguage, SubagentTaskSnapshot, SubagentTaskStatus } from '../../types';

const taskStates = {
  running: { tone: 'running', zh: '运行中', en: 'Running' },
  completed: { tone: 'complete', zh: '已完成', en: 'Completed' },
  failed: { tone: 'failed', zh: '执行失败', en: 'Failed' },
  stopped: { tone: 'stopped', zh: '已停止', en: 'Stopped' },
} as const satisfies Record<SubagentTaskStatus, { tone: string; zh: string; en: string }>;

// Execution status comes from the Runtime. Finishing does not imply either
// acceptance of the result or a pending parent-review workflow.
export function subagentTaskPresentation(task: Pick<SubagentTaskSnapshot, 'status'>, language: AppLanguage) {
  const state = taskStates[task.status];
  return { tone: state.tone, label: language === 'zh' ? state.zh : state.en };
}
