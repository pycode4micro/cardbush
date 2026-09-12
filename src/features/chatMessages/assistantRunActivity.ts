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

export function assistantRunActivity(executions: ChatToolExecution[]) {
  const waiting = executions.filter(item => item.state === 'awaiting_permission');
  const running = executions.filter(item => item.state === 'running');
  const terminals = new Map<string, string>();
  let lastToolEventAt: string | undefined;
  for (const item of executions) {
    if (Number.isFinite(Date.parse(item.createdAt)) &&
        (!lastToolEventAt || Date.parse(item.createdAt) > Date.parse(lastToolEventAt))) {
      lastToolEventAt = item.createdAt;
    }
    if (!['terminal_exec', 'terminal_poll', 'terminal_write', 'terminal_stop', 'terminal_list'].includes(item.name)) continue;
    const result = item.metadata.nativeResult as Record<string, unknown> | undefined;
    if (!result || item.state !== 'completed') continue;
    const observations = item.name === 'terminal_list' && Array.isArray(result.sessions) ? result.sessions : [result];
    if (item.name === 'terminal_list' && Array.isArray(result.sessions)) terminals.clear();
    for (const observation of observations) {
      if (!observation || typeof observation !== 'object') continue;
      const fact = observation as Record<string, unknown>;
      const id = fact.terminalSessionId ?? fact.sessionId;
      if (typeof id === 'string' && typeof fact.state === 'string') terminals.set(id, fact.state);
    }
  }
  return { waiting, running, lastToolEventAt,
    observedRunningTerminals: [...terminals.values()].filter(state => state === 'running').length };
}
