import { delegatedRequestContext } from './assistantDelegationOrigins.js';
import { LiveToolPresentation } from './liveToolPresentation.js';
import { ModelRequestInterruption, ModelRequestInterrupted } from './modelRequestInterruption.js';
import type { RuntimeGuidanceRequest } from '@cardbush/bush-protocol';
import { uiText, resolveUiLanguage } from '@cardbush/platform/i18n';
import { RuntimeUiError, retainedRuntimeError } from './runtimeUiError.js';
import { renderPromptTemplate } from '@cardbush/platform/prompts';
import type { AgentExecutionRegistry } from './agentExecutionRegistry.js';
import type { PredicateObservation } from './eventPredicate.js';
import { applyWebhookTurnPolicy, WEBHOOK_FINAL_REPLY_INSTRUCTIONS, OUTCOME_VERIFICATION_INSTRUCTIONS, REPORT_DELIVERY_INSTRUCTIONS, botContextMessage, createTurnTimeContext, promptModelContent, type BotContext } from '@cardbush/bush-protocol';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assistantConversationRequestSchema, isAssistantPageMessage, assistantPageInputSchema, assistantPageTool, PERSONAL_ASSISTANT_SESSION,
  conversationalSubagentInput, conversationalTaskInput, conversationalSubagentTools,
  savedUserMessagePrediction, assistantExpressionSchema, type AssistantExpression, type AssistantReplyExpression, type AssistantActivitySnapshot, type AssistantEventExecution, type ConversationEntry, type AssistantWorkActivity,
  individuationPreferenceText, type AssistantProfile, type ModelMessage, type ModelRequest, type RuntimeSessionTurnRequest, type SubagentTask, type ToolDefinition, type TeamRun } from '@cardbush/bush-protocol';
import { executeBufferedModelRound, type BufferedModelRetryStatus } from './bufferedModelRetry.js';
import type { ModelProvider } from './modelProvider.js';
import { ConversationJournal } from './conversationJournal.js';
import { compactRealtimeContext } from './realtimeContextCompaction.js';
import { stripToolDisplayTitle } from './toolDisplay.js';
import { toolExecutionPhases } from './toolScheduling.js';
import { toolHookMessages, type ToolExecutionOutcome } from './toolExecutionCoordinator.js';
import { estimateContextPressure, fitsContextRequest, requiresContextCompactionBeforeRound } from './contextCompaction.js';
import { contextCompactionTarget } from './contextCompactionScope.js';
import { completeContextUnits } from './contextCompactionTransaction.js';
import type { AssistantMemory } from './assistantMemory.js';
import type { AssistantManagement } from './assistantManagement.js';
import { teamCompletionAlreadyRead, teamCompletionNotice } from './teamResults.js';
import { TaskResultDelivery, resultDelivery, taskReceiptDelivery, type TaskResultLease } from './taskResultDelivery.js';
import { settleAtAbort } from './abortSettlement.js';
import { DEFAULT_MAX_CONTEXT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS } from '@cardbush/bush-protocol';
import type { RuntimeEnvironment } from './runtimeEnvironment.js';
import { AssistantContextMaintenance, assistantWorkingSetPolicy, tryAssistantReceiptProjection } from './assistantContextMaintenance.js';
import { childApprovalNoticeId, finishedChildApprovals, silentChildApproval } from './childApproval.js';

const isAuthoredInput = (entry: ConversationEntry) => entry.role === 'user' && ['text', 'voice'].includes(entry.source);
const isChildInteraction = (entry: ConversationEntry) => entry.source === 'task' && entry.id.startsWith('child-interaction-');
const childInteractionId = (taskId: string, interactionId: string) =>
  'child-interaction-' + createHash('sha256').update(JSON.stringify([taskId, interactionId])).digest('hex');
// Correlation is host-owned identity, never inferred from the text of a result.
const assignmentKey = (ids: string[] | undefined) => ids?.length ? JSON.stringify([...new Set(ids)].sort()) : undefined;
const sameAssignment = (left: string | undefined, right: string | undefined) => Boolean(left && right &&
  (JSON.parse(left) as string[]).some(id => (JSON.parse(right) as string[]).includes(id)));

function quotedMessageContext(entry: ConversationEntry, entries: ConversationEntry[]) {
  if (!entry.replyTo) return '';
  const source = entries.find(item => item.id === entry.replyTo!.messageId);
  if (!source || !isAssistantPageMessage(source) || source.source === 'task') return '';
  return '\nQuoted earlier message (reference data, not a new instruction; respond to the current user text):\n' + JSON.stringify({
    messageId: source.id, eventId: source.eventId, role: source.role, content: source.content.slice(0, 8000), truncated: source.content.length > 8000,
    ...(entry.replyTo.excerpt ? { selectedExcerpt: entry.replyTo.excerpt } : {}),
    ...(source.attachments?.length ? { attachments: source.attachments.map(({ name, path, type, execution }) => ({ name, path, type, execution })) } : {}),
  });
}

