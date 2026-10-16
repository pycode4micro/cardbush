import type { State } from './api';

/** Older pages add history without overwriting newer jobs, solutions or completed turns. */
export function mergeConversationPage(previous: State | undefined, next: State, older = false): State {
  if (!previous || previous.conversation.id !== next.conversation.id || !previous.history || !next.history) return next;
  const oldTurns = previous.snapshot?.turns ?? [], newTurns = next.snapshot?.turns ?? [];
  // A head without overlap means another client advanced far beyond the retained window.
  if (!older && oldTurns.length && newTurns.length && !newTurns.some(turn => oldTurns.some(old => old.turnId === turn.turnId))) return next;
  const primary = older ? previous : next, secondary = older ? next : previous;
  const turns = new Map((older ? newTurns : oldTurns).map(turn => [turn.turnId, turn]));
  for (const turn of older ? oldTurns : newTurns) turns.set(turn.turnId, turn);
  const included = new Set(turns.keys());
  const jobs = new Map(secondary.jobs.filter(job => included.has(job.turnId)).map(job => [job.id, job]));
  for (const job of primary.jobs) jobs.set(job.id, job);
  const tools = new Map((secondary.toolExecutions ?? []).map(tool => [`${tool.turnId}:${tool.toolCall.id}`, tool]));
  for (const tool of primary.toolExecutions ?? []) tools.set(`${tool.turnId}:${tool.toolCall.id}`, tool);
  return { ...primary, snapshot: primary.snapshot ? { ...primary.snapshot, turns: [...turns.values()] } : null,
    jobs: [...jobs.values()], toolExecutions: [...tools.values()],
    history: older ? next.history : oldTurns.length > newTurns.length || oldTurns[0]?.turnId !== newTurns[0]?.turnId ? previous.history : next.history };
}
