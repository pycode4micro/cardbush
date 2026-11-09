import { createHash } from 'node:crypto';
import type { AutomationDefinition, AutomationJob, AutomationOverview, EventRecurrence, FriendsWorkEvent } from '@cardbush/bush-protocol';
import type { AutomationScheduler } from './automationScheduler.js';
import { nextEventOccurrence } from './eventRecurrence.js';

// A conversation event has one durable record. The scheduler already owns its
// session snapshot, execution history and trusted plugin wakeups.
const prefix = 'session-event:';
export const conversationJobId = (id?: string) => id?.startsWith(prefix) ? id.slice(prefix.length) : undefined;
type SessionHook = Extract<AutomationDefinition['trigger'], { kind: 'event' }>;
type EventInput = {
  action: string; eventId?: string; text?: string; topic?: string; at?: string; recurrence?: EventRecurrence;
  session_hook?: Omit<SessionHook, 'kind'>; include_archived?: boolean; destination?: 'here' | 'external';
  source_ref?: string; reminderText?: string | null; presentation?: unknown; trigger?: unknown;
};

export function conversationEvent(job: AutomationJob, sourceTitle?: string): FriendsWorkEvent {
  const last = job.runs.at(-1);
  const status = last?.status === 'running' || last?.status === 'queued' ? last.status
    : job.state === 'paused' ? (last?.status === 'awaiting_user_action' ? 'waiting_user' : 'paused')
    : job.state === 'completed' ? 'completed' : 'watching';
  return {
    id: prefix + job.id, logicalKey: job.registrationKey ?? job.id, origin: job.plugin ? 'system' : 'user',
    title: job.name, intent: job.prompt, status, archived: job.archived ?? false, revision: job.revision,
    createdAt: job.createdAt, updatedAt: last?.finishedAt ?? last?.queuedAt ?? job.createdAt, inputs: [],
    ...(job.trigger.kind !== 'once' ? { subscription: true } : {}),
    ...(job.trigger.kind === 'recurrence' ? { recurrence: job.trigger.rule } : {}),
    ...(last?.summary ? { result: { text: last.summary, turnId: last.turnId, createdAt: last.finishedAt ?? last.queuedAt } } : {}),
    conversationExecution: { jobId: job.id, sessionId: job.sessionId, sourceTitle, pluginId: job.plugin?.id,
      runs: job.runs.map(run => ({ id: run.id, at: run.finishedAt ?? run.queuedAt, status: run.status, summary: run.summary })) },
  };
}

export function conversationEventSnapshot(overview: AutomationOverview) {
  const titles = new Map(overview.sessions.map(session => [session.id, session.title]));
  return { events: overview.jobs.map(job => conversationEvent(job, titles.get(job.sessionId))),
    detections: overview.jobs.flatMap(job => job.nextRunAt && job.state === 'active' ? [{ id: job.id, eventId: prefix + job.id, at: job.nextRunAt }] : []) };
}

function registrationReceipt(job: AutomationJob) {
  return { eventId: prefix + job.id, status: 'accepted', nextAt: job.nextRunAt ?? null,
    ...(job.trigger.kind === 'recurrence' ? { recurrence: job.trigger.rule } : {}) };
}

export async function manageConversationEvent(scheduler: AutomationScheduler, sessionId: string, input: EventInput, callId: string, now: number) {
  if (input.source_ref || input.destination === 'external' || input.trigger || input.presentation || input.reminderText != null)
    throw Error('Conversation events execute in their source project. Use at, recurrence or session_hook and put the complete task in text.');
  const overview = await scheduler.list(sessionId);
  if (input.action === 'list') return overview.jobs.filter(job => input.include_archived || !job.archived).map(job => {
    const event = conversationEvent(job);
    return { id: event.id, title: event.title, status: event.status, subscription: event.subscription, archived: event.archived };
  });
  const creating = input.action === 'create' || input.action === 'subscribe';
  const job = creating ? undefined : overview.jobs.find(item => item.id === conversationJobId(input.eventId));
  if (!creating) {
    if (!job) throw Error('Event not found in this conversation.');
    if (input.action === 'read') return { ...conversationEvent(job), nextAt: job.nextRunAt ?? null };
    if (input.action !== 'continue') {
      await scheduler.manage({ action: input.action, id: job.id }, sessionId, { cancelOnDelete: true });
      return { eventId: input.eventId, status: input.action === 'delete' ? 'deleted' : 'accepted' };
    }
  }
  if (job?.plugin) throw Error('The plugin owns this hook definition.');
  if (!input.text || input.action === 'subscribe' && !input.topic) throw Error('Provide text and a stable topic for a subscription.');
  const subscription = input.action === 'subscribe';
  const key = (subscription ? 'topic:' : 'call:') + createHash('sha256').update(subscription ? input.topic! : callId).digest('hex');
  // A retry can arrive after a one-time event has fired. Its receipt still
  // belongs to the original call, even though its due time is now in the past.
  const previous = creating && overview.jobs.find(item => item.registrationKey === key && (!subscription || !item.archived && item.state !== 'completed'));
  if (previous) return registrationReceipt(previous);
  let trigger = job?.trigger;
  if (input.recurrence) {
    const at = nextEventOccurrence(input.recurrence, now - 1);
    nextEventOccurrence(input.recurrence, Date.parse(at));
    trigger = { kind: 'recurrence', rule: input.recurrence, at };
  } else if (input.session_hook) {
    if (input.action === 'create') throw Error('Use subscribe for a recurring conversation hook.');
    trigger = { ...input.session_hook, kind: 'event' };
  } else if (input.at) {
    if (Date.parse(input.at) <= now || input.action === 'subscribe') throw Error('Use a future at for create, or a recurrence for subscribe.');
    trigger = { kind: 'once', at: input.at };
  }
  if (!trigger) throw Error('Specify at, recurrence or session_hook for a conversation event.');
  const definition = { name: (input.topic ?? job?.name ?? input.text).slice(0, 120), prompt: input.text, sessionId, trigger,
    timeZone: input.recurrence?.timeZone ?? job?.timeZone ?? 'UTC', executionMode: job?.executionMode ?? (trigger.kind === 'event' ? 'conversation' : 'isolated') };
  const saved = await scheduler.manage({ action: creating ? 'create' : 'update', definition, id: job?.id,
    expectedRevision: creating ? undefined : job?.revision }, sessionId, creating ? { registrationKey: key } : { editKey: 'edit:' + key }) as AutomationJob;
  return registrationReceipt(saved);
}
