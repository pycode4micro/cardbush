import { readConversationStyle } from '../settings/conversationStyle';
import type { RuntimeEvent, SessionSnapshot, ConversationExtractDesktopApi } from '@cardbush/bush-protocol';
import type { AgentDesktopApi, AgentJob, AgentSendInput, AgentOperation } from '../../../electron/agentTypes';
import * as shared from '../../backend/api';
import { resolvePromptReferenceContext } from '../../backend/promptReferenceContext';
import type { ConversationBackend } from '../../backend/conversationBackend';
import type { ConversationRuntime } from '../../backend/conversationRuntime';
import { streamRuntimeTurnEvents } from '../../backend/runtimeChat';
import { parseGoalCommand } from '../../backend/goalCommand';
import { ProtocolRuntimeClient } from '../../runtime-client/ProtocolRuntimeClient';
import { createRuntimeInteractions } from '../../runtime-client/RuntimeInteractionBridge';
import type { RuntimeStreamRequest } from '../../runtime-client/RuntimeClient';
import type { ChatMessage, SkillDetail, SkillSummary } from '../../types';

type Job = Omit<AgentJob, 'input'> & { text: string; modelId: string };
export type AgentCall = <T = unknown>(operation: AgentOperation, input?: Record<string, unknown>) => Promise<T>;
type Watch = (request: Parameters<AgentDesktopApi['watchEvents']>[1], listener: Parameters<AgentDesktopApi['watchEvents']>[2]) => () => void;

/** SSE and IPC carry the same decoded Runtime events. Neither owns task execution. */
export function agentRuntimeClient(call: AgentCall, watch?: Watch) {
  return new ProtocolRuntimeClient({
    async sendCommand(command, signal) {
      signal?.throwIfAborted();
      const payload = command.payload as Record<string, unknown>;
      const result = command.kind === 'runtime.get_session' ? await call('sessions.get', payload)
        : command.kind === 'runtime.list_sessions' ? await call('sessions.list')
        : await call('runtime.command', { ...command });
      signal?.throwIfAborted();
      return result;
    },
    async *openEventStream(request: RuntimeStreamRequest) {
      let cursor = request.cursor?.afterSequence;
      if (!watch) {
        while (!request.signal?.aborted) {
          const result = await call<{ events: RuntimeEvent[]; ended: boolean }>('chat.events', {
            sessionId: request.sessionId, turnId: request.turnId, afterSequence: cursor, waitMs: 20000,
          });
          for (const event of result.events) { request.signal?.throwIfAborted(); cursor = event.sequence; yield event; }
          if (result.ended) return;
        }
        return;
      }
      let attempt = 0;
      while (!request.signal?.aborted) {
        const pending: RuntimeEvent[] = [];
        let ended = false, failure: Error | undefined, wake: (() => void) | undefined;
        const notify = () => { wake?.(); wake = undefined; };
        const abort = () => { ended = true; notify(); };
        request.signal?.throwIfAborted();
        request.signal?.addEventListener('abort', abort, { once: true });
        let stop: (() => void) | undefined;
        try {
          stop = watch({ sessionId: request.sessionId, turnId: request.turnId!, ...(cursor === undefined ? {} : { afterSequence: cursor }) }, frame => {
            if (frame.type === 'event' && (cursor === undefined || frame.event.sequence > cursor)) {
              if (attempt) { request.onTransportState?.({ state: 'recovered', attempt }); attempt = 0; }
              cursor = frame.event.sequence; pending.push(frame.event);
            } else if (frame.type === 'end') ended = true;
            else if (frame.type === 'error') { failure = new Error(frame.error); ended = true; }
            notify();
          });
          while (true) {
            request.signal?.throwIfAborted();
            while (pending.length) yield pending.shift()!;
            if (failure) break;
            if (ended) return;
            await new Promise<void>(resolve => { wake = resolve; });
          }
        } finally { stop?.(); request.signal?.removeEventListener('abort', abort); }
        request.signal?.throwIfAborted();
        const nextRetryMs = Math.min(1000 * 2 ** Math.min(attempt++, 5), 30000);
        request.onTransportState?.({ state: 'retrying', attempt, nextRetryMs, message: failure?.message });
        // Resume delivery inside this iterator so the shared reducer retains its
        // partial text, plan revisions and tool state. Never resubmit a command.
        await new Promise<void>((resolve, reject) => {
          const cancel = () => { clearTimeout(timer); reject(request.signal?.reason); };
          const timer = setTimeout(() => { request.signal?.removeEventListener('abort', cancel); resolve(); }, nextRetryMs);
          request.signal?.addEventListener('abort', cancel, { once: true });
        });
      }
    },
  });
}

