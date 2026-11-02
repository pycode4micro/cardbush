import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeRuntimeEvent, type RuntimeEvent } from '@cardbush/bush-protocol';
import { uiText } from '@cardbush/platform/i18n';
import type { ChatClient } from './agentLocalChat.mjs';
import { AgentHttpError, AgentIdentityError, AgentNetworkError } from './agentHttpClient.mjs';
import type { AgentJob, AgentSendInput } from './agentTypes.js';
import { botMessageSchema, BotGatewayError, type BotChannel, type BotGatewayConfig, type BotMessage } from './botGatewayConfig.mjs';
import { writePrivateJson } from './atomicJsonFile.mjs';

type Client = Pick<ChatClient, 'info' | 'call' | 'events' | 'reconnect'>;
type Status = 'accepted' | 'running' | 'reconnecting' | 'needs_input' | 'completed' | 'failed' | 'stopped' | 'interrupted';
type Attention = { kind: 'permission' | 'question'; id: string };
type Segment = { messageId: string; text: string; final: boolean };
type Record = {
  version: 1; key: string; agentId: string; channelId: string; fingerprint: string; input: BotMessage;
  request: AgentSendInput; receivedAt: string; order: number; status: Status; sequence: number; cursor: number;
  turnId?: string; segments: { [key: string]: Segment }; finalMessageId?: string; attention?: Attention;
  errorCode?: string; notification?: { sequence: number; body: string; delivered: boolean };
};
export type BotReceipt = {
  protocol: 'cardbush.webhook.v1'; type: 'message.updated'; channelId: string; messageId: string;
  conversationId: string; senderId: string; threadId?: string; sessionId: string; requestId: string;
  status: Status; sequence: number; reply: string; attention?: Attention; errorCode?: string;
};
const terminal = (status: Status) => ['completed', 'failed', 'stopped', 'interrupted'].includes(status);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const recordKey = (channelId: string, messageId: string) => hash([channelId, messageId]);
const { lock } = createRequire(import.meta.url)('proper-lockfile') as {
  lock(path: string, options: object): Promise<() => Promise<void>>;
};

/** Transport adapter only: the existing Cardbush Runtime owns models, plugins,
 * permissions, conversation history and job execution. No platform-specific SDK. */