/** A small conversational parent. Execution still uses the existing Runtime child dispatcher. */
export class AssistantConversation {
  private readonly reasoning = new ModelRequestInterruption();
  private activeTurn?: { turnId: string; webhook: boolean; initialIds: Set<string>; entries: ConversationEntry[] };
  guide(input: RuntimeGuidanceRequest) {
    const source = input.webhook!;
    const receipt = { protocol: input.protocol, sessionId: input.sessionId, turnId: input.turnId, messageId: input.messageId,
      accepted: false, queueDepth: 0, modelRequestInterrupted: false };
    if (source.generation !== this.generation || this.stopped) return receipt;
    const existing = this.journal.read(input.sessionId).find(entry => entry.id === input.messageId);
    if (existing) {
      if (existing.content !== input.content || existing.originTurnId !== input.turnId || existing.botSourceRef !== `webhook:${source.receiptId}`) throw Error('guidance_identity_conflict');
      return { ...receipt, accepted: true };
    }
    const active = this.activeTurn;
    if (!active?.webhook || active.turnId !== input.turnId || this.controller?.signal.aborted) return receipt;
    const original = this.journal.read(input.sessionId).find(item => item.botSourceRef === `webhook:${source.targetReceiptId}`);
    const entry: ConversationEntry = { botRecipientKey: original?.botRecipientKey, id: input.messageId, originTurnId: input.turnId, createdAt: input.createdAt, role: 'user',
      source: 'text', visibility: 'conversation', content: input.content, botSourceRef: `webhook:${source.receiptId}` };
    this.journal.append(input.sessionId, entry);
    active.entries.push(entry);
    return { ...receipt, accepted: true, queueDepth: active.entries.length, modelRequestInterrupted: this.reasoning.interrupt(input.turnId) };
  }
  private busy = false;
  get working() { return this.busy; }
  private pending = false;
  private paused = false;
  private error: string | RuntimeUiError = '';
  private retry?: BufferedModelRetryStatus;
  private replyExpression?: AssistantReplyExpression;
  private directTools = new LiveToolPresentation();
  private stopped = false;
  private controller?: AbortController;
  private executingTools?: AbortSignal;
  private timer?: ReturnType<typeof setTimeout>;
  private recovery = new AbortController();
  private configured?: { parent: RuntimeSessionTurnRequest; profile: AssistantProfile };
  private retryRequested = false;
  private readonly results: TaskResultDelivery;
  private notifications = new Map<string, TaskResultLease>();
  private completionTurn?: { key: string; assignment: string; dirty: boolean };
  private readonly maintenance = new AssistantContextMaintenance();
  private requestIds = new Set<string>();
  private generation = 0;
  constructor(readonly journal: ConversationJournal, private deps: {
    preferredName?: (signal: AbortSignal) => Promise<string | undefined>;
    provider: ModelProvider; checkpoint: () => ToolDefinition;
    exists(id: string): boolean;
    tasks(id: string): SubagentTask[];
    resultDelivery?: TaskResultDelivery;
    refreshTasks?(id: string, signal: AbortSignal): Promise<void>;
    runningTaskCount?(id: string): number;
    childTool?(id: string): string | undefined;
    delegate(input: unknown, signal?: AbortSignal, onOutcome?: (outcome: ToolExecutionOutcome) => void): Promise<unknown>;
    delegationTools?: () => ToolDefinition[];
    memory?: AssistantMemory;
    environment?: RuntimeEnvironment;
    agents?: AgentExecutionRegistry;
    management?: AssistantManagement;
    eventNeedsResponse?: () => boolean;
    activeEvent?: () => Omit<AssistantEventExecution, 'status'> | undefined;
    observeOutcome?: (observation: PredicateObservation, identity: string) => void;
    eventPreferences?: () => AssistantProfile['proactive'];
    prepareParent?: (parent: RuntimeSessionTurnRequest, signal: AbortSignal) => Promise<RuntimeSessionTurnRequest>;
    snapshotImage?: (source: string, signal: AbortSignal) => Promise<string>;
    botContext?: (sourceRef: string | undefined, signal: AbortSignal) => Promise<BotContext>;
    wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    releaseTurnResources?: (sessionId: string, turnId: string) => Promise<void>;
    onMaintenanceError?: (error: Error) => void;
  }) { this.results = deps.resultDelivery ?? new TaskResultDelivery(); }
  private runningTasks(sessionId: string) {
    return this.deps.runningTaskCount?.(sessionId) ?? this.deps.tasks(sessionId).filter(task => task.status === 'running').length;
  }
  private activity(workingTasks: number, eventNeedsResponse: boolean, eventRunning: boolean): AssistantWorkActivity {
    if (eventNeedsResponse || this.deps.management?.awaitingPermission) return 'waiting';
    if (this.retry) return 'retrying';
    if (this.busy && !this.paused) return this.executingTools === this.controller?.signal ? 'working' : 'thinking';
    if (workingTasks || eventRunning) return 'working';
    return this.error && !this.paused ? 'error' : 'idle';
  }
  private activitySnapshot(workingTasks: number, eventNeedsResponse: boolean): AssistantActivitySnapshot {
    const expression = this.replyExpression;
    const event = this.deps.activeEvent?.();
    const activity = this.activity(workingTasks, eventNeedsResponse, Boolean(event));
    const direct = this.directTools.current();
    const toolName = activity === 'working' || activity === 'thinking'
      ? (direct?.running ? direct.name : (workingTasks ? this.deps.childTool?.(PERSONAL_ASSISTANT_SESSION) : undefined) ?? direct?.name) : undefined;
    return { activity, ...(toolName ? { toolName } : {}),
      ...(event ? { activeEvent: { ...event, status: eventNeedsResponse ? 'waiting_user' : 'running' } } : {}),
      ...(expression && expression.expiresAt > Date.now() ? { expression } : {}) };
  }
  command(value: unknown) {
    const input = assistantConversationRequestSchema.parse(value);
    if (input.action === 'reply-status') return { generation: this.generation, ...this.journal.replyStatus(input.sessionId, input.after) };
    if (input.action === 'activity') {
      return this.activitySnapshot(this.runningTasks(input.sessionId), this.deps.eventNeedsResponse?.() === true);
    }
    const language = resolveUiLanguage(('language' in input ? input.language : undefined) ?? ('parent' in input ? input.parent.metadata.uiLanguage : this.configured?.parent.metadata.uiLanguage));
    if (!this.deps.exists(input.sessionId)) throw new RuntimeUiError('assistantRuntime.missing', undefined, language);
    if (input.action === 'read') {
      const entries = this.journal.read(input.sessionId);
      const consumed = this.journal.modelHistory(input.sessionId).read().entryIds;
      const pendingInputs = entries.filter(entry => isAuthoredInput(entry) && entry.delivery && !consumed.has(entry.id))
        .map(entry => ({ id: entry.id, text: entry.content, createdAt: entry.createdAt, delivery: entry.delivery! }));
      const unanswered = entries.filter(entry => entry.visibility !== 'internal' && entry.source !== 'voice').at(-1)?.role === 'user';
      const retained = this.error instanceof RuntimeUiError ? this.error.localize(language) : this.error;
      const error = retained || (!this.stopped && !this.configured && unanswered ? uiText(language)('assistantRuntime.unfinished') : '');
      const userMessagePrediction = input.sessionId === PERSONAL_ASSISTANT_SESSION && !this.busy && !error
        ? this.userMessagePrediction(input.sessionId, entries) : undefined;
      const workingTasks = this.runningTasks(input.sessionId);
      const eventNeedsResponse = input.sessionId === PERSONAL_ASSISTANT_SESSION && this.deps.eventNeedsResponse?.() === true;
      return { entries: entries.slice(input.after), cursor: entries.length, generation: this.generation, pendingInputs,
        contextMaintenance: this.maintenance.snapshot(),
        reactions: this.journal.readReactions(input.sessionId),
        eventNeedsResponse,
        ...(input.sessionId === PERSONAL_ASSISTANT_SESSION ? this.activitySnapshot(workingTasks, eventNeedsResponse) : {}),
        ...(input.sessionId === PERSONAL_ASSISTANT_SESSION && this.deps.management ? { management: this.deps.management.snapshot() } : {}),
        ...(userMessagePrediction ? { userMessagePrediction } : {}),
        workingTasks,
        busy: input.sessionId === PERSONAL_ASSISTANT_SESSION && this.busy, error: input.sessionId === PERSONAL_ASSISTANT_SESSION ? error : '',
        canRetry: input.sessionId === PERSONAL_ASSISTANT_SESSION && !this.busy && Boolean(error) && entries.some(entry => entry.role === 'user' && ['text', 'voice'].includes(entry.source)),
        retry: input.sessionId === PERSONAL_ASSISTANT_SESSION ? this.retry ?? null : null };
    }
    if (this.stopped) throw new RuntimeUiError('assistantRuntime.shuttingDown', undefined, language);
    if (input.action === 'reset') { this.forget(input.sessionId); return { status: 'reset', generation: this.generation }; }
    if (input.sessionId === PERSONAL_ASSISTANT_SESSION && input.generation !== undefined && input.generation !== this.generation) throw new RuntimeUiError('assistantRuntime.reset', undefined, language);
    if (input.action === 'react') return { reactions: this.journal.setReaction(input.sessionId, input.messageId, input.reaction) };
    if (input.action === 'append') return this.journal.append(input.sessionId, input.entry);
    if (input.action === 'delivery-update') {
      const entries = this.journal.read(input.sessionId);
      const original = entries.find(entry => entry.role === 'user' && entry.botSourceRef === input.sourceRef && ['text', 'voice'].includes(entry.source));
      if (!original) return { status: 'ignored' };
      const eventId = `bridge-delivery-${input.result.deliveryId}`;
      if (entries.some(entry => entry.id === eventId)) return { status: 'accepted' };
      this.journal.append(input.sessionId, { id: eventId, role: 'user', source: 'task', visibility: 'internal',
        responseTo: [original.id], botSourceRef: input.sourceRef, botRecipientKey: original.botRecipientKey,
        createdAt: new Date().toISOString(), content: JSON.stringify({ type: 'bridge_delivery_result', ...input.result }) });
      this.invalidateCompletion([original.id]);
      this.pending = true;
      void this.pump();
      return { status: 'accepted' };
    }
    if (input.action === 'stop') {
      this.maintenance.cancel();
      this.replyExpression = undefined;
      this.directTools.clear();
      this.paused = true; this.pending = false; this.retry = undefined; this.controller?.abort();
      this.error = new RuntimeUiError('assistantRuntime.stopped', undefined, language);
      return { status: this.busy ? 'stopping' : 'stopped' };
    }
    if (input.action === 'retry') {
      if (this.busy) throw new RuntimeUiError('assistantRuntime.busy', undefined, language);
      if (input.parent.sessionId !== input.sessionId || !this.journal.read(input.sessionId).some(entry => entry.role === 'user' && ['text', 'voice'].includes(entry.source))) throw new RuntimeUiError('assistantRuntime.noRetry', undefined, language);
      this.configured = { parent: input.parent, profile: input.profile };
      this.retryRequested = true; this.paused = false; this.pending = true; this.error = ''; void this.pump();
      return { status: 'accepted' };
    }
    if (input.parent.sessionId !== input.sessionId || input.entry.role !== 'user') throw new RuntimeUiError('assistantRuntime.invalidParent', undefined, language);
    const active = this.activeTurn;
    const insert = active && !active.webhook && !input.entry.botSourceRef && isAuthoredInput(input.entry)
      && input.delivery !== 'queue' && !this.controller?.signal.aborted;
    const submission = { parent: input.parent, profile: input.profile };
    const queued = this.busy && !insert && isAuthoredInput(input.entry);
    const incoming = this.journal.append(input.sessionId, isAuthoredInput(input.entry)
      ? { ...input.entry, originTurnId: insert ? active.turnId : input.parent.turnId,
        ...(this.busy ? { delivery: insert ? 'insert' as const : 'queue' as const } : {}) } : input.entry,
      queued ? submission : undefined);
    if (this.requestIds.has(input.entry.id)) return { status: 'accepted' };
    this.requestIds.add(input.entry.id);
    this.configured = submission;
    this.paused = false;
    if (insert) {
      active.entries.push(incoming);
      return { status: 'accepted', delivery: 'insert', messageId: incoming.id,
        modelRequestInterrupted: this.reasoning.interrupt(active.turnId) };
    }
    const delivery = this.busy ? 'queue' : 'insert';
    this.pending = true;
    this.error = '';
    void this.pump();
    return { status: 'accepted', delivery, messageId: incoming.id };
  }
  restore(parent: RuntimeSessionTurnRequest, profile: AssistantProfile) {
    if (this.configured || this.busy || this.stopped || this.paused || !this.deps.exists(PERSONAL_ASSISTANT_SESSION)) return;
    this.configured = { parent: { ...parent, sessionId: PERSONAL_ASSISTANT_SESSION }, profile };
    this.restoreResults();
    if (this.results.watching(PERSONAL_ASSISTANT_SESSION)) this.schedule();
    const consumed = this.journal.modelHistory(PERSONAL_ASSISTANT_SESSION).read().entryIds;
    const deliveryPending = this.journal.read(PERSONAL_ASSISTANT_SESSION).some(entry =>
      entry.source === 'task' && entry.id.startsWith('bridge-delivery-') && !consumed.has(entry.id));
    if (this.pending || deliveryPending || this.results.ready(PERSONAL_ASSISTANT_SESSION).length) { this.pending = true; void this.pump(); }
    else this.scheduleMaintenance();
  }
  private restoreResults() {
    const id = PERSONAL_ASSISTANT_SESSION;
    this.results.restore(id, this.journal.modelHistory(id).read().taskResults);
    this.results.restoreWatching(id, this.deps.tasks(id));
  }
  private async pump() {
    if (this.busy || this.paused || this.stopped || !this.configured || !this.pending) return;
    let configured = this.configured;
    try {
      const sessionId = configured.parent.sessionId, history = this.journal.modelHistory(sessionId).read();
      const waiting = this.journal.read(sessionId).filter(entry => !history.entryIds.has(entry.id));
      this.results.restore(sessionId, history.taskResults);
      this.results.restoreWatching(sessionId, this.deps.tasks(sessionId));
      if (!this.retryRequested && !this.results.ready(sessionId).length && !waiting.length) {
        this.pending = false;
        return;
      }
      const first = waiting.find(isAuthoredInput);
      if (first?.delivery === 'queue') configured = this.journal.queuedSubmission(sessionId, first.id) ?? configured;
    } catch (error) { this.pending = false; this.error = retainedRuntimeError(error); return; }
    this.maintenance.cancel();
    this.busy = true; this.pending = false; this.error = ''; this.retry = undefined;
    const retryRequested = this.retryRequested;
    this.retryRequested = false;
    const controller = this.controller = new AbortController();
    this.directTools = new LiveToolPresentation();
    this.replyExpression = undefined;
    this.activeTurn = { turnId: configured.parent.turnId,
      webhook: Boolean(configured.parent.metadata.botSourceRef && configured.parent.turnId.startsWith('webhook-')),
      initialIds: new Set(this.journal.read(configured.parent.sessionId).map(entry => entry.id)), entries: [] };
    const execution = { ...configured.parent, turnId: `assistant_${randomUUID()}`,
      metadata: { ...configured.parent.metadata, personalAssistant: true } };
    this.deps.agents?.begin(execution, 'running');
    let failed = false;
    try { await settleAtAbort(this.respond(configured, controller.signal, execution.turnId, retryRequested), controller.signal, 'Assistant reply stopped.'); }
    catch (error) { failed = true; if (!this.stopped && !controller.signal.aborted) this.error = retainedRuntimeError(error); }
    finally {
      await this.deps.releaseTurnResources?.(configured.parent.sessionId, configured.parent.turnId);
      const status = controller.signal.aborted ? 'stopped' : failed ? 'failed' : 'completed';
      this.deps.agents?.update(execution.sessionId, execution.turnId, status);
      const sources = configured.parent.metadata.botSourceRefs;
      if (!configured.parent.metadata.botSourceRef && !(Array.isArray(sources) && sources.length))
        this.deps.observeOutcome?.({ nowMs: Date.now(), kind: 'turn_terminal', status }, execution.turnId);
      if (this.controller === controller) {
      this.activeTurn = undefined; this.completionTurn = undefined; this.busy = false; this.retry = undefined; this.controller = undefined;
      for (const lease of this.notifications.values()) lease.release();
      this.notifications.clear();
      try { if (!controller.signal.aborted && !this.stopped) this.deps.memory?.schedule(configured.parent); }
      catch (error) { this.error ||= retainedRuntimeError(error); }
      if (this.pending && !this.stopped) void this.pump();
      if (!this.busy && !this.pending && !failed && !controller.signal.aborted) this.scheduleMaintenance();
    } }
  }
  private scheduleMaintenance() {
    if (this.stopped || this.paused || this.busy || !this.configured) return;
    const configured = this.configured;
    this.maintenance.schedule(async signal => {
      const parent = await this.deps.prepareParent?.(configured.parent, signal) ?? configured.parent;
      signal.throwIfAborted();
      const history = this.journal.modelHistory(PERSONAL_ASSISTANT_SESSION);
      await this.maintenance.compact(history, parent, this.deps.provider, this.deps.checkpoint(), signal,
        this.deps.tasks(PERSONAL_ASSISTANT_SESSION).map(task => ({ taskId: task.taskId, status: task.status })), (before, after) => {
          const references = this.deps.memory?.checkpointReferences(before, after);
          if (references) history.append([references]);
        });
    }, 1000, this.deps.onMaintenanceError);
  }
  private taskOrigins(task: SubagentTask, entries: ConversationEntry[]) {
    return task.originMessageIds ?? entries.filter(entry => isAuthoredInput(entry) && entry.originTurnId === task.parentTurnId).map(entry => entry.id).slice(-256);
  }
  private staleChildInteractions(entries: ConversationEntry[]) {
    if (!entries.some(isChildInteraction)) return new Set<string>();
    const live = new Set(this.deps.tasks(PERSONAL_ASSISTANT_SESSION)
      .filter(task => task.status === 'running').flatMap(task =>
        (task.observation?.interactions ?? []).map(item => childInteractionId(task.taskId, item.interactionId))));
    return new Set(entries.filter(entry => isChildInteraction(entry) && !live.has(entry.id)).map(entry => entry.id));
  }
  private invalidateCompletion(origins: string[] | undefined) {
    const turn = this.completionTurn;
    if (!turn || !sameAssignment(turn.assignment, assignmentKey(origins))) return;
    turn.dirty = true;
    // Only an unpublished model draft/backoff is interrupted. Dispatched tools
    // finish normally and their receipts are committed before fresh facts enter.
    this.reasoning.interrupt(turn.key);
  }
  private reserveCompletions(entries: ConversationEntry[], assignment?: string) {
    const id = PERSONAL_ASSISTANT_SESSION;
    for (const task of this.deps.tasks(id)) this.results.observe(id, task);
    for (const task of this.results.ready(id)) {
      const origins = this.taskOrigins(task, entries);
      if (assignment && !sameAssignment(assignmentKey(origins), assignment)) continue;
      const lease = this.results.reserve(id, task);
      if (!lease) continue;
      const entry: ConversationEntry = { id: `task-${task.taskId}-${randomUUID()}`, role: 'user', source: 'task', visibility: 'internal',
        responseTo: origins, createdAt: new Date().toISOString(), content: JSON.stringify({ type: 'background_task_result', taskId: task.taskId,
          status: task.status, result: task.finalResponse, error: task.errorMessage }) };
      entries.push(entry); this.notifications.set(entry.id, lease);
      // Uncorrelated results retain independent ownership.
      assignment ??= assignmentKey(origins);
      if (!assignment) break;
    }
  }
  private commitCompletions(entries: ConversationEntry[]) {
    for (const entry of entries) {
      const lease = this.notifications.get(entry.id);
      if (!lease) continue;
      lease.commit(); this.notifications.delete(entry.id);
      this.journal.append(PERSONAL_ASSISTANT_SESSION, entry);
    }
  }
  private userMessagePrediction(sessionId: string, entries: ConversationEntry[]) {
    const latest = entries.filter(entry => entry.visibility !== 'internal').at(-1);
    if (!latest || latest.role !== 'assistant' || latest.source === 'voice') return;
    const history = this.journal.modelHistory(sessionId).read();
    if (!history.entryIds.has(latest.id)) return;
    const results = new Map<string, unknown>();
    for (let index = history.messages.length - 1; index >= 0; index--) {
      const message = history.messages[index];
      if (message.role === 'user') {
        if (message.visibility === 'internal' && ['memory_state_updates', 'individuation_preference'].includes(message.name ?? '')) continue;
        return;
      }
      if (message.role === 'tool') {
        try { results.set(message.toolCallId, JSON.parse(message.content)); } catch { /* Not a summary receipt. */ }
      }
      if (message.role !== 'assistant') continue;
      const call = [...message.toolCalls].reverse().find(tool => tool.name === 'summary_for_user');
      if (!call) continue;
      const prediction = savedUserMessagePrediction(call, results.get(call.id), latest.createdAt);
      return prediction && prediction.expiresAt > Date.now() ? { ...prediction, id: `${latest.id}:${prediction.id}` } : undefined;
    }
  }
  private async respond({ parent, profile }: { parent: RuntimeSessionTurnRequest; profile: AssistantProfile }, signal: AbortSignal, executionId: string, retryRequested: boolean) {
    parent = await this.deps.prepareParent?.(parent, signal) ?? parent;
    signal.throwIfAborted();
    const id = PERSONAL_ASSISTANT_SESSION;
    const memoryTools = this.deps.memory?.definitions() ?? [];
    const managementTools = this.deps.management?.definitions(parent) ?? [];
    const spoken = parent.metadata.assistantOutputMode === 'voice';
    const entries = this.journal.read(id);
    const history = this.journal.modelHistory(id);
    // Foreground work owns its reply. Completion delivery is selected only once
    // that work has committed its results, never queued as a second user input.
    const readIds = history.read().entryIds;
    if (!entries.some(entry => !readIds.has(entry.id) && entry.source !== 'task') && !retryRequested) {
      const notice = entries.find(entry => !readIds.has(entry.id));
      if (!notice || assignmentKey(notice.responseTo)) this.reserveCompletions(entries, assignmentKey(notice?.responseTo));
    }
    // Never redispatch a persisted call after a crash. Its side effect may have
    // happened even if the receipt was not committed. Keep the protocol complete.
    const prior = history.read().messages;
    let lastCall = -1;
    prior.forEach((item, index) => { if (item.role === 'assistant' && item.toolCalls.length) lastCall = index; });
    const pendingCall = prior[lastCall];
    if (pendingCall?.role === 'assistant') {
      const returned = new Set(prior.slice(lastCall + 1).flatMap(item => item.role === 'tool' ? [item.toolCallId] : []));
      history.append(pendingCall.toolCalls.filter(call => !returned.has(call.id)).map(call => ({ role: 'tool', toolCallId: call.id,
        content: JSON.stringify({ status: 'unknown', code: 'interrupted_tool_execution', error: 'Execution was interrupted before its receipt was saved. Check current state; do not assume success or repeat side effects.' }) })));
    }
    const consumed = history.read().entryIds;
    const unconsumed = entries.filter(item => !consumed.has(item.id));
    const queued = unconsumed.filter(item => item.delivery !== 'queue' || this.activeTurn?.initialIds.has(item.id));
    if (queued.length < unconsumed.length) this.pending = true;
    const stale = this.staleChildInteractions(queued);
    const redundant = queued.filter(item => stale.has(item.id) ||
      item.source === 'task' && teamCompletionAlreadyRead(item.content, history.read().messages));
    const redundantIds = new Set(redundant.map(item => item.id));
    if (redundant.length) history.append([], [...redundantIds]);
    const pending = queued.filter(item => !redundantIds.has(item.id));
    if (!pending.length && !retryRequested) return;
    // Give fresh instructions (including cancellations) their own reply. A
    // completion belongs to one assignment, even when several finish together.
    const foreground = pending.filter(item => item.source !== 'task');
    const sender = foreground.find(isAuthoredInput);
    const completionAssignment = assignmentKey(pending[0]?.responseTo);
    const boundQueue = (entry: ConversationEntry) => entry.delivery === 'queue' && this.journal.hasQueuedSubmission(id, entry.id);
    const remaining = sender && boundQueue(sender) ? [sender]
      : foreground.length ? foreground.filter(item => !boundQueue(item) && (!sender || !isAuthoredInput(item) ||
        (!item.botSourceRef && !sender.botSourceRef) || (item.originTurnId === sender.originTurnId && item.botSourceRef === sender.botSourceRef)))
      : completionAssignment ? pending.filter(item => sameAssignment(assignmentKey(item.responseTo), completionAssignment)) : pending.slice(0, 1);
    if (remaining.length < pending.length) this.pending = true;
    // A wait may finish while its completion notice is queued. Consuming that
    // notice must not start another model reply or discard concurrent user input.
    if (redundant.length && !remaining.length) return;
    const nativeDelegation = !profile.targetAgent && !spoken;
    const interactionTurn = remaining.some(isChildInteraction);
    // Spoken work ordinarily uses compact delegation. A reply to a child
    // still needs the existing structured response and observation schemas.
    const nativeTools = (this.deps.delegationTools?.() ?? []).filter(tool =>
      (nativeDelegation || interactionTurn && ['subagent', 'tasks'].includes(tool.name)) &&
      parent.tools.some(allowed => allowed.name === tool.name));
    const presentedNative = this.deps.management?.projectDelegation(parent, nativeTools) ?? nativeTools;
    const tools = [...(spoken ? [assistantPageTool] : []), ...conversationalSubagentTools.filter(tool => !nativeTools.some(native => native.name === tool.name)), ...presentedNative, ...memoryTools, ...managementTools];
    const modelTools = this.deps.management?.projectModelDefinitions(parent, tools) ?? tools;
    let authored = remaining.filter(isAuthoredInput).at(-1);
    const originalInputs = (item: ConversationEntry) => item.source === 'task'
      ? entries.filter(entry => item.responseTo?.includes(entry.id) && isAuthoredInput(entry))
      : [item];
    const sourceRefs = (item: ConversationEntry): Array<string | undefined> => {
      const originals = originalInputs(item), latest = originals.at(-1);
      if (latest?.botRecipientKey && latest.botSourceRef && originals.every(entry => entry.botRecipientKey === latest.botRecipientKey)) return [latest.botSourceRef];
      const refs = [...new Set([item.botSourceRef, ...originals.map(entry => entry.botSourceRef)].filter((ref): ref is string => !!ref))];
      return refs.length ? refs : [undefined];
    };
    // A completion can wake Assistant after another Bot/user has spoken. Child
    // tasks inherit the sources being handled now, never the last configured sender.
    const activeInputs = remaining.filter(item => item.role === 'user');
    // A retry resumes one unfinished reply, including every accepted correction.
    // These journal IDs are host state, not model-authored text or new user input.
    const resuming = retryRequested && !remaining.length;
    const replyInputs = resuming ? history.replyInputs()?.flatMap(inputId => entries.filter(entry => entry.id === inputId)) ?? [] : [];
    const handledInputs = activeInputs.length ? activeInputs : replyInputs.length ? replyInputs : entries.filter(item => item.role === 'user').slice(-1);
    if (resuming) authored = handledInputs.filter(isAuthoredInput).at(-1);
    const activeSources = new Set(handledInputs
      .flatMap(sourceRefs).filter((ref): ref is string => typeof ref === 'string'));
    parent = { ...parent, metadata: { ...parent.metadata, environmentExecutionId: executionId } };
    const evidence = [...new Map(handledInputs.flatMap(originalInputs).filter(isAuthoredInput).map(item => [item.id, item])).values()];
    parent.metadata.assistantEventEvidence = evidence.map(item => ({ id: item.id, sourceRef: item.botSourceRef }));
    parent.metadata.assistantUserRequest = Boolean(authored);
    const completion = handledInputs.every(item => item.source === 'task') ? handledInputs[0] : undefined;
    const brief = completion ? delegatedRequestContext(evidence, entries) : undefined;
    // A verification task can return to the same assignment. Reuse the latest
    // retained brief unless the originating input or later corrections changed.
    const previousBrief = brief && prior.slice().reverse().find(item => item.role === 'user' && item.name === 'delegated_user_request');
    if (completion && brief) {
      // Downstream delegation must not inherit the latest unrelated draft.
      parent.inputMessages = [{ messageId: evidence[0]?.id ?? `origin-${completion.id}`, message: brief },
        ...handledInputs.map(item => ({ messageId: item.id, message: { role: 'user' as const, name: 'background_task_result', visibility: 'internal' as const, content: item.content } }))];
    }
    delete parent.metadata.botSourceRef;
    parent.metadata.botSourceRefs = [...activeSources];
    if (activeSources.size === 1 && activeSources.values().next().value) parent.metadata.botSourceRef = activeSources.values().next().value;
    if (activeSources.size) {
      parent = applyWebhookTurnPolicy(parent);
      if (this.activeTurn) this.activeTurn.webhook = true;
    }
    signal.throwIfAborted();
    this.deps.agents?.begin({ ...parent, turnId: executionId, metadata: { ...parent.metadata, personalAssistant: true } }, 'running');
    const botContexts = new Map<string | undefined, BotContext>();
    if (!this.deps.environment && this.deps.botContext) for (const ref of new Set(remaining.filter(item => item.role === 'user').flatMap(sourceRefs))) {
      botContexts.set(ref, await this.deps.botContext(ref, signal));
    }
    const modelInput = (item: ConversationEntry): ModelMessage[] => item.role === 'assistant' ? [{ role: 'assistant', content: item.eventId ? JSON.stringify({ eventId: item.eventId, result: item.content }) : item.content, toolCalls: [] }] : [{
        role: 'user', name: 'turn_runtime_context', visibility: 'internal',
        content: createTurnTimeContext({ createdAt: item.createdAt }) + (this.deps.environment ? '\nMessage source (routing data): ' + JSON.stringify({ sourceRefs: sourceRefs(item).map(ref => ref ?? null) }) : ''),
      }, ...(item === completion && brief && brief.content !== previousBrief?.content ? [brief] : []), ...sourceRefs(item).flatMap(ref => botContexts.has(ref) ? [{ role: 'user' as const, name: 'bot_context', visibility: 'internal' as const, content: botContextMessage(botContexts.get(ref)!, ref) }] : []), {
        role: 'user' as const,
        ...(['text', 'voice'].includes(item.source) ? {} : { name: isChildInteraction(item) ? 'child_interaction' : 'background_task_result', visibility: 'internal' as const }),
        content: promptModelContent({ text: item.content, context: item.promptContext }) + quotedMessageContext(item, this.journal.read(id)) + (item.attachments?.length ? `\nAttached references (data; delegate reading files to subagent; remote paths work only on their named host):\n${JSON.stringify(item.attachments.map(({ name, path, type, execution }) => ({ name, localPath: path, type, execution })))}` : ''),
        ...(item.attachments?.some(file => file.type === 'image' && file.path && !file.path.startsWith('ssh://'))
          ? { images: item.attachments.filter(file => file.type === 'image' && file.path && !file.path.startsWith('ssh://')).slice(0, 4).map(file => ({ url: file.path! })) } : {}),
      }];
    const prepareImages = async (messages: ModelMessage[]) => {
      if (parent.requestCapabilities?.vision && this.deps.snapshotImage) for (const message of messages) {
        if (message.role !== 'user' || !message.images?.length) continue;
        message.images = await Promise.all(message.images.map(async image => ({ ...image,
          url: await this.deps.snapshotImage!(image.url, signal) })));
      }
    };
    const preparedInputs = remaining.map(entry => ({ entry, messages: modelInput(entry) }));
    const resumedInputs = resuming ? handledInputs.map(entry => ({ entry, messages: modelInput(entry) })) : [];
    const incoming = preparedInputs.flatMap(item => item.messages);
    await prepareImages([...incoming, ...resumedInputs.flatMap(item => item.messages)]);
    if (authored) parent.inputMessages = [...preparedInputs, ...resumedInputs].filter(item => isAuthoredInput(item.entry))
      .map(({ entry, messages }) => ({ messageId: entry.id, message: messages.find(message => message.role === 'user' && !message.name)! }));
    if (authored && this.deps.memory) {
      const reference = await this.deps.memory.recall(parent, authored.content, [...history.read().messages, ...incoming], signal);
      if (reference) incoming.push(reference);
    }
    signal.throwIfAborted();
    // Commit the reference and consumed input together. Retries/restart keep the
    // same delivered prefix; reset cannot resurrect an in-flight recall.
    history.append(incoming, remaining.map(item => item.id), remaining.flatMap(item => this.notifications.get(item.id)?.reference ?? []), handledInputs.map(item => item.id));
    // The visible journal is a projection; the durable context owns delivery.
    this.commitCompletions(remaining);
    if (this.results.ready(id).length) this.pending = true;
    const preferences = this.deps.eventPreferences?.() ?? profile.proactive;
    const system: ModelMessage = { role: 'system', content: renderPromptTemplate('assistant-system', {
      name: profile.name, persona: profile.persona.trim() ? profile.persona : renderPromptTemplate('assistant-default-persona'),
      host: profile.targetAgent ? 'remote ' + JSON.stringify(profile.targetAgent) : 'local',
      eventPolicy: renderPromptTemplate(preferences?.confirmedAt ? 'assistant-events-enabled' : 'assistant-events-requested-only'),
    }) };
    const incomingPreferences: ModelMessage[] = preferences ? [{
      role: 'user', name: 'confirmed_preferences', visibility: 'internal',
      content: JSON.stringify(preferences.confirmedAt ? preferences : {
        report: preferences.report, notificationSourceRef: preferences.notificationSourceRef,
      }),
    }] : [];
    const preferredName = await this.deps.preferredName?.(signal);
    signal.throwIfAborted();
    if (preferredName !== undefined) incomingPreferences.push({ role: 'user', name: 'registered_user_profile', visibility: 'internal', content: JSON.stringify({ preferredName }) });
    system.content += '\n' + renderPromptTemplate('tool-display-instructions') + '\n' + renderPromptTemplate('coordination-tool-boundaries');
    if (this.deps.memory) system.content += renderPromptTemplate('assistant-memory');
    system.content += '\n\n' + [OUTCOME_VERIFICATION_INSTRUCTIONS, REPORT_DELIVERY_INSTRUCTIONS, renderPromptTemplate('assistant-report')].join('\n\n');
    if (activeSources.size || parent.prefixMessages.some(message => message.role === 'developer' && message.name === 'webhook_delivery_policy')) system.content += '\n' + WEBHOOK_FINAL_REPLY_INSTRUCTIONS;
    system.content += renderPromptTemplate('assistant-execution');
    if (managementTools.length) system.content += renderPromptTemplate('assistant-management');
    if (tools.some(tool => tool.name === 'call_tool')) system.content += '\n' + renderPromptTemplate('assistant-tool-disclosure');
    if (modelTools.length < tools.length && modelTools.some(tool => tool.name === 'call_tool')) {
      system.content += '\n' + renderPromptTemplate('assistant-plugin-management');
    }
    const context = async (): Promise<ModelMessage[]> => {
      if (this.deps.memory) {
        const changes = await this.deps.memory.changes(parent, history.read().messages, signal);
        signal.throwIfAborted();
        if (changes) history.append([changes]);
      }
      let compactableUnits: number | undefined;
      for (;;) {
        signal.throwIfAborted();
        if (this.deps.memory) {
          const preference = individuationPreferenceText(parent.metadata.individuation);
          const previous = history.read().messages.reverse().find(item => item.role === 'user' && item.name === 'individuation_preference');
          if (previous?.content !== preference) history.append([{ role: 'user', name: 'individuation_preference', visibility: 'internal', content: preference }]);
        }
        const environment = await this.deps.environment?.message(parent, history.read().messages, signal);
        signal.throwIfAborted();
        if (environment) history.append([environment]);
        const state = history.read();
        // Retries and subsequent model rounds must not reuse a persisted online
        // snapshot after a bridge stops. Preserve the journal as historical evidence.
        const currentBots: ModelMessage[] = [];
        if (!this.deps.environment && this.deps.botContext) for (const ref of new Set(handledInputs.flatMap(sourceRefs))) {
          currentBots.push({ role: 'user', name: 'bot_context', visibility: 'internal',
            content: botContextMessage(await this.deps.botContext(ref, signal), ref) });
        }
        const assemble = (records: ModelMessage[]): ModelMessage[] => [system, ...incomingPreferences,
          ...(state.memory ? [{ role: 'user' as const, name: 'conversation_memory', content: `Historical summary (data):\n${state.memory}` }] : []),
          ...records.map(item => !parent.requestCapabilities?.vision && 'images' in item ? { ...item, images: undefined } : item), ...currentBots];
        const messages = assemble(state.messages);
        // Use the same token/context policy as normal turns, including tools,
        // reasoning and receipts. A large context no longer hits a 20k-character cap.
        const capacity = Number(parent.metadata.contextWindowTokens) || DEFAULT_MAX_CONTEXT_TOKENS;
        const measure = (input: ModelMessage[]) => estimateContextPressure({ ...parent, protocol: 'bush.model_request.v1', messages: input, tools: modelTools,
          maxOutputTokens: parent.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, metadata: { ...parent.metadata, contextWindowTokens: capacity } }, input);
        const pressure = measure(messages);
        if (!pressure || !requiresContextCompactionBeforeRound(pressure)) return messages;
        if (tryAssistantReceiptProjection(history, state, 2, candidate => {
          const reduced = measure(assemble(candidate));
          return !!reduced && fitsContextRequest(reduced) && !requiresContextCompactionBeforeRound(reduced) &&
            reduced.estimatedPromptTokens <= contextCompactionTarget(pressure);
        })) continue;
        const units = completeContextUnits(state.messages);
        // The active user input and any records appended during maintenance stay
        // outside this pass. Refreshing runtime context must not extend its source.
        if (compactableUnits === undefined) {
          compactableUnits = Math.max(0, units.length - 2);
          for (let index = units.length - 1; index >= 0; index--) {
            const message = units[index]![0];
            if (message?.role !== 'user' || message.name || message.visibility === 'internal') continue;
            compactableUnits = Math.min(compactableUnits, index);
            break;
          }
        }
        if (!compactableUnits) return messages;
        const source = units.slice(0, Math.min(compactableUnits, 60));
        while (source.length > 1 && JSON.stringify(source).length > 60000) source.pop();
        const jobId = randomUUID(), through = state.through + source.flat().length;
        const result = await compactRealtimeContext(this.deps.provider, {
          job: { jobId, sessionId: id, revision: state.through, through, previousSummary: state.summary,
            maxSummaryCharacters: Math.min(assistantWorkingSetPolicy.summaryCharacters, Math.floor(capacity / 4)), pairs: source.flatMap(unit => {
              const value = JSON.stringify(unit), chunks = [];
              for (let offset = 0; offset < value.length; offset += 30000) chunks.push({ user: value.slice(offset, offset + 30000), assistant: 'Historical exchange; adjacent chunks belong to the same exchange.' });
              return chunks;
            }) },
          model: { model: parent.model, providerBinding: parent.providerBinding, reasoningEffort: parent.reasoningEffort, maxOutputTokens: parent.maxOutputTokens, metadata: parent.metadata },
        }, this.deps.checkpoint(), signal, this.deps.tasks(id).map(task => ({ taskId: task.taskId, status: task.status })),
        { maintenance: 'assistant_context_compaction' });
        signal.throwIfAborted();
        history.checkpoint(through, result.summary, [], Math.min(6000, Math.floor(capacity * 0.2)));
        compactableUnits -= source.length;
        const references = this.deps.memory?.checkpointReferences(state.messages, history.read().messages);
        if (references) history.append([references]);
      }
    };
    const publish = (entry: Parameters<ConversationJournal['append']>[1]) => {
      signal.throwIfAborted();
      this.journal.append(id, { ...entry, responseTo: [...new Set(handledInputs.flatMap(item => item.role === 'user'
        ? ['text', 'voice'].includes(item.source) ? [item.id] : item.responseTo ?? [] : []))].slice(-256) });
      history.append([], [entry.id]);
    };
    if (this.activeTurn?.webhook && (!authored || authored.originTurnId !== parent.turnId)) {
      if (this.activeTurn?.entries.length) this.pending = true;
      this.activeTurn = undefined;
    }
    const live = this.activeTurn;
    const completionState = completion && assignmentKey(completion.responseTo)
      ? this.completionTurn = { key: live?.turnId ?? executionId, assignment: assignmentKey(handledInputs.flatMap(item => item.responseTo ?? []))!, dirty: false } : undefined;
    const consumeCompletions = async () => {
      if (!completionState) return;
      completionState.dirty = false;
      const latest = this.journal.read(id), consumed = history.read().entryIds;
      this.reserveCompletions(latest, completionState.assignment);
      const candidates = latest.filter(item => item.source === 'task' && !consumed.has(item.id) && sameAssignment(assignmentKey(item.responseTo), completionState.assignment));
      // An inspect receipt may settle while its terminal event is pending. The
      // receipt owns that exact result version, including in an active reply.
      const observed = history.read().messages;
      const stale = this.staleChildInteractions(candidates);
      const delivered = candidates.filter(item => stale.has(item.id) || teamCompletionAlreadyRead(item.content, observed));
      if (delivered.length) history.append([], delivered.map(item => item.id));
      const additions = candidates.filter(item => !delivered.includes(item) &&
        (!isChildInteraction(item) || nativeTools.some(tool => tool.name === 'subagent')));
      if (!additions.length) return;
      const messages = additions.flatMap(modelInput);
      await prepareImages(messages);
      signal.throwIfAborted();
      history.append(messages, additions.map(item => item.id), additions.flatMap(item => this.notifications.get(item.id)?.reference ?? []), [...handledInputs, ...additions].map(item => item.id));
      this.commitCompletions(additions);
      entries.push(...additions); remaining.push(...additions); handledInputs.push(...additions);
      parent.inputMessages.push(...additions.map(item => ({ messageId: item.id, message: { role: 'user' as const, name: 'background_task_result', visibility: 'internal' as const, content: item.content } })));
    };
    let expression: AssistantExpression | undefined;
    const consumeGuidance = async () => {
      if (!live?.entries.length) return;
      expression = undefined;
      const count = live.entries.length;
      const consumed = history.read().entryIds;
      const additions = live.entries.slice(0, count).filter(entry => !consumed.has(entry.id));
      if (!additions.length) { live.entries.splice(0, count); return; }
      if (!this.deps.environment && this.deps.botContext) for (const ref of new Set(additions.flatMap(sourceRefs))) {
        if (!botContexts.has(ref)) botContexts.set(ref, await this.deps.botContext(ref, signal));
      }
      const prepared = additions.map(entry => ({ entry, messages: modelInput(entry) }));
      const messages = prepared.flatMap(item => item.messages);
      await prepareImages(messages);
      const ref = additions.at(-1)!.botSourceRef;
      const updatedParent: RuntimeSessionTurnRequest = { ...parent,
        inputMessages: [...parent.inputMessages, ...prepared.map(({ entry, messages }) => ({ messageId: entry.id,
          message: messages.find(message => message.role === 'user' && !message.name)! }))],
        metadata: { ...parent.metadata, botSourceRefs: ref ? [ref] : [], assistantUserRequest: true,
          assistantEventEvidence: [...evidence, ...additions].slice(-256).map(entry => ({ id: entry.id, sourceRef: entry.botSourceRef })) } };
      if (ref) updatedParent.metadata.botSourceRef = ref;
      else delete updatedParent.metadata.botSourceRef;
      if (this.deps.memory) {
        const reference = await this.deps.memory.recall(updatedParent, additions.at(-1)!.content, [...history.read().messages, ...messages], signal);
        if (reference) messages.push(reference);
      }
      signal.throwIfAborted();
      history.append(messages, additions.map(entry => entry.id), [], [...handledInputs, ...additions].map(entry => entry.id));
      live.entries.splice(0, count);
      remaining.push(...additions); handledInputs.push(...additions);
      authored = additions.at(-1)!;
      parent = updatedParent;
      evidence.push(...additions);
    };
    let published = false;
    const approvedInteractions = new Set<string>();
    const directTools = this.directTools;
    let hookStopped: Error | undefined;
    for (let round = 0; round < 10; round++) {
      signal.throwIfAborted();
      await consumeGuidance();
      await consumeCompletions();
      const request: ModelRequest = { ...parent, protocol: 'bush.model_request.v1',
        requestId: randomUUID(), messages: await context(), tools: modelTools, requestCapabilities: { vision: parent.requestCapabilities?.vision === true, interactiveRequests: false },
        metadata: { ...parent.metadata, personalAssistant: true } };
      if (live?.entries.length || completionState?.dirty) { round--; continue; }
      let result: Awaited<ReturnType<typeof executeBufferedModelRound>>;
      try {
        result = await this.reasoning.run(live?.turnId ?? executionId, signal, attempt => executeBufferedModelRound(this.deps.provider, request,
          { signal: attempt, wait: this.deps.wait, reservedToolCallIds: history.toolCallIds(),
            onRetry: status => { if (!attempt.aborted) this.retry = status; } }));
      } catch (error) {
        if (!(error instanceof ModelRequestInterrupted)) throw error;
        this.retry = undefined; round--; continue;
      }
      signal.throwIfAborted();
      if (live?.entries.length || completionState?.dirty) { round--; continue; }
      const retried = Boolean(this.retry);
      this.retry = undefined;
      if (result.status !== 'completed') {
        if (result.error.retryable && retried) throw new RuntimeUiError('assistantRuntime.retriesExhausted', { code: result.error.code });
        throw Error(result.error.message);
      }
      if (!result.toolCalls.length && ['length', 'max_tokens'].includes(result.finishReason ?? '')) throw new RuntimeUiError('assistantRuntime.outputLimit');
      if (!result.toolCalls.length && !result.text.trim() && !published) throw new RuntimeUiError('assistantRuntime.emptyReply');
      const { toolCalls } = result;
      history.append([{ role: 'assistant', content: result.text, toolCalls,
        ...(result.reasoning ? { reasoningContent: result.reasoning } : {}), ...(result.providerReplay ? { providerReplay: result.providerReplay } : {}) }]);
      if (!toolCalls.length) {
        const text = result.text.trim() || (spoken && published ? uiText(resolveUiLanguage(parent.metadata.uiLanguage))('assistantRuntime.published') : '');
        this.activeTurn = undefined;
        this.completionTurn = undefined;
        if (text) {
          const replyId = `text-${randomUUID()}`;
          publish({ id: replyId, role: 'assistant', content: text, createdAt: new Date().toISOString(), source: spoken ? 'voice' : 'text', visibility: 'conversation', ...(spoken ? { voiceMode: 'chained' as const } : {}) });
          this.replyExpression = expression ? { mood: expression, replyId, expiresAt: Date.now() + 6000 } : undefined;
        }
        history.append([], [], [], []);
        return;
      }
      // A new tool round supersedes an earlier final-display signal.
      expression = undefined;
      let memoryQueue: Promise<unknown> = Promise.resolve();
      let delegationQueue: Promise<unknown> = Promise.resolve();
      let managementQueue: Promise<unknown> = Promise.resolve();
      const failures = new Set<string>();
      const executedNames = new Map<number, string>();
      const nativeResults = new Map<number, unknown>();
      const outcomes = new Map<number, ToolExecutionOutcome>();
      this.executingTools = signal;
      const execute = async (ordinal: number) => {
        let call = toolCalls[ordinal]!;
        const onOutcome = (outcome: ToolExecutionOutcome) => outcomes.set(ordinal, outcome);
        try {
          signal.throwIfAborted();
          if (hookStopped) throw hookStopped;
          if (!tools.some(tool => tool.name === call.name)) throw Object.assign(Error('Tool is not available.'), { code: 'tool_unavailable' });
          call = this.deps.management?.resolveInvocation(call, parent, request, nativeTools) ?? call;
          executedNames.set(ordinal, call.name);
          const definition = tools.find(tool => tool.name === call.name);
          if (!definition) throw Object.assign(Error('Tool is not available.'), { code: 'tool_unavailable' });
          // Providers add presentation metadata to every function schema. Use the
          // same boundary as the normal tool coordinator before business validation.
          const args = stripToolDisplayTitle(JSON.parse(call.argumentsText), definition);
          const run = async <T>(callback: () => Promise<T> | T) => {
            signal.throwIfAborted();
            directTools.start(call.id, call.name);
            try {
              const value = await callback();
              directTools.finish(call.id);
              return value;
            } catch (error) { directTools.cancel(call.id); throw error; }
          };
          let output: unknown;
          if (call.name === 'page_write') {
            const { content } = assistantPageInputSchema.parse(args);
            await run(() => publish({ id: `page-${randomUUID()}`, role: 'assistant', content, createdAt: new Date().toISOString(), source: 'page', visibility: 'conversation' }));
            published = true; output = { status: 'written' };
          } else if (call.name === 'tasks' && !nativeTools.some(tool => tool.name === call.name)) {
            const { action, task_ids, cursor } = conversationalTaskInput.parse(args);
            const tasks = this.deps.tasks(id);
            if (task_ids?.some(taskId => !tasks.some(task => task.taskId === taskId))) throw Object.assign(Error('Task is not owned by this assistant.'), { code: 'subagent_not_owned' });
            if (action === 'conversation') {
              output = await run(() => this.deps.delegate({ sessionId: id, callId: `assistant-${randomUUID()}`, action: 'read_subagent_conversation',
                parent, taskId: task_ids![0], cursor, targetAgent: profile.targetAgent || undefined }));
              signal.throwIfAborted();
            } else {
              const selected = tasks.filter(task => !task_ids?.length || task_ids.includes(task.taskId));
              await run(() => { selected.forEach(task => this.results.watch(id, task)); this.schedule(); });
              output = { status: selected.some(task => task.status === 'running') ? 'watching' : 'settled', tasks: selected.map(task => ({ taskId: task.taskId, status: task.status, result: task.finalResponse.slice(0, 8000) })) };
              const value = output as { tasks: Array<{ taskId: string; status: string; result: string }> };
              const leases = selected.flatMap(task => task.finalResponse.length <= 8000 ? [this.results.reserve(id, task)].filter((lease): lease is TaskResultLease => Boolean(lease)) : []);
              if (leases.length) {
                // This compatibility receipt has camel-case IDs; its whole body is delivered.
                output = taskReceiptDelivery(value, leases.map(lease => ({ lease, value })));
              }
            }
          } else if (call.name === 'get_tool_schema' || managementTools.some(tool => tool.name === call.name)) {
            const execution = managementQueue.then(async () => {
              if (hookStopped) throw hookStopped;
              return await run(() => this.deps.management!.execute({ ...call, argumentsText: JSON.stringify(args) }, parent, request, round, ordinal, signal, nativeTools, onOutcome));
            });
            managementQueue = execution.catch(() => undefined);
            output = await execution;
          } else if (memoryTools.some(tool => tool.name === call.name)) {
            // Serialize memory operations, including corrections, through the
            // existing validators and receipts. Execution tools stay delegated.
            const execution = memoryQueue.then(() => run(() => this.deps.memory!.execute({ ...call, argumentsText: JSON.stringify(args) },
              request, authored?.content, round, ordinal, signal)));
            memoryQueue = execution.catch(() => undefined);
            output = await execution;
            if (call.name === 'summary_for_user' && output && typeof output === 'object' && 'expression' in output)
              expression = assistantExpressionSchema.parse(output.expression);
          } else if (nativeTools.some(tool => tool.name === call.name)) {
            // Preserve registration-before-assembly order within one model batch.
            // Dispatch receipts are immediate; the child work remains independent.
            const execution = delegationQueue.then(() => {
              if (hookStopped) throw hookStopped;
              return run(() => this.deps.delegate({ sessionId: id, callId: `assistant-${randomUUID()}`, action: call.name, parent, nativeArguments: args }, signal, onOutcome));
            });
            delegationQueue = execution.catch(() => undefined);
            output = await execution;
            nativeResults.set(ordinal, output);
            signal.throwIfAborted();
            this.watchDelegation(output);
          } else {
            const input = conversationalSubagentInput.parse(args);
            output = await run(() => this.deps.delegate({ sessionId: id, callId: `assistant-${randomUUID()}`, action: call.name,
              parent, prompt: input.prompt, taskId: input.task_id, delivery: input.delivery, targetAgent: profile.targetAgent || undefined }, signal, onOutcome));
            nativeResults.set(ordinal, output);
            signal.throwIfAborted();
            this.watchDelegation(output);
          }
          nativeResults.set(ordinal, output);
          return { role: 'tool' as const, toolCallId: call.id, content: JSON.stringify(output) };
        } catch (error) {
          if (error instanceof Error && 'code' in error && ['assistant_management_stopped', 'plugin_hook_stopped'].includes(String(error.code))) hookStopped ??= error;
          failures.add(call.id);
          const code = error instanceof z.ZodError || error instanceof SyntaxError ? 'invalid_tool_arguments'
            : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'assistant_tool_failed';
          return { role: 'tool' as const, toolCallId: call.id, content: JSON.stringify({ status: 'failed', code, error: error instanceof Error ? error.message : String(error) }) };
        }
      };
      const results: ModelMessage[] = new Array(toolCalls.length);
      let approvalBatch = false;
      try {
        for (const phase of toolExecutionPhases(toolCalls)) {
          await Promise.all(phase.map(async ordinal => { results[ordinal] = await execute(ordinal); }));
        }
        signal.throwIfAborted();
        const deliveries = [...nativeResults].flatMap(([ordinal, output]) => resultDelivery(output)?.references(String(results[ordinal]?.content ?? '')) ?? []);
        const hooks = toolHookMessages([...outcomes].sort(([a], [b]) => a - b).map(([, outcome]) => outcome));
        history.append([...results, ...hooks], [], deliveries);
        for (const [ordinal, output] of nativeResults) resultDelivery(output)?.commit(String(results[ordinal]?.content ?? ''));
        const approvals = toolCalls.map((_call, ordinal) => executedNames.get(ordinal) === 'subagent' ? silentChildApproval(nativeResults.get(ordinal)) : undefined);
        if (!hooks.length && !failures.size && approvals.every((id): id is string => id !== undefined)) {
          approvals.forEach(id => approvedInteractions.add(id));
          approvalBatch = true;
        }
      } finally {
        for (const output of nativeResults.values()) resultDelivery(output)?.release();
        if (this.executingTools === signal) this.executingTools = undefined;
      }
      if (!activeSources.size) for (const [ordinal, call] of toolCalls.entries()) {
        const failed = failures.has(call.id);
        this.deps.observeOutcome?.({ nowMs: Date.now(), kind: failed ? 'tool_failed' : 'tool_returned',
          toolName: executedNames.get(ordinal) ?? call.name, status: failed ? 'failed' : 'completed' }, executionId + ':' + call.id);
      }
      if (hookStopped) throw hookStopped;
      if (approvalBatch && !published && !live?.entries.length && finishedChildApprovals(
        handledInputs.map(item => isChildInteraction(item) ? childApprovalNoticeId(item.content) : undefined), approvedInteractions,
      )) {
        history.append([], [], [], []);
        return;
      }
    }
    throw new RuntimeUiError('assistantRuntime.roundLimit');
  }
  private watchDelegation(output: unknown) {
    const receipt = output as { taskId?: string; status?: string } | undefined;
    // Native terminal receipts stay watched until projection/context commits.
    // Standalone adapters without lifecycle ownership retain their direct receipt contract.
    if (!receipt?.taskId || receipt.status === 'not_delivered' || (!resultDelivery(output) && ['completed', 'failed', 'stopped', 'unavailable'].includes(receipt.status ?? ''))) return;
    const task = this.deps.tasks(PERSONAL_ASSISTANT_SESSION).find(task => task.taskId === receipt.taskId);
    if (task) this.results.watch(PERSONAL_ASSISTANT_SESSION, task);
    this.schedule();
  }
  private schedule() {
    if (this.timer || this.stopped) return;
    const recovery = this.recovery;
    this.timer = setTimeout(async () => {
      try {
      await this.deps.refreshTasks?.(PERSONAL_ASSISTANT_SESSION, recovery.signal);
      if (this.stopped || recovery.signal.aborted) return;
      for (const task of this.deps.tasks(PERSONAL_ASSISTANT_SESSION)) this.results.observe(PERSONAL_ASSISTANT_SESSION, task);
      const ready = this.results.ready(PERSONAL_ASSISTANT_SESSION);
      if (ready.length) {
        this.pending = true;
        const entries = this.journal.read(PERSONAL_ASSISTANT_SESSION);
        for (const task of ready) this.invalidateCompletion(this.taskOrigins(task, entries));
      }
      void this.pump();
      } catch (error) { if (!recovery.signal.aborted) this.error = retainedRuntimeError(error); }
      finally {
        if (this.recovery === recovery) {
          this.timer = undefined;
          if (this.results.watching(PERSONAL_ASSISTANT_SESSION)) this.schedule();
        }
      }
    }, 1200);
    this.timer.unref?.();
  }
  notifyTeamResult(run: TeamRun) {
    if (this.stopped || !this.configured || run.parentSessionId !== PERSONAL_ASSISTANT_SESSION) return;
    const content = JSON.stringify(teamCompletionNotice(run));
    if (teamCompletionAlreadyRead(content, this.journal.modelHistory(PERSONAL_ASSISTANT_SESSION).read().messages)) return;
    this.journal.append(PERSONAL_ASSISTANT_SESSION, { id: `team-${run.id}-${randomUUID()}`, role: 'user', source: 'task', visibility: 'internal',
      responseTo: run.originMessageIds ?? this.journal.read(PERSONAL_ASSISTANT_SESSION).filter(entry => entry.role === 'user' && entry.originTurnId === run.parentTurnId).map(entry => entry.id).slice(-256),
      createdAt: new Date().toISOString(), content });
    this.invalidateCompletion(run.originMessageIds ?? this.journal.read(PERSONAL_ASSISTANT_SESSION).filter(entry => isAuthoredInput(entry) && entry.originTurnId === run.parentTurnId).map(entry => entry.id).slice(-256));
    this.pending = true; void this.pump();
  }
  notifyChildInteraction(task: SubagentTask, interactionId: string, content: string) {
    if (this.stopped || task.parentSessionId !== PERSONAL_ASSISTANT_SESSION) return;
    const entries = this.journal.read(PERSONAL_ASSISTANT_SESSION);
    const id = childInteractionId(task.taskId, interactionId);
    if (entries.some(entry => entry.id === id)) return;
    const responseTo = this.taskOrigins(task, entries);
    this.journal.append(PERSONAL_ASSISTANT_SESSION, { id, role: 'user', source: 'task', visibility: 'internal',
      responseTo, createdAt: new Date().toISOString(), content });
    this.invalidateCompletion(responseTo);
    this.pending = true; void this.pump();
  }
  forget(sessionId: string) {
    if (sessionId === PERSONAL_ASSISTANT_SESSION) this.maintenance.cancel();
    if (sessionId === PERSONAL_ASSISTANT_SESSION) { this.recovery.abort(); this.recovery = new AbortController(); }
    this.deps.agents?.forget(sessionId);
    if (sessionId === PERSONAL_ASSISTANT_SESSION) { this.replyExpression = undefined; this.directTools.clear(); }
    if (sessionId === PERSONAL_ASSISTANT_SESSION) { this.activeTurn = undefined; this.completionTurn = undefined; this.generation++; this.controller?.abort(); this.controller = undefined; this.busy = false; this.error = ''; this.retry = undefined; this.pending = false; this.paused = false; this.configured = undefined; for (const lease of this.notifications.values()) lease.release(); this.notifications.clear(); this.results.forget(sessionId); this.requestIds.clear(); clearTimeout(this.timer); this.timer = undefined; }
    if (sessionId === PERSONAL_ASSISTANT_SESSION) this.deps.management?.reset();
    this.journal.forget(sessionId);
  }
  close() { this.stopped = true; this.maintenance.cancel(); this.recovery.abort(); this.controller?.abort(); clearTimeout(this.timer); }
}
