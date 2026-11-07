import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { friendEvidenceSchema, friendDeliveryRouteSchema, friendsWebhookReceiptSchema, type FriendsWebhookReceipt, friendsProfileSchema, runtimeSessionTurnRequestSchema,
  type FriendsDetection, type FriendsProfile, type FriendsWorkEvent, type RuntimeSessionTurnRequest } from '@cardbush/bush-protocol';

const timestamp = z.string().datetime();
const id = z.string().min(1);
const stateSchema = z.object({
  version: z.literal(1),
  discoveryStarted: z.literal(true).optional(),
  configuration: z.object({ parent: runtimeSessionTurnRequestSchema.extend({ inputMessages: z.tuple([]) }), profile: friendsProfileSchema }).optional(),
  events: z.array(z.object({ id, logicalKey: id, origin: z.enum(['user', 'agent', 'system']), title: z.string(), intent: z.string(),
    inputs: z.array(friendEvidenceSchema), deliveryRoute: friendDeliveryRouteSchema.optional(), status: z.enum(['queued', 'running', 'watching', 'waiting_user', 'completed', 'paused', 'failed']),
    archived: z.boolean(), revision: z.number().int().positive(), createdAt: timestamp, updatedAt: timestamp,
    result: z.object({ text: z.string(), turnId: id, createdAt: timestamp }).optional(),
    decision: z.object({ disposition: z.enum(['completed', 'watching', 'waiting_user']), basis: z.string(),
      habitRefs: z.array(z.object({ id, revision: z.number().int().positive() })) }).optional(),
    error: z.string().optional(), interruptedTurnId: id.optional(),
  })),
  detections: z.array(z.object({ id, eventId: id, at: timestamp })),
  webhookReceipts: z.record(id, friendsWebhookReceiptSchema).optional(),
  signals: z.array(z.object({ id, eventId: id, kind: z.enum(['input', 'clock', 'startup', 'resume']), createdAt: timestamp })),
  active: z.object({ eventId: id, turnId: id, signalIds: z.array(id) }).optional(),
});

export interface FriendsState {
  version: 1;
  discoveryStarted?: true;
  configuration?: { parent: RuntimeSessionTurnRequest; profile: FriendsProfile };
  events: FriendsWorkEvent[];
  webhookReceipts?: Record<string, FriendsWebhookReceipt>;
  detections: FriendsDetection[];
  signals: Array<{ id: string; eventId: string; kind: 'input' | 'clock' | 'startup' | 'resume'; createdAt: string }>;
  active?: { eventId: string; turnId: string; signalIds: string[] };
}

/** One durable owner; rendering and environment observation never write state. */
export class FriendsStore {
  private value: FriendsState = { version: 1, events: [], detections: [], signals: [] };
  private queue: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;
  constructor(private path: string) {
    this.ready = this.load();
    void this.ready.catch(() => {});
  }
  private async load() {
    try {
      const parsed = stateSchema.safeParse(JSON.parse(await readFile(this.path, 'utf8')));
      if (!parsed.success) throw Error('FRIENDS_STATE_INVALID');
      const value = parsed.data, ids = new Set(value.events.map(event => event.id));
      if (ids.size !== value.events.length || [...value.detections, ...value.signals, ...(value.active ? [value.active] : [])].some(item => !ids.has(item.eventId))) throw Error('FRIENDS_STATE_INVALID');
      this.value = value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (this.value.active) {
      settleFriendsWebhook(this.value, this.value.active.signalIds, { status: 'interrupted', reply: '', errorCode: 'runtime_restart_interrupted' });
      const event = this.value.events.find(item => item.id === this.value.active!.eventId);
      if (event) { event.status = 'paused'; event.error = 'runtime_restart_interrupted'; event.interruptedTurnId = this.value.active.turnId; }
      // An interrupted tool may have had a side effect. Resume requires an explicit
      // action and a fresh read of receipts; do not automatically replay it.
      delete this.value.active;
      await this.persist(this.value);
    }
  }
  private async persist(value: FriendsState) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, this.path); }
    finally { await rm(temporary, { force: true }); }
  }
  async read() { await this.ready; await this.queue; return structuredClone(this.value); }
  peek() { return structuredClone(this.value); }
  select<T>(read: (state: Readonly<FriendsState>) => T): T { return structuredClone(read(this.value)); }
  async change<T>(change: (state: FriendsState) => T): Promise<T> {
    await this.ready;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.value), result = change(next);
      if (JSON.stringify(next) !== JSON.stringify(this.value)) { await this.persist(next); this.value = next; }
      return structuredClone(result);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

/** Freeze the reply to an individual inbound message; later event activations must not replace it. */
export function settleFriendsWebhook(state: FriendsState, signals: string[], receipt: FriendsWebhookReceipt) {
  for (const signal of signals) if (signal.startsWith('input:')) {
    const key = signal.slice(6);
    if (state.webhookReceipts?.[key]?.status === 'pending') state.webhookReceipts[key] = receipt;
  }
}
