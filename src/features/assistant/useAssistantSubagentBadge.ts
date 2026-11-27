import { useEffect, useState } from 'react';
import { isQueuedSubagentTask, type childConversationSummaries } from '../subagents/subagentTaskPresentation';

type ChildSummary = ReturnType<typeof childConversationSummaries>[number];
const storageKey = 'cardbush_assistant_subagent_seen_v1';
const historyLimit = 1000;

function readSeen() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as { since?: unknown; ids?: unknown } | null;
    if (typeof saved?.since === 'number' && Number.isFinite(saved.since) && Array.isArray(saved.ids)) {
      return { since: saved.since, ids: saved.ids.filter((id): id is string => typeof id === 'string') };
    }
  } catch { /* Unavailable storage falls back to this view's history. */ }
  return { since: Date.now(), ids: [] as string[] };
}

export function useAssistantSubagentBadge(tasks: ChildSummary[], enabled: boolean) {
  const [seen, setSeen] = useState(readSeen);
  useEffect(() => {
    if (!enabled) return;
    try { localStorage.setItem(storageKey, JSON.stringify(seen)); }
    catch { /* Read state still works in the current view. */ }
  }, [enabled, seen]);

  const active = tasks.filter(task => !task.terminal);
  const unread = tasks.filter(task => {
    if (!task.terminal || !task.currentTaskId || seen.ids.includes(task.currentTaskId)) return false;
    const completedAt = Date.parse(task.completedAt || task.updatedAt || '');
    return !Number.isFinite(completedAt) || completedAt >= seen.since;
  });
  const markSeen = (task?: ChildSummary) => {
    const ids = unread.filter(item => !task || item.currentTaskId === task.currentTaskId).map(item => item.currentTaskId!);
    if (ids.length) setSeen(current => ({ ...current, ids: [...new Set([...current.ids, ...ids])].slice(-historyLimit) }));
  };
  return {
    badge: { active: active.length, unread: unread.length, spinning: active.some(task => !isQueuedSubagentTask(task)) },
    markSeen,
  };
}