export class BotGateway {
  readonly #records = new Map<string, Record>();
  readonly #workers = new Map<string, Promise<void>>();
  readonly #deliveries = new Map<string, Promise<void>>();
  readonly #listeners = new Set<(receipt: BotReceipt) => void>();
  readonly #abort = new AbortController();
  #writes: Promise<unknown> = Promise.resolve();
  #release?: () => Promise<void>;
  #agentId = '';
  #modelId = '';
  #nextOrder = 0;
  #broken = false;
  #fail!: (error: Error) => void;
  readonly failure = new Promise<Error>(resolve => { this.#fail = resolve; });
  private constructor(readonly directory: string, readonly config: BotGatewayConfig, readonly client: Client,
    readonly options: { retryMs?: number; fetch?: typeof fetch } = {}) {}

  static async open(directory: string, config: BotGatewayConfig, client: Client, options?: { retryMs?: number; fetch?: typeof fetch }) {
    const gateway = new BotGateway(directory, config, client, options);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      gateway.#release = await lock(directory, { realpath: true, stale: 30_000, update: 5_000, retries: 0,
        onCompromised: () => { gateway.#fatal(); } });
      gateway.#agentId = (await client.info()).id;
      const models = await client.call('product.command', { kind: 'models.get' }) as { defaultModelId: string; models: Array<{ id: string }> };
      gateway.#modelId = config.modelId ?? models.defaultModelId;
      if (!models.models.some(model => model.id === gateway.#modelId)) throw new BotGatewayError('model_not_configured');
      const identityPath = join(directory, 'agent.json');
      const previous = await readFile(identityPath, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return ''; });
      if (previous && JSON.parse(previous).agentId !== gateway.#agentId) throw new BotGatewayError('agent_identity_changed', 409);
      if (!previous) await writeFile(identityPath, JSON.stringify({ agentId: gateway.#agentId }), { flag: 'wx', mode: 0o600 });
      for (const name of (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        const record = JSON.parse(await readFile(join(directory, name), 'utf8')) as Record;
        if (record.version !== 1 || record.agentId !== gateway.#agentId || record.key !== name.slice(0, -5)
          || recordKey(record.channelId, record.input.messageId) !== record.key || !Number.isSafeInteger(record.order) || record.order < 1
          || hash(botMessageSchema.parse(record.input)) !== record.fingerprint) throw new BotGatewayError('invalid_saved_message');
        gateway.#records.set(record.key, record);
        gateway.#nextOrder = Math.max(gateway.#nextOrder, record.order);
      }
      gateway.#pump();
      return gateway;
    } catch (error) { await gateway.close(); throw error; }
  }

  channel(id: string) {
    const channel = this.config.channels.find(channel => channel.id === id);
    if (!channel) throw new BotGatewayError('unknown_channel', 404);
    return channel;
  }
  subscribe(listener: (receipt: BotReceipt) => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  #fatal() { this.#broken = true; this.#abort.abort(); this.#fail(new BotGatewayError('gateway_storage_unavailable', 503)); }
  #receipt(record: Record): BotReceipt {
    const segments = Object.values(record.segments);
    const selected = record.finalMessageId ? segments.filter(segment => segment.messageId === record.finalMessageId)
      : segments.some(segment => segment.final) ? segments.filter(segment => segment.final) : segments;
    return { protocol: 'cardbush.webhook.v1', type: 'message.updated', channelId: record.channelId,
      messageId: record.input.messageId, conversationId: record.input.conversationId, senderId: record.input.senderId,
      ...(record.input.threadId ? { threadId: record.input.threadId } : {}), sessionId: record.request.sessionId,
      requestId: record.request.requestId, status: record.status, sequence: record.sequence,
      reply: selected.map(segment => segment.text).join('\n\n'),
      ...(record.attention ? { attention: record.attention } : {}), ...(record.errorCode ? { errorCode: record.errorCode } : {}) };
  }
  get(channelId: string, messageId: string) {
    this.channel(channelId);
    const record = this.#records.get(recordKey(channelId, messageId));
    if (!record) throw new BotGatewayError('message_not_found', 404);
    return this.#receipt(record);
  }
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#writes.then(work);
    this.#writes = result.catch(() => undefined);
    return result;
  }
  async #save(record: Record) {
    await writePrivateJson(join(this.directory, `${record.key}.json`), record);
  }
  async accept(channelId: string, input: unknown): Promise<BotReceipt> {
    const channel = this.channel(channelId), message = botMessageSchema.parse(input);
    if (channel.allowedSenders && !channel.allowedSenders.includes(message.senderId)) throw new BotGatewayError('sender_not_allowed', 403);
    const result = await this.#serial(async () => {
      if (this.#abort.signal.aborted || this.#broken) throw new BotGatewayError('gateway_unavailable', 503);
      const key = recordKey(channelId, message.messageId), fingerprint = hash(message);
      const previous = this.#records.get(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new BotGatewayError('message_id_conflict', 409);
        return this.#receipt(previous);
      }
      if ([...this.#records.values()].filter(record => !terminal(record.status)).length >= 128) throw new BotGatewayError('queue_full', 429);
      const sessionId = `bot-${hash([this.#agentId, channelId, message.conversationId, message.threadId ?? '', message.senderId]).slice(0, 40)}`;
      const record: Record = { version: 1, key, agentId: this.#agentId, channelId, fingerprint, input: message,
        request: { requestId: `bot-${key}`, sessionId, text: message.text, modelId: this.#modelId,
          permissionMode: 'task_free', language: this.config.language, queueOnly: true,
          userMessageMetadata: { externalMessage: { channelId, conversationId: message.conversationId, senderId: message.senderId, messageId: message.messageId } } },
        receivedAt: new Date().toISOString(), order: ++this.#nextOrder, status: 'accepted', sequence: 1, cursor: 0, segments: {} };
      await this.#save(record); this.#records.set(key, record);
      return this.#receipt(record);
    });
    this.#pump(); return result;
  }
  async #update(record: Record, action: () => void) {
    await this.#serial(async () => {
      action(); record.sequence++;
      const receipt = this.#receipt(record);
      if (terminal(record.status) || record.status === 'needs_input') {
        if (!record.notification || record.notification.body !== JSON.stringify({ ...receipt, sequence: record.notification.sequence })) {
          record.notification = { sequence: record.sequence, body: JSON.stringify(receipt), delivered: false };
        }
      }
      await this.#save(record);
      for (const listener of this.#listeners) { try { listener(receipt); } catch { /* A disconnected transport does not own the task. */ } }
    });
    this.#deliver(record);
  }
  #pump() {
    if (this.#abort.signal.aborted) return;
    const records = [...this.#records.values()].sort((a, b) => a.order - b.order);
    const busy = new Set([...this.#workers.keys()].map(key => this.#records.get(key)!.request.sessionId));
    for (const record of records) {
      if (!this.config.channels.some(channel => channel.id === record.channelId)) continue;
      this.#deliver(record);
      if (terminal(record.status) || this.#workers.has(record.key) || busy.has(record.request.sessionId) || this.#workers.size >= 4) continue;
      busy.add(record.request.sessionId);
      const work = this.#run(record).catch(() => { this.#fatal(); })
        .finally(() => { this.#workers.delete(record.key); this.#pump(); });
      this.#workers.set(record.key, work);
    }
  }
  async #job(record: Record) {
    const jobs = await this.client.call('chat.jobs', { sessionId: record.request.sessionId }, this.#abort.signal) as AgentJob[];
    return jobs.find(job => job.id === record.request.requestId);
  }
  async #run(record: Record) {
    const signal = this.#abort.signal;
    while (!signal.aborted && !terminal(record.status)) {
      try {
        if ((await this.client.info(signal)).id !== this.#agentId) throw new AgentIdentityError('agent_identity_changed');
        let job = await this.#job(record);
        if (!job && record.turnId) throw new BotGatewayError('original_task_missing');
        if (!job) {
          const session = await this.client.call('sessions.get', { sessionId: record.request.sessionId }, signal);
          if (!session) {
            try { await this.client.call('sessions.create', { sessionId: record.request.sessionId,
              projectId: null, title: uiText(this.config.language)('botGateway.conversationTitle', { channel: record.channelId, sender: record.input.senderId }) }, signal); }
            catch (error) { if (!await this.client.call('sessions.get', { sessionId: record.request.sessionId }, signal)) throw error; }
          }
          // A lost acknowledgement is reconciled with the same durable request ID.
          try { job = await this.client.call('chat.send', record.request, signal) as AgentJob; }
          catch (error) { job = await this.#job(record); if (!job) throw error; }
        }
        if (!record.turnId) await this.#update(record, () => { record.turnId = job!.turnId; record.status = 'running'; });
        for await (const frame of this.client.events({ sessionId: record.request.sessionId, turnId: record.turnId!, afterSequence: record.cursor }, signal)) {
          if (frame.type !== 'event') continue;
          const event = decodeRuntimeEvent(frame.event);
          if (event.sessionId !== record.request.sessionId || event.turnId !== record.turnId) throw new BotGatewayError('event_identity_mismatch');
          if (event.sequence <= record.cursor) continue;
          await this.#event(record, event);
        }
        job = await this.#job(record);
        if (!job) throw new BotGatewayError('original_task_missing');
        if (job.status === 'queued' || job.status === 'running') throw new AgentNetworkError('stream_ended');
        await this.#update(record, () => { record.status = job!.status as Status; delete record.attention;
          if (job!.status === 'failed' || job!.status === 'interrupted') record.errorCode = 'task_failed'; });
      } catch (error) {
        if (signal.aborted) return;
        const retry = error instanceof AgentNetworkError || error instanceof AgentHttpError && error.status >= 500;
        if (!retry || error instanceof AgentIdentityError) {
          await this.#update(record, () => { record.status = 'failed'; record.errorCode = error instanceof BotGatewayError ? error.code
            : error instanceof AgentIdentityError ? 'agent_identity_changed' : 'task_failed'; delete record.attention; });
          return;
        }
        if (record.status !== 'reconnecting') await this.#update(record, () => { record.status = 'reconnecting'; });
        await delay(this.options.retryMs ?? 2000, undefined, { signal }).catch(() => undefined);
        if (!signal.aborted) await this.client.reconnect?.().catch(() => undefined);
      }
    }
  }
  async #event(record: Record, event: RuntimeEvent) {
    await this.#update(record, () => {
      record.cursor = event.sequence;
      if (record.status === 'reconnecting') record.status = record.attention ? 'needs_input' : 'running';
      if (event.kind === 'assistant_segment_delta' || event.kind === 'assistant_segment_completed') {
        const key = `${event.payload.messageId}:${event.payload.segmentId}`;
        const previous = record.segments[key]?.text ?? '';
        const text = event.kind === 'assistant_segment_delta' ? previous + event.payload.delta : event.payload.content;
        const total = Object.values(record.segments).reduce((size, segment) => size + segment.text.length, 0) - previous.length + text.length;
        if (total > 256_000 || Object.keys(record.segments).length >= 1000 && !record.segments[key]) throw new BotGatewayError('reply_too_large');
        record.segments[key] = { text, messageId: event.payload.messageId, final: event.payload.finalResponse === true };
      } else if (event.kind === 'permission_requested' || event.kind === 'solution_selection_requested') {
        record.status = 'needs_input'; record.attention = event.kind === 'permission_requested'
          ? { kind: 'permission', id: event.payload.permissionId } : { kind: 'question', id: event.payload.selectionId };
      } else if (['permission_answered', 'permission_rejected', 'permission_expired', 'permission_cancelled', 'solution_selection_answered', 'solution_selection_cancelled'].includes(event.kind)) {
        delete record.attention; record.status = 'running';
      } else if (event.kind === 'replay_reset') { record.segments = {}; delete record.finalMessageId; }
      else if (event.kind === 'turn_terminal') record.finalMessageId = event.payload.finalMessageId;
      // Reasoning, tool arguments/results and permission contents never leave this gateway.
    });
  }
  #deliver(record: Record) {
    const callback = this.config.channels.find(channel => channel.id === record.channelId)?.callback;
    if (!callback || !record.notification || record.notification.delivered || this.#deliveries.has(record.key) || this.#abort.signal.aborted) return;
    const work = this.#delivery(record, callback).catch(() => { this.#fatal(); })
      .finally(() => { this.#deliveries.delete(record.key); if (!this.#abort.signal.aborted) this.#deliver(record); });
    this.#deliveries.set(record.key, work);
  }
  async #delivery(record: Record, callback: NonNullable<BotChannel['callback']>) {
    let attempt = 0;
    while (!this.#abort.signal.aborted && record.notification && !record.notification.delivered) {
      const notification = record.notification;
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = createHmac('sha256', callback.secret).update(`${timestamp}.${notification.body}`).digest('hex');
      try {
        const response = await (this.options.fetch ?? fetch)(callback.url, { method: 'POST', redirect: 'error',
          signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(10_000)]),
          headers: { 'Content-Type': 'application/json', 'X-CardBush-Timestamp': timestamp,
            'X-CardBush-Signature': `v1=${signature}`, 'X-CardBush-Delivery-ID': `${record.key}:${notification.sequence}` }, body: notification.body });
        await response.body?.cancel();
        if (response.ok) {
          await this.#serial(async () => {
            if (record.notification?.sequence === notification.sequence) { record.notification.delivered = true; await this.#save(record); }
          });
          attempt = 0; continue;
        }
      } catch { /* Retry this receipt, never the model invocation. */ }
      await delay(this.options.retryMs ?? Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5)), undefined, { signal: this.#abort.signal }).catch(() => undefined);
    }
  }
  async close() {
    this.#abort.abort();
    await Promise.allSettled([...this.#workers.values(), ...this.#deliveries.values()]);
    await this.#writes;
    this.#listeners.clear();
    const release = this.#release; this.#release = undefined; await release?.();
  }
}
