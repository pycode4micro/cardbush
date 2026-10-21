import type { ChatMessage, TaskPlanSnapshot } from '../../types';

/** The latest task owns the summary. A new task must not inherit an older plan. */
export function conversationTaskPlan(messages: ChatMessage[], activeTurnId = ''): TaskPlanSnapshot | undefined {
  let lastUser = messages.length - 1;
  while (lastUser >= 0 && messages[lastUser].role !== 'user') lastUser--;
  const turnId = activeTurnId || messages[lastUser]?.turnId;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (index < lastUser && (!turnId || message.turnId !== turnId)) break;
    if (message.role !== 'assistant' || (turnId && message.turnId !== turnId)) continue;
    if (message.taskPlan) return message.taskPlan;
    const history = message.loopHistory ?? [];
    for (let segment = history.length - 1; segment >= 0; segment--) {
      if (history[segment].taskPlan) return history[segment].taskPlan;
    }
  }
  return undefined;
}
