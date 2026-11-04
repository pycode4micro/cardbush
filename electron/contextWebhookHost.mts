import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writePrivateJson } from './atomicJsonFile.mjs';
import { webhookConfigSchema, WebhookError, incomingMessage, webhookHash, deliverWebhook, type WebhookMessage } from './contextWebhookProtocol.mjs';
import { webhookBindingSchema, runContextWebhook, type WebhookRuntime, type WebhookResult } from './contextWebhookRuntime.mjs';
import type { ContextWebhookConfig, ContextWebhookSnapshot, WebhookBinding } from './contextWebhookTypes.js';
import { contextWebhookPort, contextWebhookProtocol } from './contextWebhookDefaults.js';
import { localPairingSchema, localPairingConfig, assertLocalPairingRequest, readWebhookJson, type LocalWebhookPairing } from './contextWebhookPairing.mjs';

type Connection = ContextWebhookConfig & { id: string; token: string; binding: WebhookBinding; lastReceivedAt?: string; lastDeliveredAt?: string; lastError?: string };
type Receipt = { id: string; connectionId: string; fingerprint: string; message: WebhookMessage; binding: WebhookBinding;
  status: 'accepted' | 'running' | WebhookResult['status']; reply: string; createdAt: string; errorCode?: string; delivered: boolean; sequence: number; nextDelivery?: number; attempts: number };
type State = { version: 1; host: string; port: number; connections: Connection[]; receipts: Receipt[]; pairings: LocalWebhookPairing[] };
const terminal = (status: Receipt['status']) => !['accepted', 'running'].includes(status);
const serializeError = (error: unknown) => error instanceof WebhookError ? error.code : error instanceof z.ZodError ? 'invalid_parameters' : 'service_unavailable';

