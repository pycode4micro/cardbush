import type { ChatMessage, ChatToolExecution } from '../../types';

/** Merge observations across the Turn, including earlier assistant segments. */
export function turnActivityExecutions(message: Pick<ChatMessage, 'loopHistory' | 'toolExecutions'>): ChatToolExecution[] {
  const byId = new Map<string, ChatToolExecution>();
  for (const execution of [
    ...(message.loopHistory ?? []).flatMap(segment => segment.toolExecutions ?? []),
    ...(message.toolExecutions ?? []),
  ]) {
    const previous = byId.get(execution.id);
    const time = Date.parse(execution.createdAt) || 0;
    const previousTime = previous ? Date.parse(previous.createdAt) || 0 : 0;
    if (!previous || time > previousTime ||
        (time === previousTime && (execution.sequence ?? 0) >= (previous.sequence ?? 0))) {
      byId.set(execution.id, previous ? { ...previous, ...execution,
        metadata: { ...previous.metadata, ...execution.metadata } } : execution);
    }
  }
  return [...byId.values()].sort((a, b) =>
    Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.sequence ?? 0) - (b.sequence ?? 0),
  );
}
