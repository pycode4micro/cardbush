import * as api from '../../backend/api';
import { localConversationBackend, type ConversationBackend } from '../../backend/conversationBackend';
import type { ConversationRuntime } from '../../backend/conversationRuntime';
import type { SubagentTaskSnapshot } from '../../types';

/** Child sessions are hidden from Recents, but use the ordinary conversation controller. */
export function subagentConversationBackend({ base = localConversationBackend, runtime, sessionId, readTasks, knownTask, onSubmitted }: {
  base?: ConversationBackend;
  runtime: ConversationRuntime;
  sessionId: string;
  readTasks: () => Promise<SubagentTaskSnapshot[]>;
  knownTask: () => SubagentTaskSnapshot;
  onSubmitted: () => void;
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
      let alive = true, timer: ReturnType<typeof setTimeout>;
      let jobs: Parameters<Parameters<NonNullable<ConversationBackend['watchSession']>>[1]>[0] | undefined;
      let tasks: SubagentTaskSnapshot[] = [knownTask()];
      const publish = () => {
        if (!alive) return;
        const child = tasks.filter(task => task.childSessionId === id);
        const running = child.find(task => !task.terminal);
        listener({ activeTurnId: jobs?.activeTurnId || running?.childTurnId,
          queued: jobs?.queued ?? [], revision: `${jobs?.revision ?? ''}|${child.map(task => `${task.taskId}:${task.status}:${task.updatedAt}`).join('|')}` });
      };
      const stopJobs = base.watchSession?.(id, state => { jobs = state; publish(); }, onError);
      publish();
      const poll = async () => {
        try { tasks = await readTasks(); if (alive) publish(); }
        catch (error) { if (alive) onError(error); }
        finally { if (alive) timer = setTimeout(() => void poll(), 1500); }
      };
      void poll();
      return () => { alive = false; clearTimeout(timer); stopJobs?.(); };
    },
  };
}
