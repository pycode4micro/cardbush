import * as api from '../../backend/api';
import { localConversationBackend, type ConversationBackend } from '../../backend/conversationBackend';
import type { ConversationRuntime } from '../../backend/conversationRuntime';
import type { SubagentDispatchEvent, SubagentTaskSnapshot } from '../../types';
import { SUBAGENT_DISPATCH_UI_EVENT } from './subagentObservabilityEvents';

/** Child sessions are hidden from Recents, but use the ordinary conversation controller. */
export function subagentConversationBackend({ base = localConversationBackend, runtime, sessionId, readTasks, knownTask, onSubmitted, onTasksChanged }: {
  base?: ConversationBackend;
  runtime: ConversationRuntime;
  sessionId: string;
  readTasks: () => Promise<SubagentTaskSnapshot[]>;
  knownTask: () => SubagentTaskSnapshot;
  onSubmitted: () => void;
  onTasksChanged?: (tasks: SubagentTaskSnapshot[]) => void;
}): ConversationBackend {
  const requireContinuation = async (signal?: AbortSignal) => {
    const capabilities = await runtime.client.getCapabilities(signal);
    if (!capabilities.features.includes('subagent_conversations')) throw new Error('请更新并重启执行此子代理的 CardBush，再继续对话。Update and restart the CardBush host running this subagent to continue.');
  };
  return {
    ...base,
    scope: base.scope ?? `subagent:${sessionId}`,
    keepRunningOnUnmount: !base.scope,
    fetchConversations: async () => {
      const session = await runtime.client.getSession(sessionId);
      return session ? [api.runtimeConversation(session)] : [];
    },
    streamChat: async request => {
      await requireContinuation(request.signal);
      return base.streamChat({ ...request, onStart: start => { request.onStart?.(start); onSubmitted(); } });
    },
    editMessage: async (...args) => { await requireContinuation(args[0].signal); return base.editMessage(...args); },
    ...(base.queue ? { queue: { ...base.queue, enqueue: async request => { await requireContinuation(request.signal); await base.queue!.enqueue(request); } } } : {}),
    stopTurn: async turnId => {
      const receipt = await runtime.client.stopTurn({ sessionId, turnId });
      return { ...receipt, turnId, alreadyInactive: !receipt.accepted, raw: receipt };
    },
    watchSession: (id, listener, onError) => {
      let alive = true, polling = false, dirty = false, timer: ReturnType<typeof setTimeout>;
      let taskRevision: string | undefined;
      let jobs: Parameters<Parameters<NonNullable<ConversationBackend['watchSession']>>[1]>[0] | undefined;
      let tasks: SubagentTaskSnapshot[] = [knownTask()];
      const publish = () => {
        if (!alive) return;
        const owner = knownTask();
        const child = tasks.filter(task => task.childSessionId === id && task.parentSessionId === owner.parentSessionId &&
          task.remote?.connectionId === owner.remote?.connectionId);
        const revision = child.map(task => `${task.taskId}:${task.status}:${task.updatedAt}`).join('|');
        if (revision !== taskRevision) { taskRevision = revision; onTasksChanged?.(child); }
        const running = child.find(task => !task.terminal);
        listener({ activeTurnId: jobs?.activeTurnId || running?.childTurnId, queueState: jobs?.queueState,
          queued: jobs?.queued ?? [], revision: `${jobs?.revision ?? ''}|${revision}` });
      };
      const stopJobs = base.watchSession?.(id, state => { jobs = state; publish(); }, onError);
      publish();
      const poll = async () => {
        if (!alive) return;
        if (polling) { dirty = true; return; }
        clearTimeout(timer); polling = true; dirty = false;
        try { tasks = await readTasks(); if (alive) publish(); }
        catch (error) { if (alive) onError(error); }
        finally { polling = false; if (alive) timer = setTimeout(() => void poll(), dirty ? 0 : 1500); }
      };
      const dispatch = (event: Event) => {
        const detail = (event as CustomEvent<SubagentDispatchEvent>).detail;
        if (detail?.parentSessionId === knownTask().parentSessionId && (!detail.childSessionId || detail.childSessionId === id)) void poll();
      };
      window.addEventListener(SUBAGENT_DISPATCH_UI_EVENT, dispatch);
      void poll();
      return () => { alive = false; clearTimeout(timer); window.removeEventListener(SUBAGENT_DISPATCH_UI_EVENT, dispatch); stopJobs?.(); };
    },
  };
}
