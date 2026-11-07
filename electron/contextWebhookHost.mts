import { resolveUiLanguage, uiText } from '@cardbush/platform/i18n';
import { FRIENDS_SESSION, PERSONAL_ASSISTANT_SESSION, FRIENDS_COMMAND } from '@cardbush/bush-protocol';
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
import { botCapabilitiesSchema, type BotCapabilities, type BotContext, type BotSource, type BotFileAccess } from '@cardbush/bush-protocol';
import { snapshotWebhookFiles, readBotAcknowledgement } from './contextWebhookFiles.mjs';
import { bridgePluginsSchema, bridgeToolCallSchema, bridgeFilePaths, bridgeToolName, type BridgePlugin, type BridgeToolCall } from '@cardbush/bush-protocol';
import { applyWebhookTurnPolicy, botContextMessage } from '@cardbush/bush-protocol';

// Old encrypted records keep receipt and token identity across the Assistant merge.
const owner = (id: string) => id === FRIENDS_SESSION ? PERSONAL_ASSISTANT_SESSION : id;
type Connection = ContextWebhookConfig & { id: string; token: string; binding: WebhookBinding; lastReceivedAt?: string; lastDeliveredAt?: string; lastError?: string;
  bot?: { capabilities: BotCapabilities; expiresAt: number; plugins?: BridgePlugin[]; instanceId?: string } };
type Receipt = { id: string; connectionId: string; fingerprint: string; message: WebhookMessage; binding: WebhookBinding;
  guidanceFor?: string;
  status: 'accepted' | 'running' | WebhookResult['status']; reply: string; createdAt: string; errorCode?: string; delivered: boolean; sequence: number; nextDelivery?: number; attempts: number };
type BotDelivery = { id: string; sessionId: string; sourceRef: string; requestId: string; inputHash: string; fingerprint: string;
  status: 'pending' | 'accepted' | 'unknown'; createdAt: string; code?: string; result?: unknown };
type State = { version: 1; host: string; port: number; connections: Connection[]; receipts: Receipt[]; pairings: LocalWebhookPairing[]; botDeliveries: BotDelivery[] };
const terminal = (status: Receipt['status']) => !['accepted', 'running'].includes(status);
const serializeError = (error: unknown) => error instanceof WebhookError ? error.code : error instanceof z.ZodError ? 'invalid_parameters' : 'service_unavailable';