export class ContextWebhookHost {
  private state: State = { version: 1, host: '127.0.0.1', port: contextWebhookPort, connections: [], receipts: [], pairings: [] };
  private server?: Server;
  private listenerStart?: Promise<void>;
  private listenerRetryAt = 0;
  private listenerError?: string;
  private writes: Promise<unknown> = Promise.resolve();
  private commands: Promise<unknown> = Promise.resolve();
  private workers = new Set<string>();
  private deliveries = new Set<string>();
  private running = new Set<string>();
  private abort = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private checkingFollowups = false;
  private followupCursor = 0;
  private followupGeneration?: number;
  private followupEntries = new Map<string, Map<string, string>>();
  constructor(private root: string, private secrets: { encrypt(value: string): string; decrypt(value: string): string },
    private runtime: WebhookRuntime, private options: { port?: number; execute?: typeof runContextWebhook } = {}) {}
  async start() {
    try {
      const saved = JSON.parse(await readFile(join(this.root, 'webhooks', 'state.json'), 'utf8'));
      const state = JSON.parse(this.secrets.decrypt(saved.encrypted)) as State;
      if (state.version !== 1 || !Array.isArray(state.connections) || !Array.isArray(state.receipts)) throw new WebhookError('storage_invalid');
      for (const c of state.connections) { webhookConfigSchema.parse(this.config(c)); webhookBindingSchema.parse(c.binding); }
      state.pairings ??= [];
      this.state = state;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (this.options.port !== undefined) this.state.port = this.options.port;
    await this.listen();
    this.timer = setInterval(() => this.pump(), 1000); this.timer.unref(); this.pump();
    return this;
  }
  private config(c: Connection): ContextWebhookConfig {
    return { id: c.id, name: c.name, enabled: c.enabled, url: c.url, headers: c.headers, parameters: c.parameters, body: c.body, incoming: c.incoming };
  }
  private write<T>(change: (next: State) => T): Promise<T> {
    const work = this.writes.then(async () => {
      const next = structuredClone(this.state), result = change(next);
      await writePrivateJson(join(this.root, 'webhooks', 'state.json'), { version: 1, encrypted: this.secrets.encrypt(JSON.stringify(next)) });
      this.state = next; return result;
    });
    this.writes = work.catch(() => {}); return work;
  }
  private receipt(record: Receipt) {
    return { protocol: 'cardbush.webhook.v1', type: terminal(record.status) ? 'message.completed' : 'message.updated',
      eventId: `${record.id}:${record.sequence}`, sequence: record.sequence, messageId: record.message.messageId, sessionId: record.binding.sessionId,
      conversationId: record.message.conversationId ?? '', senderId: record.message.senderId ?? '',
      status: record.status, reply: record.reply, errorCode: record.errorCode ?? '' };
  }
  private snapshot(sessionId: string): ContextWebhookSnapshot {
    const address = this.server?.address(); const port = address && typeof address === 'object' ? address.port : this.state.port;
    const host = this.state.host === '0.0.0.0' ? '127.0.0.1' : this.state.host.includes(':') ? `[${this.state.host}]` : this.state.host;
    return { listening: Boolean(address), host: this.state.host, port, error: this.listenerError,
      pairings: this.state.pairings.filter(p => p.status === 'pending' && p.expiresAt > Date.now())
        .map(p => ({ requestId: p.requestId, name: p.name, replyUrl: p.replyUrl })),
      connections: this.state.connections.filter(c => c.binding.sessionId === sessionId).map(c => ({ ...this.config(c), id: c.id,
        sessionId, kind: c.binding.kind, token: c.token, endpoint: `http://${host}:${port}/api/webhooks/v1/${c.id}/messages`,
        pending: this.state.receipts.filter(r => r.connectionId === c.id && (!terminal(r.status) || !r.delivered)).length,
        lastReceivedAt: c.lastReceivedAt, lastDeliveredAt: c.lastDeliveredAt, lastError: c.lastError })) };
  }
  command(input: unknown): Promise<unknown> {
    const operation = this.commands.then(() => this.execute(input)); this.commands = operation.catch(() => {});
    return operation.catch(error => { throw new Error(serializeError(error)); });
  }
  private async execute(input: unknown) {
    const request = z.discriminatedUnion('action', [
      z.object({ action: z.literal('read'), sessionId: z.string().min(1) }).strict(),
      z.object({ action: z.literal('save'), config: webhookConfigSchema, binding: webhookBindingSchema }).strict(),
      z.object({ action: z.literal('delete'), id: z.string().uuid(), sessionId: z.string().min(1) }).strict(),
      z.object({ action: z.literal('test'), config: webhookConfigSchema, text: z.string().min(1).max(500) }).strict(),
      z.object({ action: z.literal('approve_pairing'), requestId: z.string().uuid(), binding: webhookBindingSchema }).strict(),
      z.object({ action: z.literal('reject_pairing'), requestId: z.string().uuid(), sessionId: z.string().min(1) }).strict(),
      z.object({ action: z.literal('listener'), host: z.enum(['127.0.0.1', '0.0.0.0', '::1']), port: z.number().int().min(1024).max(65535), sessionId: z.string().min(1) }).strict(),
    ]).parse(input);
    if (request.action === 'read') return this.snapshot(request.sessionId);
    if (request.action === 'approve_pairing' || request.action === 'reject_pairing') {
      if (request.action === 'approve_pairing' && !await this.runtime.command('runtime.get_session', { sessionId: request.binding.sessionId })) throw new WebhookError('context_deleted');
      await this.write(state => {
        const pending = state.pairings.find(p => p.requestId === request.requestId);
        if (!pending || pending.expiresAt <= Date.now()) throw new WebhookError('pairing_expired');
        if (pending.status !== 'pending') throw new WebhookError('pairing_already_handled');
        if (request.action === 'reject_pairing') pending.status = 'rejected';
        else {
          const connection = this.saveConnection(state, localPairingConfig(pending), request.binding);
          pending.status = 'connected'; pending.connectionId = connection.id;
        }
      });
      return this.snapshot(request.action === 'approve_pairing' ? request.binding.sessionId : request.sessionId);
    }
    if (request.action === 'test') {
      if (!request.config.url) throw new WebhookError('reply_url_required');
      await deliverWebhook(request.config, { protocol: 'cardbush.webhook.v1', type: 'connection.test', eventId: randomUUID(),
        sequence: 1, messageId: 'test', sessionId: '', conversationId: '', senderId: '', status: 'completed', reply: request.text, errorCode: '' });
      return { delivered: true };
    }
    if (request.action === 'listener') {
      const previous = { host: this.state.host, port: this.state.port };
      await this.write(state => { state.host = request.host; state.port = request.port; });
      await this.closeListener(); await this.listen();
      if (this.listenerError) { await this.write(state => Object.assign(state, previous)); await this.listen(); throw new WebhookError('listener_failed'); }
      return this.snapshot(request.sessionId);
    }
    if (request.action === 'delete') {
      await this.write(state => {
        const connection = state.connections.find(c => c.id === request.id && c.binding.sessionId === request.sessionId);
        if (!connection) throw new WebhookError('connection_not_found', 404);
        state.connections = state.connections.filter(c => c !== connection);
      });
    } else {
      const config = request.config, binding = request.binding;
      if (!await this.runtime.command('runtime.get_session', { sessionId: binding.sessionId })) throw new WebhookError('context_deleted');
      await this.write(state => this.saveConnection(state, config, binding));
    }
    await this.listen(); this.pump();
    return this.snapshot(request.action === 'save' ? request.binding.sessionId : request.sessionId);
  }
  private saveConnection(state: State, config: ContextWebhookConfig, binding: WebhookBinding) {
    const previous = config.id ? state.connections.find(c => c.id === config.id) : undefined;
    if (config.id && (!previous || previous.binding.sessionId !== binding.sessionId || previous.binding.kind !== binding.kind)) throw new WebhookError('binding_mismatch');
    if (!previous && state.connections.length >= 32) throw new WebhookError('connection_limit');
    const parent = { ...binding.parent, inputMessages: [{ messageId: 'binding', message: { role: 'user' as const, content: 'Webhook binding' } }] };
    delete parent.supersession;
    const next: Connection = { ...config, id: previous?.id ?? randomUUID(), token: previous?.token ?? randomBytes(32).toString('hex'),
      binding: { ...binding, parent }, lastReceivedAt: previous?.lastReceivedAt, lastDeliveredAt: previous?.lastDeliveredAt };
    state.connections = [...state.connections.filter(c => c.id !== next.id), next]; return next;
  }
  private pairingResult(pairing: LocalWebhookPairing) {
    if (pairing.expiresAt <= Date.now()) throw new WebhookError('pairing_expired', 410);
    const connection = pairing.connectionId && this.state.connections.find(c => c.id === pairing.connectionId && c.enabled);
    const result = { protocol: contextWebhookProtocol, requestId: pairing.requestId, status: pairing.status };
    if (pairing.status !== 'connected') return result;
    if (!connection) return { ...result, status: 'revoked' };
    const view = this.snapshot(connection.binding.sessionId).connections.find(c => c.id === connection.id)!;
    return { ...result, connection: { id: connection.id, endpoint: view.endpoint, token: connection.token,
      sessionId: connection.binding.sessionId, title: connection.binding.title } };
  }
  private listen(): Promise<void> {
    // Local discovery is available before the first connection is configured.
    if (this.server || this.abort.signal.aborted) return Promise.resolve();
    return this.listenerStart ??= this.openListener().finally(() => { this.listenerStart = undefined; });
  }
  private async openListener() {
    const server = createServer((req, res) => {
      const json = (status: number, value: unknown) => { if (!res.destroyed) res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(value)); };
      void (async () => {
        if (req.url === '/api/webhooks/v1/discovery' && req.method === 'GET') {
          assertLocalPairingRequest(req);
          json(200, { protocol: contextWebhookProtocol, capabilities: ['local_pairing'], pairingPath: '/api/webhooks/v1/pairings' }); return;
        }
        const pairingPath = /^\/api\/webhooks\/v1\/pairings(?:\/([\w-]+))?$/.exec(req.url ?? '');
        if (pairingPath) {
          assertLocalPairingRequest(req);
          const secret = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '')?.[1];
          if (!secret) throw new WebhookError('unauthorized', 401);
          const secretHash = webhookHash(secret);
          if (req.method === 'POST' && !pairingPath[1]) {
            const input = localPairingSchema.parse(await readWebhookJson(req, 16 * 1024)); localPairingConfig(input);
            const pairing = await this.write(state => {
              state.pairings = state.pairings.filter(p => p.expiresAt > Date.now());
              const existing = state.pairings.find(p => p.requestId === input.requestId);
              if (existing) {
                if (existing.secretHash !== secretHash) throw new WebhookError('unauthorized', 401);
                if (existing.name !== input.name || existing.replyUrl !== input.replyUrl || webhookHash(existing.replyHeaders) !== webhookHash(input.replyHeaders)) throw new WebhookError('pairing_conflict', 409);
                return existing;
              }
              if (state.pairings.length >= 64) throw new WebhookError('pairing_limit', 429);
              const next: LocalWebhookPairing = { ...input, secretHash, expiresAt: Date.now() + 10 * 60000, status: 'pending' };
              state.pairings.push(next); return next;
            });
            json(202, this.pairingResult(pairing)); return;
          }
          if (req.method === 'GET' && pairingPath[1]) {
            const pairing = this.state.pairings.find(p => p.requestId === pairingPath[1]);
            if (!pairing || pairing.secretHash !== secretHash) throw new WebhookError('unauthorized', 401);
            json(200, this.pairingResult(pairing)); return;
          }
          throw new WebhookError('endpoint_not_found', 404);
        }
        const match = /^\/api\/webhooks\/v1\/([\w-]+)\/messages(?:\/([^/?]+))?$/.exec(req.url ?? '');
        const connection = match && this.state.connections.find(c => c.id === match[1] && c.enabled);
        if (!connection || req.headers.origin !== undefined) throw new WebhookError('unauthorized', 401);
        const wanted = Buffer.from(`Bearer ${connection.token}`), received = Buffer.from(req.headers.authorization ?? '');
        if (wanted.length !== received.length || !timingSafeEqual(wanted, received)) throw new WebhookError('unauthorized', 401);
        if (req.method === 'GET' && !match![2]) {
          json(200, { protocol: contextWebhookProtocol, type: 'connection.info', sessionId: connection.binding.sessionId, title: connection.binding.title }); return;
        }
        if (req.method === 'GET' && match![2]) {
          const messageId = decodeURIComponent(match![2]); const record = this.state.receipts.find(r => r.connectionId === connection.id && r.message.messageId === messageId);
          if (!record) throw new WebhookError('message_not_found', 404);
          json(200, this.receipt(record)); return;
        }
        if (req.method !== 'POST' || match![2]) throw new WebhookError('endpoint_not_found', 404);
        const body = await readWebhookJson(req);
        const message = incomingMessage(body, connection.incoming), fingerprint = webhookHash(message);
        const receipt = await this.write(state => {
          if (!state.connections.some(c => c.id === connection.id && c.enabled)) throw new WebhookError('connection_disabled', 409);
          const existing = state.receipts.find(r => r.connectionId === connection.id && r.message.messageId === message.messageId);
          if (existing) { if (existing.fingerprint !== fingerprint) throw new WebhookError('message_id_conflict', 409); return this.receipt(existing); }
          if (state.receipts.filter(r => !terminal(r.status)).length >= 128) throw new WebhookError('queue_full', 429);
          const record: Receipt = { id: randomUUID(), connectionId: connection.id, message, fingerprint, binding: connection.binding,
            status: 'accepted', reply: '', createdAt: new Date().toISOString(), delivered: false, sequence: 1, attempts: 0 };
          state.receipts.push(record); state.connections.find(c => c.id === connection.id)!.lastReceivedAt = record.createdAt;
          return this.receipt(record);
        });
        res.setHeader('Location', `/api/webhooks/v1/${connection.id}/messages/${encodeURIComponent(message.messageId)}`);
        json(202, receipt); this.pump();
      })().catch(error => { json(error instanceof WebhookError ? error.status : 400, { error: { code: serializeError(error) } }); req.resume(); });
    });
    server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxConnections = 64;
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.state.port, this.state.host, () => { server.off('error', reject); resolve(); }); });
      this.server = server; this.listenerError = undefined;
    } catch { server.close(); this.listenerError = 'listener_failed'; this.listenerRetryAt = Date.now() + 3000; }
  }
  private pump() {
    if (this.abort.signal.aborted) return;
    // A previous application instance can briefly own the fixed port during
    // restart. Keep recovering discovery without requiring a settings change.
    if (!this.server && Date.now() >= this.listenerRetryAt) void this.listen();
    if (!this.checkingFollowups) { this.checkingFollowups = true; void this.followups().catch(() => {}).finally(() => { this.checkingFollowups = false; }); }
    for (const record of this.state.receipts) {
      const connection = this.state.connections.find(c => c.id === record.connectionId && c.enabled); if (!connection) continue;
      if (!terminal(record.status) && !this.workers.has(record.binding.sessionId)) {
        this.workers.add(record.binding.sessionId);
        void this.run(record).finally(() => { this.workers.delete(record.binding.sessionId); });
      } else if (terminal(record.status) && !record.delivered && (record.nextDelivery ?? 0) <= Date.now() && !this.deliveries.has(record.id)) {
        this.deliveries.add(record.id); void this.deliver(record, connection).finally(() => this.deliveries.delete(record.id));
      }
    }
  }
  private async run(record: Receipt) {
    const recovering = record.status === 'running' && !this.running.has(record.id);
    this.running.add(record.id);
    try {
      await this.write(state => { const r = state.receipts.find(r => r.id === record.id)!; r.status = 'running'; r.sequence++; });
      const result = await (this.options.execute ?? runContextWebhook)(this.runtime, record.binding, record.message, record.id, recovering, this.abort.signal);
      if (this.abort.signal.aborted) return;
      if (result.reply.length > 128000) throw new WebhookError('reply_too_large');
      await this.write(state => { const r = state.receipts.find(r => r.id === record.id)!; Object.assign(r, result); r.sequence++; });
    } catch (error) {
      if (this.abort.signal.aborted) return;
      const busy = (error as { code?: string }).code === 'runtime_session_busy';
      await this.write(state => { const r = state.receipts.find(r => r.id === record.id)!; r.sequence++;
        Object.assign(r, busy ? { status: 'accepted' } : { status: 'failed', errorCode: serializeError(error) }); }).catch(() => {});
    } finally { this.running.delete(record.id); }
  }
  private async deliver(record: Receipt, connection: Connection) {
    try {
      await deliverWebhook(this.config(connection), this.receipt(record), this.abort.signal);
      await this.write(state => { const r = state.receipts.find(r => r.id === record.id)!; if (r.sequence === record.sequence) r.delivered = true;
        const c = state.connections.find(c => c.id === connection.id); if (c) { c.lastDeliveredAt = new Date().toISOString(); delete c.lastError; } });
    } catch (error) {
      if (this.abort.signal.aborted) return;
      await this.write(state => { const r = state.receipts.find(r => r.id === record.id)!; r.attempts++;
        r.nextDelivery = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(r.attempts, 5));
        const c = state.connections.find(c => c.id === connection.id); if (c) c.lastError = serializeError(error); }).catch(() => {});
    }
  }
  private async followups() {
    if (!this.state.receipts.some(r => r.binding.kind === 'assistant'
      && this.state.connections.some(c => c.id === r.connectionId && c.enabled))) return;
    const journal = await this.runtime.command('runtime.assistant_conversation', { action: 'read', sessionId: 'personal-assistant', after: this.followupCursor });
    if (journal.busy || this.abort.signal.aborted) return;
    if (this.followupGeneration !== undefined && this.followupGeneration !== journal.generation) {
      this.followupCursor = 0; this.followupEntries.clear(); this.followupGeneration = journal.generation; return;
    }
    this.followupGeneration = journal.generation;
    const records = this.state.receipts.filter(r => r.binding.kind === 'assistant');
    // Only fetch newly appended entries; a connected bot must not repeatedly copy the entire Assistant history.
    const wanted = new Set(records.map(r => `webhook-input-${r.id}`));
    for (const entry of journal.entries) {
      if (entry.role !== 'assistant' || entry.visibility !== 'conversation') continue;
      for (const id of entry.responseTo ?? []) if (wanted.has(id)) {
        const entries = this.followupEntries.get(id) ?? new Map<string, string>(); entries.set(entry.id, entry.content); this.followupEntries.set(id, entries);
      }
    }
    this.followupCursor = journal.cursor;
    for (const record of records) {
      if (record.status !== 'completed' || record.binding.generation !== journal.generation
        || !this.state.connections.some(c => c.id === record.connectionId && c.enabled)) continue;
      const reply = [...this.followupEntries.get(`webhook-input-${record.id}`)?.values() ?? []].join('\n\n');
      if (!reply || reply === record.reply || reply.length > 128000) continue;
      await this.write(state => { const r = state.receipts.find(r => r.id === record.id)!;
        if (r.reply !== reply) { r.reply = reply; r.sequence++; r.delivered = false; r.nextDelivery = 0; r.attempts = 0; } });
    }
  }
  private async closeListener() {
    await this.listenerStart;
    if (this.server) { const server = this.server; this.server = undefined; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
  async close() { this.abort.abort(); clearInterval(this.timer); await this.closeListener(); await this.writes; }
}
