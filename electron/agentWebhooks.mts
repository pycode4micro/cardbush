import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { protectSecret, unprotectSecret, secureConfigDirectory, assertPrivateConfigFile } from '@cardbush/platform/credentials';
import { ContextWebhookHost } from './contextWebhookHost.mjs';
import { contextWebhookPort } from './contextWebhookDefaults.js';
import { writePrivateJson } from './atomicJsonFile.mjs';
import type { ContextWebhookSnapshot, WebhookBinding } from './contextWebhookTypes.js';
import type { runContextWebhook, WebhookRuntime } from './contextWebhookRuntime.mjs';

/** Shared App protocol; this adapter owns only headless lifetime and management. */
export class AgentWebhooks {
  #host?: Promise<ContextWebhookHost>;
  #commands: Promise<unknown> = Promise.resolve();
  #closed = false;
  constructor(readonly root: string, readonly runtime: WebhookRuntime, readonly execute: typeof runContextWebhook, readonly port?: number) {}
  get keepAlive() { return Boolean(this.#host); }
  async restore() {
    const config = await readFile(join(this.root, 'webhooks', 'host.json'), 'utf8').then(JSON.parse,
      (error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return null; });
    if (config?.enabled === true) await this.start();
  }
  private start(): Promise<ContextWebhookHost> {
    if (this.#closed) return Promise.reject(Error('webhook_host_closed'));
    return this.#host ??= (async () => {
      const directory = join(this.root, 'webhooks'); secureConfigDirectory(directory); assertPrivateConfigFile(join(directory, 'state.json'));
      const host = new ContextWebhookHost(this.root, { encrypt: protectSecret, decrypt: unprotectSecret }, this.runtime,
        { execute: this.execute, ...(this.port === undefined ? {} : { port: this.port }) });
      try { await host.start(); await writePrivateJson(join(directory, 'host.json'), { enabled: true }); return host; }
      catch (error) { await host.close(); this.#host = undefined; throw error; }
    })();
  }
  async botRequest(input: unknown, signal?: AbortSignal) {
    if (this.#host) return (await this.#host).botRequest(input, signal);
    if ((input as { action?: string })?.action === 'catalog') return [];
    return (input as { action?: string })?.action === 'context'
      ? { discovery: 'mcp_search', available: false, reason: 'bot_not_connected', targets: [] }
      : { status: 'unavailable', code: 'bot_not_connected' };
  }
  command(input: unknown, binding: () => Promise<WebhookBinding>) {
    const task = this.#commands.then(() => this.manage(input, binding)); this.#commands = task.catch(() => {}); return task;
  }
  private async manage(input: unknown, binding: () => Promise<WebhookBinding>) {
    const request = z.object({ action: z.enum(['read', 'start', 'stop', 'connect', 'disconnect', 'listener']), sessionId: z.string().min(1).max(160),
      id: z.string().uuid().optional(), port: z.number().int().min(1024).max(65535).optional() }).strict().parse(input);
    if (this.#closed) throw Error('webhook_host_closed');
    if (request.action === 'stop') {
      secureConfigDirectory(join(this.root, 'webhooks')); await writePrivateJson(join(this.root, 'webhooks', 'host.json'), { enabled: false });
      const host = this.#host; this.#host = undefined; await (await host)?.close();
    } else if (request.action !== 'read') await this.start();
    const host = await this.#host;
    if (!host) return { enabled: false, listening: false, host: '127.0.0.1', port: this.port ?? contextWebhookPort, connections: [], pairings: [] };
    if (request.action === 'listener') {
      if (!request.port) throw Error('invalid_port');
      await host.command({ action: 'listener', sessionId: request.sessionId, host: '127.0.0.1', port: request.port });
    }
    if (request.action === 'connect') {
      if (!(await host.command({ action: 'read', sessionId: request.sessionId }) as ContextWebhookSnapshot).listening) throw Error('listener_failed');
      if (!request.id) throw Error('pairing_required');
      await host.command({ action: 'approve_pairing', requestId: request.id, binding: await binding() });
    }
    if (request.action === 'disconnect') {
      if (!request.id) throw Error('connection_required');
      await host.command({ action: 'delete', sessionId: request.sessionId, id: request.id });
    }
    const state = await host.command({ action: 'read', sessionId: request.sessionId }) as ContextWebhookSnapshot;
    // Management clients never need tokens, callback headers or request templates.
    return { enabled: true, listening: state.listening, host: state.host, port: state.port, error: state.error,
      connections: state.connections.map(c => ({ id: c.id, name: c.name, enabled: c.enabled, pending: c.pending })),
      pairings: state.pairings.map(p => ({ requestId: p.requestId, name: p.name })) };
  }
  async close() { this.#closed = true; await this.#commands; await (await this.#host)?.close(); this.#host = undefined; }
}