export class ContextWebhookHost {
  private state: State = { version: 1, host: '127.0.0.1', port: contextWebhookPort, connections: [], receipts: [], pairings: [], botDeliveries: [] };
  private botSends = new Map<string, { hash: string; promise: Promise<unknown> }>();
  private server?: Server;
  private listenerStart?: Promise<void>;
  private listenerRetryAt = 0;
  private listenerError?: string;
  private writes: Promise<unknown> = Promise.resolve();
  private commands: Promise<unknown> = Promise.resolve();
  private workers = new Set<string>();
  private guiding = new Set<string>();
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
      state.botDeliveries ??= [];
      for (const delivery of state.botDeliveries) if (delivery.status === 'pending') delivery.status = 'unknown';
      this.state = state;
      for (const connection of this.state.connections) delete connection.bot;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (this.options.port !== undefined) this.state.port = this.options.port;
    await this.listen();
    this.timer = setInterval(() => this.pump(), 1000); this.timer.unref(); this.pump();
    return this;
  }
  private config(c: Connection): ContextWebhookConfig {
    return { id: c.id, name: c.name, enabled: c.enabled, url: c.url, headers: c.headers, parameters: c.parameters, body: c.body, incoming: c.incoming };
  }
  private write<T>(change: (next: State) => T | Promise<T>): Promise<T> {
    const work = this.writes.then(async () => {
      const next = structuredClone(this.state), result = await change(next);
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
      onlineElsewhere: this.state.connections
        .filter(c => owner(c.binding.sessionId) !== owner(sessionId) && this.connectionStatus(c) === 'connected')
        .map(c => ({ id: c.id, name: c.name, contextTitle: c.binding.title || owner(c.binding.sessionId) })),
      connections: this.state.connections.filter(c => owner(c.binding.sessionId) === owner(sessionId)).map(c => ({ ...this.config(c), id: c.id,
        sessionId, kind: c.binding.kind === 'friends' ? 'assistant' : c.binding.kind, token: c.token, endpoint: `http://${host}:${port}/api/webhooks/v1/${c.id}/messages`,
        status: this.connectionStatus(c),
        pending: this.state.receipts.filter(r => r.connectionId === c.id && (!terminal(r.status) || !r.delivered)).length,
        lastReceivedAt: c.lastReceivedAt, lastDeliveredAt: c.lastDeliveredAt, lastError: c.lastError })) };
  }
  command(input: unknown): Promise<unknown> {
    const operation = this.commands.then(() => this.execute(input)); this.commands = operation.catch(() => {});
    return operation.catch(error => { throw new Error(serializeError(error)); });
  }
  /** Private Runtime RPC; never expose callback addresses, headers or tokens to models. */
  async botRequest(value: unknown, signal?: AbortSignal): Promise<unknown> {
    const request = z.discriminatedUnion('action', [
      z.object({ action: z.literal('context'), sessionId: z.string().min(1), sourceRef: z.string().max(100).optional() }).strict(),
      z.object({ action: z.literal('catalog'), sessionId: z.string().min(1) }).strict(),
      z.object({ action: z.literal('call'), sessionId: z.string().min(1), input: bridgeToolCallSchema,
        files: z.array(z.object({ path: z.string().min(1), identity: z.string().regex(/^\d+:\d+$/) }).strict()).max(8).optional() }).strict(),
    ]).parse(value);
    if (request.action === 'context') return this.botContext(request.sessionId, request.sourceRef);
    if (request.action === 'catalog') return this.pluginCatalog(request.sessionId);
    if (request.action === 'call') {
      const key = `plugin:${request.sessionId}:${request.input.sourceRef}:${request.input.requestId}`, hash = webhookHash(request.input);
      const pending = this.botSends.get(key);
      if (pending) return pending.hash === hash ? pending.promise : { status: 'failed', code: 'request_id_conflict' };
      const promise = this.callBridgePlugin(request.sessionId, request.input, request.files, signal)
        .catch(error => ({ status: 'failed', code: ['workspace_authorization_changed', 'workspace_path_guard_unavailable', 'sandbox_backend_unavailable'].includes(error?.code) ? error.code : serializeError(error), requestId: request.input.requestId }));
      this.botSends.set(key, { hash, promise });
      try { return await promise; } finally { this.botSends.delete(key); }
    }
  }
  private connectionReason(connection?: Connection) {
    return !connection ? 'bot_disconnected' : !connection.enabled ? 'bot_disabled' : !connection.url ? 'bot_callback_missing'
      : this.abort.signal.aborted || !this.server?.listening || !connection.bot || connection.bot.expiresAt <= Date.now() ? 'bot_offline' : undefined;
  }
  private connectionStatus(connection: Connection) {
    return !connection.enabled ? 'disabled' as const : this.connectionReason(connection) ? 'offline' as const : 'connected' as const;
  }
  private botSource(record: Receipt): BotSource {
    const connection = this.state.connections.find(c => c.id === record.connectionId);
    const reason = this.connectionReason(connection);
    return { sourceRef: `webhook:${record.id}`, connectionId: record.connectionId, botName: connection?.name ?? 'Bot',
      messageId: record.message.messageId, senderId: record.message.senderId ?? '', conversationId: record.message.conversationId ?? '',
      receivedAt: record.createdAt, available: !reason, ...(reason ? { reason } : {}),
      capabilities: connection?.bot?.capabilities ?? botCapabilitiesSchema.parse({ text: false }),
      plugins: connection?.bot?.plugins?.map(plugin => ({ id: plugin.id, name: plugin.name,
        tools: plugin.tools.map(tool => bridgeToolName(connection.id, plugin.id, tool.name)) })) ?? [] };
  }
  private botContext(sessionId: string, sourceRef?: string): BotContext {
    const records = this.state.receipts.filter(r => owner(r.binding.sessionId) === owner(sessionId)), seen = new Set<string>(), targets: BotSource[] = [];
    for (const record of [...records].reverse()) {
      const key = JSON.stringify([record.connectionId, record.message.senderId, record.message.conversationId]);
      if (seen.has(key)) continue; seen.add(key);
      const source = this.botSource(record); if (source.available) targets.push(source);
      if (targets.length >= 32) break;
    }
    const record = sourceRef && records.find(r => `webhook:${r.id}` === sourceRef);
    const source = record ? this.botSource(record) : undefined;
    const available = sourceRef ? source?.available === true : targets.length > 0;
    const connections = this.state.connections.filter(c => owner(c.binding.sessionId) === owner(sessionId))
      .map(c => ({ connectionId: c.id, botName: c.name, status: this.connectionStatus(c) }));
    const connected = connections.some(c => c.status === 'connected');
    return { discovery: 'mcp_search', available, ...(source ? { source } : {}), targets, connections,
      ...(!available ? { reason: source?.reason ?? (sourceRef ? 'source_unavailable' : connected ? 'bot_recipient_unavailable'
        : connections.some(c => c.status === 'offline') ? 'bot_offline' : connections.length ? 'bot_disabled' : 'bot_not_connected') } : {}) };
  }
  private botReceipt(delivery: BotDelivery) {
    return { status: delivery.status === 'pending' ? 'unknown' : delivery.status, eventId: delivery.id,
      requestId: delivery.requestId, sourceRef: delivery.sourceRef, ...(delivery.code ? { code: delivery.code } : {}),
      ...(delivery.result === undefined ? {} : { result: delivery.result }),
      ...(delivery.status === 'accepted' ? { deliveryConfirmed: false } : { retry: 'Reuse the same source_ref and request_id; do not create a new send.' }) };
  }
  private pluginCatalog(sessionId: string) {
    if (this.abort.signal.aborted) return [];
    return this.state.connections.filter(connection => connection.binding.sessionId === sessionId && !this.connectionReason(connection))
      .flatMap(connection => (connection.bot!.plugins ?? []).map(plugin => ({
        connectionId: connection.id, sessionId, expiresAt: connection.bot!.expiresAt, plugin, revision: webhookHash(plugin),
      })));
  }
  private async callBridgePlugin(sessionId: string, input: BridgeToolCall, access: BotFileAccess[] | undefined, signal?: AbortSignal) {
    const source = this.botContext(sessionId, input.sourceRef).source;
    if (!source?.available || source.connectionId !== input.connectionId) throw new WebhookError('bridge_source_unavailable');
    const declaration = this.pluginCatalog(sessionId).find(entry => entry.connectionId === input.connectionId && entry.plugin.id === input.pluginId);
    const tool = declaration?.plugin.tools.find(tool => tool.name === input.tool);
    if (!declaration || !tool || declaration.revision !== input.revision) throw new WebhookError('bridge_plugin_changed');
    const record = this.state.receipts.find(record => `webhook:${record.id}` === source.sourceRef)!;
    if (!await this.runtime.command('runtime.get_session', { sessionId })) throw new WebhookError('context_deleted');
    if (record.binding.kind === 'assistant' && (await this.runtime.command('runtime.assistant_conversation', { action: 'read', sessionId, after: Number.MAX_SAFE_INTEGER })).generation !== record.binding.generation)
      throw new WebhookError('context_reset');
    const paths = bridgeFilePaths(tool, input.arguments);
    if (paths.length && (!access || access.length !== paths.length || access.some((file, index) => file.path !== paths[index]))) throw new WebhookError('file_admission_required');
    if (paths.length && !source.capabilities.files) throw new WebhookError('bot_files_unsupported');
    const inputHash = webhookHash(input);
    const previous = this.state.botDeliveries.find(delivery => delivery.sessionId === sessionId && delivery.sourceRef === input.sourceRef && delivery.requestId === input.requestId);
    if (previous && previous.inputHash !== inputHash) throw new WebhookError('request_id_conflict');
    if (previous?.status === 'accepted') return this.botReceipt(previous);
    const files = await snapshotWebhookFiles(paths, source.capabilities, signal, access), descriptors = files.map(({ bytes: _bytes, ...file }) => file);
    const args = structuredClone(input.arguments); let index = 0;
    for (const key of tool.fileArguments) if (args[key] !== undefined)
      args[key] = Array.isArray(args[key]) ? (args[key] as unknown[]).map(() => ({ part: descriptors[index++]!.part })) : { part: descriptors[index++]!.part };
    const fingerprint = webhookHash({ arguments: args, files: descriptors });
    if (previous && previous.fingerprint !== fingerprint) throw new WebhookError('request_id_conflict');
    const delivery = await this.write(state => {
      if (previous) { const found = state.botDeliveries.find(item => item.id === previous.id)!; found.status = 'pending'; delete found.code; return found; }
      const next: BotDelivery = { id: randomUUID(), sessionId, sourceRef: input.sourceRef, requestId: input.requestId, inputHash, fingerprint, status: 'pending', createdAt: new Date().toISOString() };
      state.botDeliveries.push(next); return next;
    });
    try {
      const connection = this.state.connections.find(connection => connection.id === input.connectionId)!;
      if (!this.botSource(record).available || !this.pluginCatalog(sessionId).some(entry => entry.connectionId === input.connectionId && entry.revision === input.revision)) throw new WebhookError('bridge_disconnected');
      const payload = { protocol: contextWebhookProtocol, type: 'tool.call', eventId: delivery.id, pluginId: input.pluginId, pluginVersion: declaration.plugin.version,
        tool: input.tool, arguments: args, sourceRef: input.sourceRef, messageId: source.messageId, sessionId,
        senderId: source.senderId, conversationId: source.conversationId, files: descriptors, parameters: connection.parameters };
      const headers = { ...connection.headers, 'X-CardBush-Event-ID': delivery.id } as Record<string, string>;
      for (const name of Object.keys(headers)) if (name.toLowerCase() === 'content-type') delete headers[name];
      let body: string | FormData;
      if (files.length) {
        const form = new FormData(); form.set('payload', JSON.stringify(payload));
        for (const file of files) form.set(file.part, new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }), file.name);
        body = form;
      } else { headers['Content-Type'] = 'application/json'; body = JSON.stringify(payload); }
      const response = await fetch(connection.url, { method: 'POST', redirect: 'error', headers, body,
        signal: AbortSignal.any([this.abort.signal, ...(signal ? [signal] : []), AbortSignal.timeout(60000)]) });
      const ack = await readBotAcknowledgement(response);
      if (!response.ok || ack.protocol !== contextWebhookProtocol || ack.eventId !== delivery.id || ack.status !== 'accepted') throw new WebhookError('bridge_ack_invalid');
      await this.write(state => { const found = state.botDeliveries.find(item => item.id === delivery.id)!; found.status = 'accepted'; found.result = ack.result; });
    } catch (error) {
      await this.write(state => { const found = state.botDeliveries.find(item => item.id === delivery.id)!; found.status = 'unknown'; found.code = serializeError(error); });
    }
    return this.botReceipt(this.state.botDeliveries.find(item => item.id === delivery.id)!);
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
        const connection = state.connections.find(c => c.id === request.id && owner(c.binding.sessionId) === owner(request.sessionId));
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
    if (config.id && (!previous || owner(previous.binding.sessionId) !== owner(binding.sessionId) || (previous.binding.kind !== binding.kind && !(previous.binding.kind === 'friends' && binding.kind === 'assistant')))) throw new WebhookError('binding_mismatch');
    if (!previous && state.connections.length >= 32) throw new WebhookError('connection_limit');
    // Friends resolves the current configuration at event activation; a bridge owns only the destination.
    if (binding.kind !== 'friends') {
      const parent = applyWebhookTurnPolicy({ ...binding.parent, inputMessages: [{ messageId: 'binding', message: { role: 'user' as const, content: 'Webhook binding' } }] });
      delete parent.supersession; binding = { ...binding, parent };
    }
    const next: Connection = { ...config, id: previous?.id ?? randomUUID(), token: previous?.token ?? randomBytes(32).toString('hex'),
      binding, lastReceivedAt: previous?.lastReceivedAt, lastDeliveredAt: previous?.lastDeliveredAt };
    if (previous && webhookHash([previous.url, previous.headers]) === webhookHash([config.url, config.headers])) next.bot = previous.bot;
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
      sessionId: owner(connection.binding.sessionId), title: connection.binding.title } };
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
        const capabilityPath = /^\/api\/webhooks\/v1\/([\w-]+)\/capabilities$/.exec(req.url ?? '');
        const match = capabilityPath ?? /^\/api\/webhooks\/v1\/([\w-]+)\/messages(?:\/([^/?]+))?$/.exec(req.url ?? '');
        const connection = match && this.state.connections.find(c => c.id === match[1] && c.enabled);
        if (!connection || req.headers.origin !== undefined) throw new WebhookError('unauthorized', 401);
        const wanted = Buffer.from(`Bearer ${connection.token}`), received = Buffer.from(req.headers.authorization ?? '');
        if (wanted.length !== received.length || !timingSafeEqual(wanted, received)) throw new WebhookError('unauthorized', 401);
        if (capabilityPath) {
          if (req.method === 'DELETE') {
            const input = z.object({ protocol: z.literal(contextWebhookProtocol), instanceId: z.string().uuid() }).strict().parse(await readWebhookJson(req, 1024));
            await this.write(state => { const current = state.connections.find(c => c.id === connection.id);
              if (current?.bot?.instanceId === input.instanceId) delete current.bot; });
            json(200, { protocol: contextWebhookProtocol, status: 'disconnected' }); return;
          }
          if (req.method !== 'POST') throw new WebhookError('endpoint_not_found', 404);
          const input = z.object({ protocol: z.literal(contextWebhookProtocol), capabilities: botCapabilitiesSchema,
            plugins: bridgePluginsSchema.optional(), instanceId: z.string().uuid().optional() }).strict().parse(await readWebhookJson(req, 256 * 1024));
          await this.write(state => { const current = state.connections.find(c => c.id === connection.id && c.enabled);
            if (!current) throw new WebhookError('bot_disconnected'); current.bot = { capabilities: input.capabilities, plugins: input.plugins,
              instanceId: input.instanceId, expiresAt: Date.now() + 45000 }; });
          json(200, { protocol: contextWebhookProtocol, status: 'connected', leaseSeconds: 45, features: ['bridge_plugins'] }); return;
        }
        if (req.method === 'GET' && !match![2]) {
          json(200, { protocol: contextWebhookProtocol, type: 'connection.info', sessionId: owner(connection.binding.sessionId), title: connection.binding.title }); return;
        }
        if (req.method === 'GET' && match![2]) {
          const messageId = decodeURIComponent(match![2]); const record = this.state.receipts.find(r => r.connectionId === connection.id && r.message.messageId === messageId);
          if (!record) throw new WebhookError('message_not_found', 404);
          json(200, this.receipt(record)); return;
        }
        if (req.method !== 'POST' || match![2]) throw new WebhookError('endpoint_not_found', 404);
        const body = await readWebhookJson(req);
        const message = incomingMessage(body, connection.incoming), fingerprint = webhookHash(message);
        const receipt = await this.write(async state => {
          const current = state.connections.find(c => c.id === connection.id && c.enabled);
          if (!current) throw new WebhookError('connection_disabled', 409);
          const existing = state.receipts.find(r => r.connectionId === connection.id && r.message.messageId === message.messageId);
          if (existing) { if (existing.fingerprint !== fingerprint) throw new WebhookError('message_id_conflict', 409); return this.receipt(existing); }
          if (state.receipts.filter(r => !terminal(r.status)).length >= 128) throw new WebhookError('queue_full', 429);
          // A connection survives Assistant resets and Runtime restarts. Only a new
          // message adopts the current context; queued/recovered receipts stay pinned.
          if (current.binding.kind === 'friends') {
            const assistant = await this.runtime.command(FRIENDS_COMMAND, { action: 'binding' });
            if (!assistant?.parent || !assistant.profile) throw new WebhookError('service_unavailable', 503);
            current.binding = { kind: 'assistant', sessionId: PERSONAL_ASSISTANT_SESSION,
              title: assistant.profile.name, parent: assistant.parent, profile: assistant.profile, generation: 0 };
          }
          if (current.binding.kind === 'assistant') {
            const { generation } = await this.runtime.command('runtime.assistant_conversation', {
              action: 'read', sessionId: current.binding.sessionId, after: Number.MAX_SAFE_INTEGER })
              .catch(() => { throw new WebhookError('service_unavailable', 503); });
            current.binding = { ...current.binding, generation };
          }
          const record: Receipt = { id: randomUUID(), connectionId: connection.id, message, fingerprint, binding: structuredClone(current.binding),
            status: 'accepted', reply: '', createdAt: new Date().toISOString(), delivered: false, sequence: 1, attempts: 0 };
          const outstanding = state.receipts.filter(r => !r.guidanceFor && !terminal(r.status) && r.binding.sessionId === record.binding.sessionId);
          const head = outstanding.find(r => this.running.has(r.id)) ??
            outstanding.find(r => state.connections.some(c => c.enabled && c.id === r.connectionId));
          if (head && record.binding.kind !== 'friends' && head.binding.kind === record.binding.kind &&
            head.binding.generation === record.binding.generation && head.connectionId === record.connectionId &&
            message.senderId && message.senderId === head.message.senderId && message.conversationId && message.conversationId === head.message.conversationId) {
            record.guidanceFor = head.id;
          }
          state.receipts.push(record); current.lastReceivedAt = record.createdAt;
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
      if (record.guidanceFor && !terminal(record.status)) {
        if (!this.guiding.has(record.guidanceFor)) {
          const target = record.guidanceFor;
          this.guiding.add(target);
          void this.guide(record, target).catch(() => {}).finally(() => {
            this.guiding.delete(target);
            const current = this.state.receipts.find(r => r.id === record.id);
            if (current && (terminal(current.status) || !current.guidanceFor)) this.pump();
          });
        }
        continue;
      }
      if (!terminal(record.status) && !this.workers.has(record.binding.sessionId)) {
        this.workers.add(record.binding.sessionId);
        void this.run(record).finally(() => { this.workers.delete(record.binding.sessionId); });
      } else if (terminal(record.status) && !record.delivered && (record.nextDelivery ?? 0) <= Date.now() && !this.deliveries.has(record.id)) {
        this.deliveries.add(record.id); void this.deliver(record, connection).finally(() => this.deliveries.delete(record.id));
      }
    }
  }
  private async guide(record: Receipt, targetId: string) {
    const previousAttempt = record.status === 'running';
    const target = this.state.receipts.find(r => r.id === targetId);
    const sessionId = record.binding.sessionId, turnId = `webhook-${targetId}`, messageId = `webhook-input-${record.id}`;
    // Persist the reservation before RPC. After a crash an uncertain append must
    // never turn into an independent request with the same side effects.
    await this.write(state => { const item = state.receipts.find(r => r.id === record.id)!; item.status = 'running'; });
    let accepted = false, unknown = false;
    try {
      if (target && (!terminal(target.status) || previousAttempt)) {
        const receipt = await this.runtime.command('runtime.enqueue_guidance', {
          protocol: 'bush.runtime_guidance.v1', sessionId, turnId, messageId, content: record.message.text,
          mode: 'interrupt_and_continue', createdAt: record.createdAt,
          metadata: record.binding.kind !== 'friends' && !record.binding.parent.metadata.environmentContext ? {
            webhookContext: botContextMessage(this.botContext(sessionId, `webhook:${record.id}`), `webhook:${record.id}`),
          } : undefined,
          webhook: { targetReceiptId: targetId, receiptId: record.id, generation: record.binding.kind === 'assistant' ? record.binding.generation : undefined,
            messageId: record.message.messageId, senderId: record.message.senderId, conversationId: record.message.conversationId },
        });
        accepted = receipt?.accepted === true;
        if (!accepted && receipt?.accepted !== false) unknown = true;
      }
    } catch { unknown = true; }
    if (this.abort.signal.aborted) return;
    await this.write(state => {
      const item = state.receipts.find(r => r.id === record.id)!;
      const currentTarget = state.receipts.find(r => r.id === targetId);
      if (accepted) {
        const language = item.binding.kind !== 'friends' ? item.binding.parent.metadata.uiLanguage : undefined;
        Object.assign(item, { status: 'completed', reply: uiText(resolveUiLanguage(language))('webhook.guidanceAccepted') });
      } else if (unknown || previousAttempt) {
        Object.assign(item, { status: 'interrupted', errorCode: 'guidance_submission_unknown' });
      } else {
        // The model may not have started yet, or may have finished between
        // receipt admission and RPC. Only a definitive rejection permits fallback.
        item.status = 'accepted';
        if (!currentTarget || terminal(currentTarget.status)) delete item.guidanceFor;
      }
      item.sequence++;
    });
  }
  private async run(record: Receipt) {
    const recovering = record.status === 'running' && !this.running.has(record.id);
    this.running.add(record.id);
    try {
      await this.write(state => { const r = state.receipts.find(r => r.id === record.id)!; r.status = 'running'; r.sequence++; });
      const result = await (this.options.execute ?? runContextWebhook)(this.runtime, record.binding, record.message, record.id, recovering, this.abort.signal, `webhook:${record.id}`,
        { connectionId: record.connectionId, createdAt: record.createdAt });
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
    const records = this.state.receipts.filter(r => r.binding.kind === 'assistant' && !r.guidanceFor);
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
      if (record.status !== 'completed' || record.binding.kind !== 'assistant' || record.binding.generation !== journal.generation
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
