import { AutomationClock } from './automationClock.js';
import { presentExistingScheduleActions } from './extendedBuiltins.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { renderPromptTemplate } from '@cardbush/platform/prompts';
import { PERSONAL_ASSISTANT_SESSION, FRIENDS_SESSION, friendsCommandSchema, eventRecurrenceSchema, applyWebhookTurnPolicy, type EventRecurrence, type BotContext, type FriendInput, type FriendsSnapshot, type FriendsWorkEvent,
  type FriendsConnectionStatus, type ModelRequest, type RuntimeEvent, type RuntimeSessionTurnRequest, type ToolDefinition } from '@cardbush/bush-protocol';
import { AssistantEventStore, settleFriendsWebhook, type FriendsState } from './assistantEventStore.js';
import type { ToolRegistry } from './toolRegistry.js';
import { nextEventOccurrence } from './eventRecurrence.js';

const text = z.string().trim().min(1).max(4000);
const decisionSchema = z.object({ disposition: z.enum(['completed', 'watching', 'waiting_user']), basis: text, notifyUser: z.boolean().optional(), endSubscription: z.boolean().optional(),
  habitRefs: z.array(z.object({ id: z.string().min(1), revision: z.number().int().positive() }).strict()).max(20) }).strict();
const createSchema = z.object({ logicalKey: z.string().trim().min(1).max(160), title: text.max(160), intent: text, subscription: z.boolean().optional() }).strict();
const watchSchema = z.object({ eventId: z.string().min(1), at: z.string().datetime({ offset: true }).optional(), recurrence: eventRecurrenceSchema.optional() })
  .strict().refine(watch => Boolean(watch.at) !== Boolean(watch.recurrence), 'Provide either at or recurrence.');
const emptyInteractions = () => ({ permissions: [], solutions: [] });
type Delivery = { route?: FriendsWorkEvent['deliveryRoute']; at?: string; recurrence?: EventRecurrence; fromAssistant?: boolean; sourceMessageId?: string; subscriptionTopic?: string };
type Runner = (request: ModelRequest, signal: AbortSignal) => Promise<{ terminal: RuntimeEvent; text: string }>;

