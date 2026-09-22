import { ConversationHostContext, type ConversationHost } from '../conversationHost';
import { useContext, useEffect, useState } from 'react';
import { fetchSubagentTasks } from '../../backend/api';
import type { SubagentTaskSnapshot } from '../../types';
import { SUBAGENT_DISPATCH_UI_EVENT } from './subagentObservabilityEvents';

type Listener = { notify: (tasks: SubagentTaskSnapshot[]) => void; active: boolean };
type Feed = { tasks: SubagentTaskSnapshot[]; listeners: Set<Listener>; refresh: () => void; dispose: () => void };
const feeds = new Map<string, Feed>();
const empty: SubagentTaskSnapshot[] = [];

// A conversation can contain many loops. They share one status request and
// never fetch child transcripts or put child prompts in the message list.
function createFeed(sessionId: string, host?: ConversationHost): Feed {
  const controller = new AbortController();
  let pending = false;
  const feed: Feed = { tasks: [], listeners: new Set(), refresh: () => {}, dispose: () => {} };
  feed.refresh = () => {
    if (pending || controller.signal.aborted || document.visibilityState === 'hidden') return;
    pending = true;
    void fetchSubagentTasks(host?.sessionId ?? sessionId, { signal: controller.signal, limit: 1000 }, host?.runtime).then(tasks => {
      if (controller.signal.aborted) return;
      feed.tasks = tasks;
      for (const listener of feed.listeners) listener.notify(tasks);
    }).catch(() => {}).finally(() => { pending = false; });
  };
  const dispatch = (event: Event) => {
    if ((event as CustomEvent).detail?.parentSessionId === sessionId) feed.refresh();
  };
  const timer = window.setInterval(() => {
    if (feed.tasks.some(task => !task.terminal) || [...feed.listeners].some(listener => listener.active)) feed.refresh();
  }, 2500);
  window.addEventListener('focus', feed.refresh);
  document.addEventListener('visibilitychange', feed.refresh);
  window.addEventListener(SUBAGENT_DISPATCH_UI_EVENT, dispatch);
  feed.dispose = () => {
    controller.abort(); window.clearInterval(timer);
    window.removeEventListener('focus', feed.refresh);
    document.removeEventListener('visibilitychange', feed.refresh);
    window.removeEventListener(SUBAGENT_DISPATCH_UI_EVENT, dispatch);
  };
  return feed;
}

export function useLoopSubagentTasks(sessionId: string, enabled: boolean, active: boolean) {
  const host = useContext(ConversationHostContext);
  const key = host ? `${host.id}:${sessionId}` : sessionId;
  const [value, setValue] = useState<{ sessionId: string; tasks: SubagentTaskSnapshot[] }>();
  useEffect(() => {
    if (!enabled || !sessionId) return;
    let feed = feeds.get(key);
    const fresh = !feed;
    if (!feed) { feed = createFeed(sessionId, host); feeds.set(key, feed); }
    const listener = { active, notify: (tasks: SubagentTaskSnapshot[]) => setValue({ sessionId, tasks }) };
    feed.listeners.add(listener);
    listener.notify(feed.tasks);
    if (fresh || active) feed.refresh();
    return () => {
      feed.listeners.delete(listener);
      if (!feed.listeners.size) { feed.dispose(); feeds.delete(key); }
    };
  }, [sessionId, key, host, enabled, active]);
  return enabled && value?.sessionId === sessionId ? value.tasks : empty;
}