export function createAgentConversationBackend(call: AgentCall, connectionId: string, watch: Watch,
  hostOptions: { sharedSettings?: boolean; enhanced?: boolean; visualInputAvailable?: boolean; onSubmitted?: (sessionId: string) => void } = {}) {
  const guidanceKey = `cardbush-agent-guidance:${connectionId}`;
  const guidance = new Map<string, { command: Record<string, unknown>; message: ChatMessage }>();
  try { for (const entry of JSON.parse(sessionStorage.getItem(guidanceKey) ?? '[]')) guidance.set(entry.message.id, entry); } catch { /* Ignore invalid stored drafts. */ }
  const saveGuidance = () => { try { sessionStorage.setItem(guidanceKey, JSON.stringify([...guidance.values()])); } catch { /* Retain in-memory identity if storage is full. */ } };
  const client = agentRuntimeClient(async <T,>(operation: AgentOperation, input?: Record<string, unknown>): Promise<T> => {
    if (operation !== 'runtime.command' || input?.kind !== 'runtime.enqueue_guidance') return call<T>(operation, input);
    const payload = input.payload as { messageId: string; sessionId: string; turnId: string; content: string; createdAt: string; metadata?: Record<string, unknown> };
    const entry = guidance.get(payload.messageId) ?? { command: input, message: {
      id: payload.messageId, clientMessageId: payload.messageId, messageId: payload.messageId, role: 'user',
      conversationId: payload.sessionId, turnId: payload.turnId, createdAt: payload.createdAt,
      content: typeof payload.metadata?.composerReferenceContent === 'string' ? payload.metadata.composerReferenceContent : payload.content,
      metadata: { ...payload.metadata, turn_guidance: true, guidance_delivery: 'pending', guidance_mode: 'append_context' },
    } as ChatMessage };
    guidance.set(payload.messageId, entry); saveGuidance();
    try {
      const result = await call<T>(operation, entry.command);
      entry.message.status = 'pending';
      entry.message.metadata = { ...entry.message.metadata, guidance_delivery: 'queued' }; saveGuidance();
      return result;
    } catch (error) {
      entry.message.status = 'failed'; entry.message.metadata = { ...entry.message.metadata, guidance_delivery: 'failed' }; saveGuidance();
      throw error;
    }
  }, watch);
  const interactions = createRuntimeInteractions();
  const runtime: ConversationRuntime = { client, interactions, dispose() {},
    answerPermission: answer => client.command({ kind: 'runtime.answer_permission', payload: answer }, value => value) };
  const extractListeners = new Set<() => void>();
  const extractCall = async <T,>(action: string, input: Record<string, unknown> = {}): Promise<T> => {
    const result = await call<T>('conversation.extracts', { action, ...input });
    if (['save', 'consume', 'remove'].includes(action)) for (const listener of extractListeners) listener();
    return result;
  };
  const extracts: ConversationExtractDesktopApi = {
    list: () => extractCall('list'), preview: selection => extractCall('preview', { selection }),
    save: (selection, kind) => extractCall('save', { selection, kind }), consume: id => extractCall('consume', { id }),
    resolve: (id, contextWindowTokens) => extractCall('resolve', { id, contextWindowTokens }),
    export: selection => extractCall('export', { selection }), remove: id => extractCall('remove', { id }),
    onChanged: listener => { extractListeners.add(listener); return () => { extractListeners.delete(listener); }; },
  };
  runtime.resolveExtract = extracts.resolve;
  const uncertain = new Map<string, AgentSendInput>();
  const pendingKey = `cardbush-agent-pending:${connectionId}`;
  try { for (const input of JSON.parse(sessionStorage.getItem(pendingKey) ?? '[]')) uncertain.set(input.sessionId, input); } catch { /* Invalid old storage is ignored. */ }
  const persist = () => { try { sessionStorage.setItem(pendingKey, JSON.stringify([...uncertain.values()])); } catch { /* Never turn an acknowledged send into another submission. */ } };
  const getJobs = (sessionId?: string) => call<Job[]>('chat.jobs', sessionId ? { sessionId } : {});
  const readSession = (sessionId: string) => call<SessionSnapshot>('sessions.get', { sessionId });
  const toInput = (request: shared.ChatStreamRequest, options?: { turnId?: string; supersession?: AgentSendInput['supersession'] }): AgentSendInput => ({
    requestId: crypto.randomUUID(), sessionId: request.sessionId, text: request.userInput,
    modelId: request.modelConfig?.id || request.model, language: request.uiLanguage ?? 'zh', permissionMode: request.permissionMode ?? 'task_free',
    ...(hostOptions.enhanced === false ? {} : { reasoningEffort: request.reasoningLevel, planEnabled: request.referencePlanMode !== 'off', disabledSkills: request.disabledSkills,
      subagentPermissionRouting: request.subagentPermissionRouting }),
    ...(request.files?.length ? { files: request.files } : {}), ...(request.images?.length ? { images: request.images.map(image => image.path) } : {}),
    ...(hostOptions.visualInputAvailable && request.standardImageInputEnabled ? { visionEnabled: true } : {}),
    ...(hostOptions.sharedSettings ? { conversationStyle: readConversationStyle() } : {}),
    goalObjective: parseGoalCommand(request.userInput)?.objective, ...options,
  });
  const submit = async (request: shared.ChatStreamRequest, options?: { turnId?: string; supersession?: AgentSendInput['supersession'] }) => {
    const prior = uncertain.get(request.sessionId);
    if (prior && (prior.userMessageMetadata?.composerReferenceContent ?? prior.text) !== request.userInput) throw new Error('上一条消息尚未确认，请先重试原消息。The previous submission is unconfirmed; retry it first.');
    const input = prior ?? toInput(request, options);
    if (!prior) {
      const referenced = await resolvePromptReferenceContext(input.text, request.sessionId, await client.getSession(request.sessionId), request.uiLanguage,
        (turnId, messageId) => client.getUserMessage(request.sessionId, turnId, messageId), request.modelConfig?.maxContextTokens, extracts.resolve);
      input.text = referenced.content; input.userMessageMetadata = { ...referenced.metadata,
        userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(request.attachments?.length ? { attachments: request.attachments } : {}) };
    }
    uncertain.set(request.sessionId, input); persist();
    const job = await call<Job>('chat.send', input);
    uncertain.delete(request.sessionId); persist();
    hostOptions.onSubmitted?.(input.sessionId);
    return job;
  };
  const stream: typeof shared.streamChat = async request => {
    await run(request);
  };
  const run = async (request: shared.ChatStreamRequest, options?: { turnId?: string; supersession?: AgentSendInput['supersession'] }) => {
    const job = await submit(request, options);
    request.onStart?.({ sessionId: job.sessionId, turnId: job.turnId, userMessageId: `message-${job.id}`, createdAt: job.createdAt });
    await observe({ ...request, turnId: job.turnId });
  };
  const observe: typeof shared.streamTurnEvents = async request => {
    let terminal = false;
    await streamRuntimeTurnEvents({ ...request, onDone: fact => { terminal = true; request.onDone?.(fact); } }, runtime);
    if (terminal || request.signal?.aborted) return;
    // Admission can fail before Runtime creates a Turn. Present the service's
    // persisted result instead of silently reporting an empty successful reply.
    const job = (await getJobs(request.sessionId)).find(job => job.turnId === request.turnId);
    if (job && ['failed', 'interrupted', 'stopped'].includes(job.status)) request.onDone?.({
      turnId: job.turnId, status: job.status === 'stopped' ? 'stopped' : 'failed', stopped: job.status === 'stopped',
      stopReason: job.error || job.status, stopScenario: job.status, completedAt: job.completedAt, raw: { source: 'agent_service_job', job },
    });
  };
  const load: typeof shared.fetchSessionMessages = async (sessionId, options) => {
    const [result, jobs] = await Promise.all([shared.fetchSessionMessages(sessionId, options, runtime), getJobs(sessionId)]);
    const running = jobs.find(job => job.status === 'running');
    if (running && !running.goalContinuation && !result.messages.some(message => message.turnId === running.turnId)) {
      const user: ChatMessage = { id: `message-${running.id}`, messageId: `message-${running.id}`, role: 'user', content: running.text,
        conversationId: sessionId, turnId: running.turnId, createdAt: running.createdAt,
        turnSequence: (result.latestTurn?.turnSequence ?? 0) + 1,
        ...(running.goalContinuation ? { metadata: { goal_continuation: true } } : {}) };
      result.messages.push(user);
    }
    for (const [id, entry] of guidance) {
      if (entry.message.conversationId !== sessionId) continue;
      if (result.messages.some(message => message.messageId === id || message.id === id)) { guidance.delete(id); saveGuidance(); }
      else result.messages.push({ ...entry.message, status: entry.message.status ?? 'pending' });
    }
    return result;
  };
  const backend: ConversationBackend = {
    scope: connectionId,
    isSubmissionRetry: (sessionId, text) => {
      const prior = uncertain.get(sessionId);
      return Boolean(prior && (prior.userMessageMetadata?.composerReferenceContent ?? prior.text) === text);
    },
    fetchConversations: () => shared.fetchConversations(runtime),
    fetchSessionMessages: load,
    fetchMessages: async (id, options) => (await load(id, options)).messages,
    fetchSessionContextWindowUsage: (id, signal) => shared.fetchSessionContextWindowUsage(id, signal, runtime),
    fetchSessionWorkspaceChanges: (id, signal) => shared.fetchSessionWorkspaceChanges(id, signal, runtime),
    fetchExperimentalGoals: id => shared.fetchExperimentalGoals(id, runtime),
    fetchGoalRuntimeStatus: async () => ({ enabled: true, mode: 'agent_runtime', goalProtocol: 'bush.goal.v1' }),
    updateExperimentalGoal: request => shared.updateExperimentalGoal(request, runtime),
    fetchPendingInteraction: id => shared.fetchPendingInteraction(id, runtime),
    replyInteraction: request => shared.replyInteraction(request, runtime),
    cancelInteraction: id => shared.cancelInteraction(id, runtime),
    onRuntimeInteractionsChanged: interactions.onRuntimeInteractionsChanged,
    streamChat: stream,
    streamTurnEvents: observe,
    editMessage: request => shared.editMessage(request, runtime, run),
    sendGuidance: async request => {
      // Read the durable identity before retrying an uncertain append.
      if (await client.getUserMessage(request.sessionId, request.turnId, request.clientMessageId)) return {
        continuationQueued: true, willContinueAfterCurrentRound: true, guidance: { clientMessageId: request.clientMessageId, mode: 'append_context' },
      };
      return shared.sendGuidance(request, runtime);
    },
    stopTurn: async turnId => {
      const job = (await getJobs()).find(job => job.turnId === turnId);
      if (!job) throw new Error('Unknown Agent turn.');
      const result = await call<{ accepted: boolean }>('chat.stop', { id: job.id });
      return { turnId, reason: '', accepted: result.accepted, alreadyInactive: !['queued', 'running'].includes(job.status), terminal: false, raw: result };
    },
    fetchSkills: async () => (await call<{ skills: SkillSummary[] }>('conversation.catalog')).skills,
    fetchSkillDetail: async name => call<SkillDetail>('conversation.catalog', { action: 'read', name }),
    fetchTeamFlow: async () => null,
    sendTeamFlowAction: async () => { throw new Error('This host does not expose team workflow actions.'); },
    createConversation: async request => shared.runtimeConversation(await call<SessionSnapshot>('sessions.create', request)),
    updateConversation: async request => {
      if (request.title !== undefined) await call('sessions.rename', { sessionId: request.sessionId, title: request.title });
      return shared.runtimeConversation(await readSession(request.sessionId));
    },
    switchConversationWorkspace: async (sessionId, _projectDir, projectId) => {
      await call('sessions.bind', { sessionId, projectId }); return shared.runtimeConversation(await readSession(sessionId));
    },
    deleteConversationApi: async sessionId => { await call('sessions.delete', { sessionId }); return true; },
    queue: {
      enqueue: async request => { await submit(request); },
      remove: async id => { await call('chat.queue', { action: 'remove', id }); },
      reorder: async (id, targetId) => { await call('chat.queue', { action: 'reorder', id, targetId }); },
      guide: async (id, turnId) => { await call('chat.queue', { action: 'guide', id, turnId }); },
    },
    watchSession: (sessionId, listener, onError) => {
      let alive = true; let timer: ReturnType<typeof setTimeout>;
      const poll = async () => {
        try {
          const jobs = await getJobs(sessionId); if (!alive) return;
          const running = jobs.find(job => job.status === 'running');
          listener({ activeTurnId: running?.turnId, revision: jobs.map(job => `${job.id}:${job.status}`).join('|'),
            queued: jobs.filter(job => job.status === 'queued' && !job.goalContinuation).map(job => ({ id: job.id, text: job.text, createdAt: job.createdAt,
              conversation: { id: sessionId, title: '', preview: '', updatedAt: job.createdAt } })) });
        } catch (error) { if (alive) onError(error); }
        finally { if (alive) timer = setTimeout(() => void poll(), 1200); }
      };
      void poll(); return () => { alive = false; clearTimeout(timer); };
    },
  };
  return { backend, runtime, client, extracts, unconfirmedText: (sessionId: string) => { const input = uncertain.get(sessionId); return input ? String(input.userMessageMetadata?.composerReferenceContent ?? input.text) : ''; } };
}