/** Event state and dispatch only. Tools, model execution and permissions belong to Runtime. */
export class AssistantEvents {
  readonly store: AssistantEventStore;
  private scheduler: AutomationClock;
  private wake = () => this.kick();
  private execution?: Promise<void>;
  private controller?: AbortController;
  private readonly eventWork = new Map<string, AbortController>();
  private closed = false;
  private configured = false;
  private stagedDecision?: z.infer<typeof decisionSchema>;
  private activationEventIds = new Set<string>();
  private automaticActivation = false;
  private clock: () => number;
  constructor(path: string, private deps: {
    tools: ToolRegistry; run: Runner; now?: () => number; clock?: AutomationClock;
    botContext?: (ref?: string) => Promise<BotContext>;
    publish?: (notice: NonNullable<FriendsState['notifications']>[number]) => void;
    interactions?: () => Pick<FriendsSnapshot, 'permissions' | 'solutions'>;
    onError?: (error: unknown) => void;
  }) {
    this.scheduler = deps.clock ?? new AutomationClock();
    this.store = new AssistantEventStore(path); this.clock = deps.now ?? Date.now;
    this.registerAssistantTool();
    this.registerTools();
    // A fresh host must receive current model bindings and permission configuration
    // before resuming persisted detections. Reading status never starts execution.
  }
  environment(): FriendsConnectionStatus {
    return this.store.select(state => ({ configured: this.configured,
      pending: state.signals.filter(signal => state.events.some(event => event.id === signal.eventId && !['paused', 'failed'].includes(event.status))).length,
      watching: this.configured ? state.detections.filter(d => state.events.some(event => event.id === d.eventId && !['paused', 'failed'].includes(event.status))).length : 0,
      active: state.active ? { eventId: state.active.eventId, turnId: state.active.turnId } : null }));
  }
  async command(value: unknown, delivery?: Delivery) {
    const command = friendsCommandSchema.parse(value);
    if (command.action === 'read') return this.snapshot();
    if (command.action === 'status') { await this.store.ready; return this.environment(); }
    if (command.action === 'preferences') {
      await this.store.ready;
      return this.store.select(state => {
        const config = state.configuration;
        if (!config || config.assistant) return config?.assistant?.proactive ?? null;
        return { recognition: config.profile.recognition, confirmedAt: config.profile.confirmedAt,
          beforeExecution: config.profile.interactionPreferences?.beforeExecution ?? 'ask', report: config.profile.interactionPreferences?.report ?? 'important' };
      });
    }
    if (command.action === 'targets') {
      const bots = await this.deps.botContext?.();
      return (bots?.targets ?? []).filter(target => target.available).map(({ sourceRef, botName, senderId, conversationId }) =>
        ({ sourceRef, botName, senderId, conversationId }));
    }
    if (command.action === 'binding') {
      await this.store.ready;
      return this.store.select(state => {
        const config = state.configuration;
        if (!this.configured || !config?.assistant) return null;
        return { profile: config.assistant, parent: { ...config.parent, sessionId: PERSONAL_ASSISTANT_SESSION,
          inputMessages: [{ messageId: 'binding', message: { role: 'user', content: 'Webhook binding' } }] } };
      });
    }
    if (command.action === 'read_webhook') {
      await this.store.ready;
      return this.store.select(state => state.webhookReceipts?.[`webhook-input-${command.receiptId}`] ?? null);
    }
    if (this.closed) throw Error('FRIENDS_CLOSED');
    if (command.action === 'receive_webhook') {
      const id = `webhook-input-${command.receiptId}`, sourceRef = `webhook:${command.receiptId}`;
      const receipt = await this.store.change(state => {
        const receipts = state.webhookReceipts ??= {};
        if (receipts[id]) return receipts[id];
        if (!state.configuration) throw Error('FRIENDS_NOT_CONFIGURED');
        if (state.signals.length >= 100) throw Error('FRIENDS_QUEUE_FULL');
        if (state.events.some(event => event.id === id || event.inputs.some(input => input.id === id))) throw Error('FRIENDS_INPUT_ID_CONFLICT');
        const matches = command.recipientKey ? state.events.filter(event => !event.archived && event.status === 'waiting_user' &&
          event.deliveryRoute?.recipientKey === command.recipientKey) : [];
        let event = matches.length === 1 ? matches[0] : undefined;
        const relatesTo = event?.id;
        if (!event) {
          this.capacity(state);
          event = this.newEvent(id, command.text.slice(0, 160), command.text, 'user', id); state.events.push(event);
        }
        if (event.inputs.length >= 100) throw Error('FRIENDS_EVENT_INPUT_LIMIT');
        event.inputs.push({ id, text: command.text, createdAt: command.createdAt, botSourceRef: sourceRef, ...(relatesTo ? { relatesTo } : {}) });
        event.deliveryRoute = { sourceRef, recipientKey: command.recipientKey };
        event.status = 'queued'; delete event.error; this.touch(event); this.enqueue(state, event.id, 'input', id);
        return receipts[id] = { status: 'pending', reply: '' };
      });
      this.kick(); return receipt;
    }
    if (command.action === 'configure') {
      if (command.parent.sessionId !== (command.assistant ? PERSONAL_ASSISTANT_SESSION : FRIENDS_SESSION)) throw Error('FRIENDS_IDENTITY_REQUIRED');
      new Intl.DateTimeFormat('en', { timeZone: command.profile.timeZone });
      const preferred = command.assistant?.proactive?.notificationSourceRef;
      const defaultRoute = preferred ? (await this.resolveRoute(preferred) ?? { sourceRef: preferred }) : undefined;
      await this.store.change(state => {
        const discover = !command.assistant || Boolean(command.assistant.proactive?.confirmedAt);
        const first = !state.configuration || (!state.discoveryStarted && !state.events.length);
        // Retain infrastructure and explicit user instructions, never the last chat input.
        const parent = { ...command.parent, inputMessages: [] };
        state.configuration = { parent, profile: command.profile, assistant: command.assistant, defaultRoute };
        if (discover && first) {
          const event = this.newEvent('startup', command.profile.name || FRIENDS_SESSION, renderPromptTemplate('friends-startup'), 'system');
          state.events.push(event); this.enqueue(state, event.id, 'startup', 'startup');
        } else if (discover && !state.discoveryStarted && !state.active && !state.signals.length && !state.detections.length &&
          state.events.length === 1 && state.events[0].logicalKey === 'startup' && !state.events[0].inputs.length && !state.events[0].archived && state.events[0].status === 'completed') {
          // One upgrade activation for an old setup that finished without starting
          // any work. Never replay failed/paused work or pending questions.
          const event = this.newEvent('recognition-discovery', command.profile.name || FRIENDS_SESSION, renderPromptTemplate('friends-startup'), 'system');
          state.events.push(event); this.enqueue(state, event.id, 'startup', 'recognition-discovery');
        }
        if (discover) state.discoveryStarted = true;
      });
      await this.publishNotifications();
      this.configured = true;
    } else if (command.action === 'submit') {
      await this.submit(command.input, delivery);
      return this.snapshot();
    } else {
      let deletedRun: AbortController | undefined;
      await this.store.change(state => {
        const event = this.event(state, command.eventId);
        if (command.action === 'delete') {
          if (delivery?.route && !this.matchesRoute(event, delivery.route)) throw Error('FRIENDS_EVENT_NOT_FOUND');
          const signals = state.signals.filter(signal => signal.eventId === event.id);
          settleFriendsWebhook(state, signals.map(signal => signal.id), { status: 'interrupted', reply: '', errorCode: 'friends_deleted' });
          state.signals = state.signals.filter(signal => signal.eventId !== event.id);
          state.detections = state.detections.filter(timer => timer.eventId !== event.id);
          state.notifications = state.notifications?.filter(notice => notice.eventId !== event.id);
          state.events = state.events.filter(item => item.id !== event.id);
          if (state.active?.eventId === event.id) {
            deletedRun = this.controller;
            delete state.active;
          }
          return;
        }
        if (command.action === 'archive' || command.action === 'restore') event.archived = command.action === 'archive';
        else if (command.action === 'pause') this.pause(state, event);
        else {
          if (event.status === 'running') return;
          if (event.recurrence && !event.interruptedTurnId && event.status !== 'failed') {
            if (event.status === 'watching') return;
            this.armRecurrence(state, event.id, event.recurrence);
            event.status = state.signals.some(signal => signal.eventId === event.id) ? 'queued' : 'watching';
          } else {
            event.status = 'queued';
            this.enqueue(state, event.id, 'resume', randomUUID());
          }
          delete event.error;
        }
        this.touch(event);
      });
      if (command.action === 'delete') {
        this.eventWork.get(command.eventId)?.abort();
        this.eventWork.delete(command.eventId);
      }
      deletedRun?.abort();
      if (command.action === 'pause' && this.store.peek().active?.eventId === command.eventId) this.controller?.abort();
    }
    this.kick(); return this.snapshot();
  }
  private async submit(input: FriendInput, delivery?: Delivery) {
    if (this.closed) throw Error('FRIENDS_CLOSED');
    if (!this.configured) throw Error('FRIENDS_NOT_CONFIGURED');
    const receipt = await this.store.change(state => {
      const evidence = { ...input, ...(delivery?.fromAssistant ? { authoredBy: 'assistant' as const,
        ...(delivery.sourceMessageId ? { sourceMessageId: delivery.sourceMessageId } : {}) } : {}) };
      const previous = state.events.find(event => event.inputs.some(item => item.id === input.id));
      const duplicate = previous?.inputs.find(item => item.id === input.id);
      if (previous && duplicate) {
        if (JSON.stringify(duplicate) !== JSON.stringify(evidence)) throw Error('FRIENDS_INPUT_ID_CONFLICT');
        return { eventId: previous.id, status: 'accepted', ...this.scheduleReceipt(state, previous) };
      }
      const route = delivery?.route ?? state.configuration?.defaultRoute;
      const topic = delivery?.subscriptionTopic;
      if (topic) {
        const existing = state.events.find(event => event.subscription && event.title === topic && event.status !== 'completed' &&
          (route ? this.matchesRoute(event, route) : !event.deliveryRoute));
        if (existing) return { eventId: existing.id, status: 'exists', eventStatus: existing.status, ...this.scheduleReceipt(state, existing) };
      }
      if (delivery?.at && Date.parse(delivery.at) <= this.clock()) throw Error('FRIENDS_INPUT_INVALID');
      if (state.signals.length >= 100) throw Error('FRIENDS_QUEUE_FULL');
      let event = input.relatesTo ? state.events.find(event => event.id === input.relatesTo || event.inputs.some(item => item.id === input.relatesTo)) : undefined;
      if (input.relatesTo && (!event || (delivery?.route && !this.matchesRoute(event, delivery.route)))) throw Error('FRIENDS_EVENT_NOT_FOUND');
      if (!event) {
        if (state.events.some(item => item.id === input.id)) throw Error('FRIENDS_INPUT_ID_CONFLICT');
        this.capacity(state);
        event = this.newEvent(topic ?? input.id, topic ?? input.text.slice(0, 160), input.text, delivery?.fromAssistant ? 'agent' : 'user', input.id);
        if (topic) event.subscription = true;
        state.events.push(event);
      }
      if (event.inputs.length >= 100) throw Error('FRIENDS_EVENT_INPUT_LIMIT');
      if (!input.relatesTo && route) event.deliveryRoute = route;
      event.inputs.push(evidence); event.archived = false;
      if (delivery?.recurrence) {
        if (state.active?.eventId === event.id) throw Error('This event is executing. Retry the schedule change after it finishes.');
        this.registerRecurrence(event, delivery.recurrence);
        this.clearClock(state, event.id);
        if (event.status !== 'paused' && event.status !== 'failed') {
          this.armRecurrence(state, event.id, delivery.recurrence, this.clock() - 1);
          event.status = state.signals.some(signal => signal.eventId === event.id) ? 'queued' : 'watching';
        }
        this.touch(event);
        return { eventId: event.id, status: 'accepted', ...this.scheduleReceipt(state, event) };
      }
      delete event.error;
      if (event.status !== 'running') event.status = 'queued';
      this.touch(event);
      if (delivery?.at) {
        event.status = 'watching';
        state.detections.push({ id: `detection-${randomUUID()}`, eventId: event.id, at: delivery.at });
      } else this.enqueue(state, event.id, 'input', input.id);
      return { eventId: event.id, status: 'accepted' };
    });
    this.kick(); return receipt;
  }
  async snapshot(): Promise<FriendsSnapshot> {
    const state = await this.store.read();
    const workspaceDir = state.configuration?.parent.metadata.workspaceDir;
    return { configured: this.configured, events: state.events, detections: state.detections,
      ...(typeof workspaceDir === 'string' ? { workspaceDir } : {}),
      ...(state.active ? { active: { eventId: state.active.eventId, turnId: state.active.turnId } } : {}),
      ...(this.deps.interactions?.() ?? emptyInteractions()) };
  }
  private capacity(state: FriendsState) { if (state.events.length >= 1000) throw Error('FRIENDS_EVENT_LIMIT'); }
  private newEvent(logicalKey: string, title: string, intent: string, origin: FriendsWorkEvent['origin'], id = `friend-event-${randomUUID()}`): FriendsWorkEvent {
    const at = new Date(this.clock()).toISOString();
    return { id, logicalKey, title, intent, origin, inputs: [], status: 'queued', archived: false, revision: 1, createdAt: at, updatedAt: at };
  }
  private touch(event: FriendsWorkEvent) { event.revision++; event.updatedAt = new Date(this.clock()).toISOString(); }
  private event(state: FriendsState, id: string) {
    const event = state.events.find(event => event.id === id);
    if (!event) throw Error('FRIENDS_EVENT_NOT_FOUND');
    return event;
  }
  private pause(state: FriendsState, event: FriendsWorkEvent) {
    event.status = 'paused';
    if (event.recurrence) this.clearClock(state, event.id);
    settleFriendsWebhook(state, state.signals.filter(s => s.eventId === event.id).map(s => s.id),
      { status: 'interrupted', reply: '', errorCode: 'friends_paused' });
  }
  private clearClock(state: FriendsState, eventId: string) {
    state.detections = state.detections.filter(timer => timer.eventId !== eventId);
    state.signals = state.signals.filter(signal => signal.eventId !== eventId || signal.kind !== 'clock');
  }
  private registerRecurrence(event: FriendsWorkEvent, rule: EventRecurrence) {
    // Validate the interval as well as the first instant before saving the rule,
    // even when registration edits a paused subscription.
    const first = nextEventOccurrence(rule, this.clock() - 1);
    nextEventOccurrence(rule, Date.parse(first));
    event.subscription = true;
    event.recurrence = rule;
  }
  private armRecurrence(state: FriendsState, eventId: string, rule: EventRecurrence, after = this.clock()) {
    const at = nextEventOccurrence(rule, after);
    const current = state.detections.find(timer => timer.eventId === eventId);
    if (current?.at === at) return current;
    const detection = { id: `detection-${randomUUID()}`, eventId, at };
    state.detections = state.detections.filter(timer => timer.eventId !== eventId);
    state.detections.push(detection);
    return detection;
  }
  private scheduleReceipt(state: FriendsState, event: FriendsWorkEvent) {
    if (!event.recurrence) return {};
    return { recurrence: event.recurrence, nextAt: state.detections.find(timer => timer.eventId === event.id)?.at ?? null };
  }
  private relatedEvents(state: FriendsState) {
    const route = state.events.find(event => event.id === state.active?.eventId)?.deliveryRoute;
    return route ? state.events.filter(event => route.recipientKey ? event.deliveryRoute?.recipientKey === route.recipientKey
      : event.deliveryRoute?.sourceRef === route.sourceRef) : state.events;
  }
  private relatedEvent(state: FriendsState, id: string) {
    const event = this.relatedEvents(state).find(item => item.id === id);
    if (!event) throw Error('FRIENDS_EVENT_NOT_FOUND');
    return event;
  }
  private enqueue(state: FriendsState, eventId: string, kind: FriendsState['signals'][number]['kind'], id: string) {
    const signalId = `${kind}:${id}`;
    if (!state.signals.some(signal => signal.id === signalId)) state.signals.push({ id: signalId, eventId, kind, createdAt: new Date(this.clock()).toISOString() });
  }
  private kick() {
    this.scheduler.cancel(this.wake);
    if (this.closed || !this.configured || this.execution) return;
    this.execution = this.dispatch().catch(error => { this.configured = false; this.deps.onError?.(error); }).finally(() => {
      this.execution = undefined;
      if (this.closed || !this.configured) return;
      const state = this.store.peek();
      const runnable = state.signals.some(signal => !['paused', 'failed'].includes(this.event(state, signal.eventId).status));
      const due = state.detections.filter(d => !['paused', 'failed'].includes(this.event(state, d.eventId).status)).map(d => Date.parse(d.at));
      if (state.notifications?.length && this.deps.publish) due.push(this.clock() + 30_000);
      if (!runnable && !due.length) return;
      const delay = runnable ? 10 : Math.min(2_147_483_647, Math.max(10, Math.min(...due) - this.clock()));
      this.scheduler.schedule(this.wake, delay);
    });
  }
  private async dispatch() {
    await this.store.change(state => {
      const now = this.clock();
      const due = state.detections.filter(d => Date.parse(d.at) <= now && !['paused', 'failed'].includes(this.event(state, d.eventId).status));
      state.detections = state.detections.filter(d => !due.includes(d));
      for (const detection of due) {
        const event = this.event(state, detection.eventId);
        if (!state.signals.some(signal => signal.eventId === event.id && signal.kind === 'clock')) {
          this.enqueue(state, event.id, 'clock', detection.id);
        }
        event.status = 'queued';
        if (event.recurrence) {
          try { this.armRecurrence(state, event.id, event.recurrence, now); }
          catch (error) {
            // A rule at the calendar limit must not strand other due events.
            if (!(error instanceof RangeError)) throw error;
            this.clearClock(state, event.id);
            event.status = 'failed';
            event.error = 'FRIENDS_RECURRENCE_OUT_OF_RANGE';
            this.touch(event);
          }
        }
      }
    });
    if (this.closed || !this.configured) return;
    const activation = await this.store.change(state => {
      const first = state.signals.find(signal => !['paused', 'failed'].includes(this.event(state, signal.eventId).status));
      if (!first || !state.configuration) return;
      const event = this.event(state, first.eventId), signals = state.signals.filter(signal => signal.eventId === event.id);
      const turnId = `friends-${randomUUID()}`;
      state.active = { eventId: event.id, turnId, signalIds: signals.map(signal => signal.id) };
      event.status = 'running'; this.touch(event);
      this.activationEventIds = new Set(state.events.map(item => item.id));
      this.automaticActivation = !signals.some(signal => signal.kind === 'input' || signal.kind === 'resume');
      const inbound = signals.some(signal => signal.kind === 'input' && state.webhookReceipts?.[signal.id.slice(6)]?.status === 'pending');
      return { event, signals, turnId, inbound, configuration: state.configuration,
        detections: state.detections.filter(d => d.eventId === event.id) };
    });
    if (!activation) { await this.publishNotifications(); return; }
    if (this.store.select(state => state.active?.turnId) !== activation.turnId) return;
    const controller = this.controller = new AbortController(); this.stagedDecision = undefined;
    const { profile } = activation.configuration;
    const sourceRef = activation.event.deliveryRoute?.sourceRef;
    const parent = activation.inbound ? applyWebhookTurnPolicy(activation.configuration.parent) : activation.configuration.parent;
    const { botSourceRef: _ref, botSourceRefs: _refs, ...metadata } = parent.metadata;
    const request: ModelRequest = { protocol: 'bush.model_request.v1', requestId: `request-${randomUUID()}`,
      sessionId: FRIENDS_SESSION, turnId: activation.turnId, model: parent.model, providerBinding: parent.providerBinding,
      reasoningEffort: parent.reasoningEffort, maxOutputTokens: parent.maxOutputTokens, permissionMode: parent.permissionMode,
      requestCapabilities: parent.requestCapabilities,
      metadata: { ...metadata, ...(activation.configuration.assistant ? { parentSessionId: PERSONAL_ASSISTANT_SESSION } : {}),
        environmentContext: true, friendsEventId: activation.event.id, friendsExecution: true,
        ...(sourceRef ? activation.inbound ? { botSourceRef: sourceRef } : { botSourceRefs: [sourceRef] } : { botRequiresSingleRecipient: true }) },
      tools: this.definitions(parent), messages: [...parent.prefixMessages,
        { role: 'developer', content: renderPromptTemplate('friends-system') },
        { role: 'developer', content: renderPromptTemplate('friends-bridge-delivery') },
        { role: 'developer', name: 'friends_event_data', content: JSON.stringify({
          classification: 'event_evidence_not_conversation', inboundWebhook: activation.inbound, profile,
          persona: activation.configuration.assistant?.persona, event: activation.event, signals: activation.signals,
          detections: activation.detections, clock: { utc: new Date(this.clock()).toISOString(), timeZone: profile.timeZone },
        }) }],
    };
    try {
      const result = await this.deps.run(request, controller.signal);
      if (controller.signal.aborted) throw Error('FRIENDS_PAUSED');
      if (result.terminal.kind !== 'turn_terminal' || result.terminal.payload.status !== 'completed') throw Error('FRIENDS_EXECUTION_INCOMPLETE');
      const decision = this.stagedDecision as z.infer<typeof decisionSchema> | undefined;
      if (!decision || !result.text.trim()) throw Error('FRIENDS_RESULT_INCOMPLETE');
      await this.store.change(state => {
        if (state.active?.turnId !== activation.turnId) return;
        const event = this.event(state, activation.event.id);
        if (event.status === 'paused') return;
        state.signals = state.signals.filter(signal => !activation.signals.some(consumed => consumed.id === signal.id));
        event.decision = decision;
        event.result = { text: result.text, turnId: activation.turnId, createdAt: new Date(this.clock()).toISOString() };
        settleFriendsWebhook(state, activation.signals.map(s => s.id), { status: 'completed', reply: result.text });
        event.status = state.signals.some(signal => signal.eventId === event.id) ? 'queued' : decision.disposition;
        if (decision.disposition !== 'watching') state.detections = state.detections.filter(detection => detection.eventId !== event.id);
        else if (event.recurrence && !state.detections.some(timer => timer.eventId === event.id && Date.parse(timer.at) > this.clock())) {
          this.armRecurrence(state, event.id, event.recurrence);
        }
        delete event.error; delete event.interruptedTurnId; delete state.active; this.touch(event);
        if (activation.configuration.assistant && !activation.inbound &&
          (decision.disposition === 'waiting_user' || profile.interactionPreferences?.report === 'always' || decision.notifyUser)) {
          (state.notifications ??= []).push({ eventId: event.id, ...event.result });
        }
      });
    } catch (error) {
      await this.store.change(state => {
        if (state.active?.turnId !== activation.turnId) return;
        const event = this.event(state, activation.event.id);
        event.status = controller.signal.aborted || this.closed ? 'paused' : 'failed';
        if (event.recurrence) this.clearClock(state, event.id);
        event.error = error instanceof Error ? error.message : 'FRIENDS_EXECUTION_FAILED';
        settleFriendsWebhook(state, activation.signals.map(s => s.id), { status: event.status === 'paused' ? 'interrupted' : 'failed', reply: '', errorCode: 'friends_execution_incomplete' });
        event.interruptedTurnId = activation.turnId;
        // Keep evidence, but require explicit retry after uncertain execution.
        state.signals = state.signals.filter(signal => !activation.signals.some(consumed => consumed.id === signal.id));
        delete state.active; this.touch(event);
      });
    } finally { if (this.controller === controller) this.controller = undefined; this.stagedDecision = undefined; }
    await this.publishNotifications();
  }
  private async publishNotifications() {
    if (!this.deps.publish || !this.store.select(state => state.notifications?.length)) return;
    try {
      await this.store.change(state => {
        for (const notice of state.notifications ?? []) this.deps.publish!(notice);
        delete state.notifications;
      });
    } catch (error) { this.deps.onError?.(error); }
  }
  private definitions(parent: RuntimeSessionTurnRequest): ToolDefinition[] {
    return [...parent.tools.filter(tool => !tool.name.startsWith('friends_')).map(presentExistingScheduleActions),
      ...this.deps.tools.definitions().filter(tool => tool.name.startsWith('friends_'))];
  }
  private async resolveRoute(ref: string) {
    const source = (await this.deps.botContext?.(ref))?.source;
    if (source?.sourceRef !== ref) return;
    if (!source.senderId || !source.conversationId) return { sourceRef: ref };
    const recipientKey = createHash('sha256').update(JSON.stringify([source.connectionId, source.senderId, source.conversationId])).digest('hex');
    return { sourceRef: ref, recipientKey };
  }
  /** Detached children can outlive one activation, but never their owning event. */
  workSignal(request?: ModelRequest) {
    if (request?.sessionId !== FRIENDS_SESSION || request.metadata.friendsExecution !== true) return;
    const id = request.metadata.friendsEventId;
    if (typeof id !== 'string' || !this.store.select(state => state.events.some(event => event.id === id))) return AbortSignal.abort();
    let owner = this.eventWork.get(id);
    if (!owner) { owner = new AbortController(); this.eventWork.set(id, owner); }
    return owner.signal;
  }
  private matchesRoute(event: FriendsWorkEvent, route: NonNullable<FriendsWorkEvent['deliveryRoute']>) {
    return event.deliveryRoute?.sourceRef === route.sourceRef || Boolean(route.recipientKey && event.deliveryRoute?.recipientKey === route.recipientKey);
  }
  private registerAssistantTool() {
    const schema = z.object({ action: z.enum(['list', 'read', 'create', 'subscribe', 'continue', 'pause', 'resume', 'delete']),
      topic: z.string().trim().min(1).max(160).optional(), include_archived: z.boolean().optional(), eventId: z.string().min(1).optional(), text: z.string().trim().min(1).max(8000).optional(),
      at: z.string().datetime({ offset: true }).optional(),
      recurrence: eventRecurrenceSchema.optional().describe('Fixed cadence for subscribe, or an explicitly requested schedule change with continue. Use instead of at. Runtime calculates each due time.'),
      source_ref: z.string().min(1).max(100).optional() }).strict().refine(input =>
        !input.recurrence || (!input.at && ['subscribe', 'continue'].includes(input.action)), 'Use recurrence with subscribe or continue, without at.');
    this.deps.tools.register({
      definition: { name: 'assistant_event', description: 'Manage the personal assistant’s durable proactive events. Use create for one outcome. Use subscribe for ongoing informational updates: provide a stable short topic, a self-contained text describing what to report across updates, and optionally at for the first check. Reuse the same subscription on its delivery route. Continue, read, pause, resume or permanently delete by eventId. Pause a temporary stop. Delete only on an explicit user request for one identifiable event. Ask which event if ambiguous. List with include_archived to locate archived events. Events use their own evidence. Notification routing inherits the current message, or an explicitly selected verified source_ref for a local request.', inputSchema: z.toJSONSchema(schema) },
      manifest: { effect_kind: 'mutation', operation: 'assistant.event', risk: 'low', owner: 'runtime', dispatch_scope: 'session', mutating: true },
      modelAvailable: request => request.sessionId === PERSONAL_ASSISTANT_SESSION && request.metadata.agentRole !== 'child',
      decodeInput: value => schema.parse(value),
      execute: async ({ input, turn, sessionId, toolCall }) => {
        if (sessionId !== PERSONAL_ASSISTANT_SESSION || !turn) throw Error('FRIENDS_IDENTITY_REQUIRED');
        const meta = turn.request.metadata;
        const refs = typeof meta.botSourceRef === 'string' ? [meta.botSourceRef] :
          Array.isArray(meta.botSourceRefs) ? meta.botSourceRefs.filter((r): r is string => typeof r === 'string') : [];
        if (refs.length > 1 && !input.source_ref) throw Error('bridge_source_ambiguous');
        if (refs.length && input.source_ref && !refs.includes(input.source_ref)) throw Error('bridge_source_mismatch');
        const ref = input.source_ref ?? refs[0];
        const route = ref ? await this.resolveRoute(ref) : undefined;
        if (ref && !route) throw Error('bridge_source_unavailable');
        const snapshot = await this.store.read();
        const events = snapshot.events.filter(event => !refs.length || (route && this.matchesRoute(event, route)));
        if (input.action === 'list') return events.filter(event => input.include_archived || !event.archived).slice(-100).map(({ id, title, status, archived, subscription }) => ({ id, title, status, ...(subscription ? { subscription } : {}), ...(archived ? { archived } : {}) }));
        const event = events.find(item => item.id === input.eventId);
        const creating = input.action === 'create' || input.action === 'subscribe';
        if (!creating && !event) throw Error('FRIENDS_EVENT_NOT_FOUND');
        if (input.action === 'read' && event) return { ...event, ...this.scheduleReceipt(snapshot, event) };
        if (creating || input.action === 'continue') {
          if (!input.text || (input.action === 'subscribe' && !input.topic) || (input.at && !creating)) throw Error('FRIENDS_INPUT_INVALID');
          const id = 'event-' + createHash('sha256').update(JSON.stringify([turn.request.turnId, toolCall.id])).digest('hex');
          const previous = events.flatMap(item => item.inputs).find(item => item.id === id);
          const inputs = Array.isArray(meta.assistantEventEvidence) ? meta.assistantEventEvidence : [];
          if (meta.assistantUserRequest === false && !inputs.length) throw Error('ASSISTANT_EVENT_ORIGIN_REQUIRED');
          const source = inputs.filter(item => item && item.sourceRef === ref).at(-1);
          return this.submit({ id, text: input.text, createdAt: previous?.createdAt ?? new Date(this.clock()).toISOString(),
            ...(input.action === 'continue' ? { relatesTo: event!.id } : {}) }, { route, at: input.at && new Date(input.at).toISOString(),
            recurrence: input.recurrence, fromAssistant: true, sourceMessageId: source?.id, subscriptionTopic: input.action === 'subscribe' ? input.topic : undefined });
        }
        if (input.action === 'delete') {
          if (meta.assistantUserRequest !== true) throw Error('ASSISTANT_EVENT_USER_REQUEST_REQUIRED');
          await this.command({ action: 'delete', eventId: event!.id }, { route });
          return { eventId: event!.id, status: 'deleted' };
        }
        await this.command({ action: input.action, eventId: event!.id });
        return { eventId: event!.id, status: 'accepted' };
      },
    });
  }
  private changeFromTurn<T>(turnId: string, change: (state: FriendsState) => T) {
    return this.store.change(state => {
      if (state.active?.turnId !== turnId) throw Error('FRIENDS_ACTIVE_EXECUTION_REQUIRED');
      return change(state);
    });
  }
  private registerTools() {
    const register = <Schema extends z.ZodType>(name: string, description: string, schema: Schema, execute: (input: z.infer<Schema>, turnId: string) => Promise<unknown>, mutating = true) => this.deps.tools.register({
      definition: { name, description, inputSchema: z.toJSONSchema(schema) },
      manifest: { effect_kind: mutating ? 'mutation' : 'observation', operation: name, risk: 'low', owner: 'friends', dispatch_scope: 'turn', mutating },
      modelAvailable: request => request.sessionId === FRIENDS_SESSION && request.metadata.friendsExecution === true,
      decodeInput: input => schema.parse(input),
      execute: context => {
        if (this.closed || context.sessionId !== FRIENDS_SESSION || context.turnId !== this.store.select(state => state.active?.turnId)) throw Error('FRIENDS_ACTIVE_EXECUTION_REQUIRED');
        return execute(context.input, context.turnId);
      },
    });
    register('friends_read_events', 'Read one explicitly related event by eventId, or list a bounded page of event titles and states with an empty eventId. This is state, not conversation history. Do not scan unrelated events.',
      z.object({ eventId: z.string(), offset: z.number().int().min(0) }).strict(), async input => {
        const state = await this.store.read();
        if (input.eventId) return { event: this.relatedEvent(state, input.eventId), detections: state.detections.filter(d => d.eventId === input.eventId) };
        const events = [...this.relatedEvents(state)].reverse();
        return { items: events.slice(input.offset, input.offset + 20).map(({ id, title, status, updatedAt }) => ({ id, title, status, updatedAt })),
          nextOffset: input.offset + 20 < events.length ? input.offset + 20 : null };
      }, false);
    register('friends_pause_event', 'Pause future execution of a specific event. Keeps its original evidence and results. Does not delete history or grant permissions.',
      z.object({ eventId: z.string().min(1) }).strict(), async (input, turnId) => this.changeFromTurn(turnId, state => {
        if (state.active?.eventId === input.eventId) throw Error('FRIENDS_USE_DECISION_FOR_CURRENT_EVENT');
        const event = this.relatedEvent(state, input.eventId); this.pause(state, event); this.touch(event);
        return { status: 'paused', eventId: event.id };
      }));
    register('friends_create_event', 'Create a separate durable event grounded in confirmed recognition, user instructions, applicable habits or verified feedback. Habits are optional. Set subscription=true when the same event should keep reporting future developments. Use a stable logicalKey for idempotency. Automatic activations can create at most one new event; creation grants no execution permission.', createSchema, async (input, turnId) => this.changeFromTurn(turnId, state => {
      const route = this.event(state, state.active!.eventId).deliveryRoute;
      const preferredRef = route?.sourceRef ?? state.configuration?.assistant?.proactive?.notificationSourceRef;
      const old = this.relatedEvents(state).find(event => event.logicalKey === input.logicalKey &&
        (route?.recipientKey ? event.deliveryRoute?.recipientKey === route.recipientKey : event.deliveryRoute?.sourceRef === preferredRef));
      if (old) return { status: 'exists', event: old };
      if (this.automaticActivation && state.events.some(event => event.origin === 'agent' && !this.activationEventIds.has(event.id))) throw Error('FRIENDS_DISCOVERY_EVENT_LIMIT');
      this.capacity(state);
      const event = this.newEvent(input.logicalKey, input.title, input.intent, 'agent');
      if (input.subscription) event.subscription = true;
      const delivery = route ?? state.configuration?.defaultRoute;
      if (delivery) event.deliveryRoute = { ...delivery };
      // Creation alone does not execute work. A detector or an explicit resume wakes it.
      event.status = 'paused'; state.events.push(event); return { status: 'created', event };
    }));
    register('friends_watch_time', 'Register a structured recurrence for a fixed cadence or an absolute ISO time (at) for an adaptive check. Fixed schedules renew locally. Waiting uses no model requests.', watchSchema, async (input, turnId) => this.changeFromTurn(turnId, state => {
      const event = this.relatedEvent(state, input.eventId);
      if (input.recurrence) {
        if (event.recurrence && this.automaticActivation) throw Error('The fixed recurrence is already managed locally. Use watching for this delivery.');
        this.registerRecurrence(event, input.recurrence);
        const detection = this.armRecurrence(state, event.id, input.recurrence);
        if (state.active?.eventId !== event.id) event.status = 'watching';
        this.touch(event);
        return { status: 'registered', detection, recurrence: event.recurrence };
      }
      if (event.recurrence) throw Error('A local recurrence owns the next check. Use watching for this delivery.');
      if (!input.at) throw Error('FRIENDS_FUTURE_TIME_REQUIRED');
      if (Date.parse(input.at) <= this.clock()) throw Error('FRIENDS_FUTURE_TIME_REQUIRED');
      const old = state.detections.find(d => d.eventId === event.id);
      if (old?.at === new Date(input.at).toISOString()) {
        if (state.active?.eventId !== event.id && event.status !== 'watching') { event.status = 'watching'; this.touch(event); }
        return { status: 'exists', detection: old };
      }
      const detection = { id: `detection-${randomUUID()}`, eventId: event.id, at: new Date(input.at).toISOString() };
      state.detections = [...state.detections.filter(d => d.eventId !== event.id), detection];
      if (state.active?.eventId !== event.id) event.status = 'watching';
      this.touch(event); return { status: 'registered', detection };
    }));
    register('friends_decide', 'Record the current event disposition and a short factual basis, not private reasoning. habitRefs may be empty when no applicable habit exists. For subscriptions, use watching after each delivery. To complete one, set endSubscription only when its ongoing scope has ended. This does not publish a result or bypass tool permissions.', decisionSchema, async (input, turnId) => {
      const state = await this.store.read();
      if (state.active?.turnId !== turnId) throw Error('FRIENDS_ACTIVE_EXECUTION_REQUIRED');
      const event = this.event(state, state.active.eventId);
      if (input.disposition === 'watching' && !event.recurrence && !state.detections.some(d => d.eventId === event.id)) throw Error('FRIENDS_WATCH_REQUIRES_DETECTION');
      if (input.disposition === 'completed' && event.subscription && !event.recurrence && !input.endSubscription)
        throw Error('Subscription remains active. Schedule its next check and decide watching, or set endSubscription when the topic itself has ended.');
      const { endSubscription: _ended, ...decision } = input;
      const disposition = event.recurrence && input.disposition === 'completed' && !input.endSubscription ? 'watching' : input.disposition;
      this.stagedDecision = { ...decision, disposition }; return { status: 'recorded', delivery: 'awaiting_runtime_completion' };
    });
  }
  async disconnect() {
    this.configured = false; this.scheduler.cancel(this.wake); this.controller?.abort();
    for (const owner of this.eventWork.values()) owner.abort();
    this.eventWork.clear();
    await this.execution;
  }
  async close() { this.closed = true; await this.disconnect(); }
}
