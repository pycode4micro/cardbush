import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { AgentHttpClient, agentBaseUrl } from './agentHttpClient.mjs';
import type { AgentInfo, AgentOperation, AgentConnection, AgentConnectionInput, AgentDesktopApi, AgentEventRequest } from './agentTypes.js';
type Saved = Omit<AgentConnection, 'hasToken' | 'connected' | 'info'> & { token?: string; legacyLaunch?: Record<string, unknown> };
type Live = { client: AgentHttpClient; info: AgentInfo };
/** All Agent hosts use HTTP; desktop Runtime IPC and plugin MCP stay independent. */
export class AgentConnectionManager implements Omit<AgentDesktopApi, 'watchEvents'> {
  #clients = new Map<string, Promise<Live>>();
  #live = new Map<string, Live>();
  #writes: Promise<unknown> = Promise.resolve();
  #closing = false;
  constructor(readonly path: string, readonly cipher: { encrypt(value: string): string; decrypt(value: string): string }) {}
  async #read(): Promise<Saved[]> {
    const raw = await readFile(this.path, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return '[]'; throw error; });
    const items = JSON.parse(raw); if (!Array.isArray(items)) throw new Error('Invalid Agent connection store.');
    return items.map(item => {
      if (item.transport === 'stdio') {
        const { command, args, cwd, ...rest } = item;
        return { ...rest, transport: 'http', url: '', legacyLaunch: { command, args, cwd },
          migrationIssue: '此连接原先使用 stdio。请先将 Agent 启动为 HTTP 服务，再重新添加连接；原服务数据保留。' };
      }
      return { ...item, transport: 'http', url: item.url ? agentBaseUrl(item.url) : '' };
    });
  }
  #change(change: (items: Saved[]) => Saved[]) {
    const next = this.#writes.then(async () => {
      const items = change(await this.#read()); const temp = `${this.path}.${randomUUID()}.tmp`;
      await mkdir(dirname(this.path), { recursive: true });
      try { await writeFile(temp, JSON.stringify(items), { mode: 0o600, flag: 'wx' }); await rename(temp, this.path); }
      finally { await rm(temp, { force: true }); }
    });
    this.#writes = next.catch(() => undefined); return next;
  }
  async list(): Promise<AgentConnection[]> {
    return (await this.#read()).map(item => ({ id: item.id, name: item.name, transport: 'http', url: item.url,
      agentId: item.agentId, migrationIssue: item.migrationIssue, hasToken: Boolean(item.token), connected: this.#live.has(item.id), info: this.#live.get(item.id)?.info }));
  }
  async save(input: AgentConnectionInput) {
    const value = z.object({ id: z.string().optional(), name: z.string().trim().min(1).max(100), transport: z.literal('http'),
      url: z.string().min(1), token: z.string().optional(),
    }).strict().parse(input);
    value.url = agentBaseUrl(value.url);
    await this.#change(items => {
      const old = items.find(item => item.id === value.id);
      if (value.id && !old) throw new Error('Agent connection was removed.');
      if (old && old.url !== value.url) throw new Error('Add a new connection when changing its endpoint.');
      const token = value.token === undefined || value.token === '' ? old?.token : this.cipher.encrypt(value.token);
      if (!token) throw new Error('Enter the Agent access token.');
      const item: Saved = { ...value, id: old?.id ?? randomUUID(), agentId: old?.agentId, token };
      return [...items.filter(item => item.id !== old?.id), item];
    });
    if (value.id) await this.disconnect(value.id);
    return this.list();
  }
  async remove(id: string) { await this.disconnect(id); await this.#change(items => items.filter(item => item.id !== id)); return this.list(); }
  async #connection(id: string): Promise<Live> {
    if (this.#closing) throw new Error('Agent connections are closing.');
    const current = this.#clients.get(id); if (current) return current;
    let pending!: Promise<Live>;
    pending = (async () => {
      const saved = (await this.#read()).find(item => item.id === id);
      if (!saved) throw new Error('Unknown Agent connection.');
      if (saved.migrationIssue) throw new Error(saved.migrationIssue);
      if (!saved.token) throw new Error('Enter the Agent access token.');
      const client = new AgentHttpClient(saved.url, this.cipher.decrypt(saved.token), saved.agentId);
      try {
        const info = await client.info();
        if (this.#clients.get(id) !== pending || this.#closing) throw new Error('Agent connection was closed.');
        await this.#change(items => items.map(item => item.id === id ? { ...item, agentId: info.id } : item));
        if (this.#clients.get(id) !== pending || this.#closing) throw new Error('Agent connection was closed.');
        const live = { client, info }; this.#live.set(id, live); return live;
      } catch (error) { client.close(); throw error; }
    })();
    this.#clients.set(id, pending);
    try { return await pending; } catch (error) { if (this.#clients.get(id) === pending) this.#clients.delete(id); throw error; }
  }
  async connect(id: string) { return (await this.#connection(id)).info; }
  async disconnect(id: string) {
    const pending = this.#clients.get(id); this.#clients.delete(id); this.#live.delete(id);
    const live = await pending?.catch(() => undefined); live?.client.close();
  }
  async call(id: string, operation: AgentOperation, input: Record<string, unknown> = {}) {
    const { client } = await this.#connection(id);
    // Never replay a failed mutation. chat.send is explicitly deduplicated by requestId.
    return client.call(operation, input);
  }
  async *events(id: string, input: AgentEventRequest, signal: AbortSignal, format: 'sse' | 'ndjson' = 'sse') {
    const { client } = await this.#connection(id);
    yield* client.events(input, signal, format);
  }
  async close() { this.#closing = true; await Promise.allSettled([...this.#clients.keys()].map(id => this.disconnect(id))); await this.#writes; }
}
