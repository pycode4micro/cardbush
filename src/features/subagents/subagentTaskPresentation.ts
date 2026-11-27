import type { MessageKey } from '../../i18n';
import { subagentExecutionQueued } from '@cardbush/bush-protocol';
import { uiText } from '../../i18n';
import type { AppLanguage, SubagentTaskSnapshot, SubagentTaskStatus } from '../../types';

const taskStates = {
  running: { tone: 'running', labelKey: 'common.running' as const },
  completed: { tone: 'complete', labelKey: 'automationPanel.completed' as const },
  failed: { tone: 'failed', labelKey: 'loopExecutionPreviews.failed' as const },
  stopped: { tone: 'stopped', labelKey: 'automationPanel.stopped' as const },
  unavailable: { tone: 'stopped', labelKey: 'remoteWorkers.statusUnavailable' as const },
} as const satisfies Record<SubagentTaskStatus, { tone: string; labelKey: MessageKey }>;

// Execution status comes from the Runtime. Finishing does not imply either
// acceptance of the result or a pending parent-review workflow.
export function isQueuedSubagentTask(task: Pick<SubagentTaskSnapshot, 'status'> & Partial<Pick<SubagentTaskSnapshot, 'raw'>>) {
  return subagentExecutionQueued({ ...task.raw, status: task.status });
}

export function subagentTaskPresentation(task: Pick<SubagentTaskSnapshot, 'status'> & Partial<Pick<SubagentTaskSnapshot, 'raw'>>, language: AppLanguage) {
  if (isQueuedSubagentTask(task)) return { tone: 'running', label: uiText(language)('queue.parentWaitingTurn') };
  const state = taskStates[task.status];
  return { tone: state.tone, label: uiText(language)(state.labelKey) };
}

/** Shared by the ordinary work summary and Assistant: one entry per child conversation. */
export function childConversationSummaries(tasks: SubagentTaskSnapshot[]) {
  const conversations = new Map<string, SubagentTaskSnapshot[]>();
  for (const task of [...tasks].sort((a, b) => (a.createdAt || a.startedAt || '').localeCompare(b.createdAt || b.startedAt || ''))) {
    const key = JSON.stringify([task.parentSessionId, task.remote?.connectionId ?? '',
      task.childSessionId || task.taskId || task.toolCallId || task.parentTurnId]);
    const group = conversations.get(key) ?? [];
    group.push(task); conversations.set(key, group);
  }
  return [...conversations.values()].map(group => {
    const original = group[0];
    const current = [...group].reverse().find(task => task.status === 'running' && !isQueuedSubagentTask(task))
      ?? [...group].reverse().find(task => task.status === 'running') ?? group[group.length - 1];
    // Retain the entry's position and inspector identity; the watcher follows all child turns.
    return { ...original, currentTaskId: current.taskId, status: current.status, terminal: current.terminal,
      responsePrompt: current.responsePrompt, errorMessage: current.errorMessage, updatedAt: current.updatedAt,
      completedAt: current.completedAt, usage: current.usage, raw: current.raw };
  }).sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
}
