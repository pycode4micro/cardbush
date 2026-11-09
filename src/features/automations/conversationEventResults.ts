import { isAutomationResult, type AutomationOverview, type AutomationRun } from '@cardbush/bush-protocol';
import { useCallback, useRef, useState } from 'react';

export type ConversationEventResult = {
  jobId: string; runId: string; turnId: string; sourceId: string;
  title: string; summary: string; status: AutomationRun['status']; finishedAt: string;
};

// The scheduler owns the result and its read receipt. Only isolated runs
// need delivery here; in-place runs already appear in their own transcript.
export function conversationEventResults(overview: AutomationOverview, previous?: ReadonlySet<string>) {
  const sources = new Set(overview.sessions.map(session => session.id));
  const terminalIds = new Set<string>();
  const unread: ConversationEventResult[] = [];
  for (const job of overview.jobs) {
    for (const run of job.runs) {
      if (!run.sessionId || run.sessionId === job.sessionId || !isAutomationResult(run)) continue;
      terminalIds.add(run.id);
      if (run.readAt || !sources.has(job.sessionId)) continue;
      unread.push({ jobId: job.id, runId: run.id, turnId: run.turnId, sourceId: job.sessionId,
        title: job.name, summary: run.summary || run.error || '', status: run.status, finishedAt: run.finishedAt ?? run.queuedAt });
    }
  }
  unread.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt) || b.runId.localeCompare(a.runId));
  return { terminalIds, unread, arrivals: previous ? unread.filter(item => !previous.has(item.runId)) : [] };
}

export function useConversationEventInbox(onArrival: (result: ConversationEventResult) => void) {
  const observed = useRef<Set<string> | undefined>(undefined);
  const [unreadEventResults, setUnread] = useState<ConversationEventResult[]>([]);
  const [latestEventArrival, setLatest] = useState('');
  const receive = useCallback((overview: AutomationOverview) => {
    const { terminalIds, unread, arrivals } = conversationEventResults(overview, observed.current);
    observed.current = terminalIds;
    setUnread(current => JSON.stringify(current) === JSON.stringify(unread) ? current : unread);
    for (const result of [...arrivals].reverse()) onArrival(result);
    setLatest(current => arrivals[0]?.runId ?? (unread.some(item => item.runId === current) ? current : ''));
  }, [onArrival]);
  return { receive, unreadEventResults, latestEventArrival };
}

export function observeConversationEvents(receive: (overview: AutomationOverview, changed: boolean, signal: AbortSignal) => Promise<void>) {
  const desktop = window.cardbushDesktop;
  if (!desktop?.automationCommand) return;
  const controller = new AbortController();
  let reading = false, changed = false, timer = 0;
  async function refresh() {
    if (reading || controller.signal.aborted) return;
    reading = true;
    const reload = changed;
    changed = false;
    try {
      const overview = await desktop!.automationCommand({ action: 'list' }) as AutomationOverview;
      if (!controller.signal.aborted) await receive(overview, reload, controller.signal);
    } catch { /* A later scheduler notification or window focus retries the read. */ }
    finally {
      reading = false;
      if (changed && !controller.signal.aborted) update();
    }
  }
  function update() {
    changed = true;
    if (reading || timer) return;
    timer = window.setTimeout(() => { timer = 0; void refresh(); }, 100);
  }
  const unsubscribe = desktop.onAutomationChanged?.(update);
  window.addEventListener('focus', update);
  void refresh();
  return () => { controller.abort(); window.clearTimeout(timer); unsubscribe?.(); window.removeEventListener('focus', update); };
}
