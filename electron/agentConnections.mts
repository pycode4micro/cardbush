import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { AgentHttpClient, AgentHttpError, AgentIdentityError, AgentNetworkError, agentBaseUrl } from './agentHttpClient.mjs';
import type { AgentInfo, AgentOperation, AgentConnection, AgentConnectionInput, AgentDesktopApi, AgentEventRequest } from './agentTypes.js';
import type { SshConnectionManager } from './sshConnections.mjs';
import type { SshTunnel } from './sshTunnel.mjs';
type Saved = Omit<AgentConnection, 'hasToken' | 'connected' | 'info' | 'connectionState' | 'connectionError'> & { token?: string; legacyLaunch?: Record<string, unknown> };
type Live = { client: AgentHttpClient; info: AgentInfo };
type Entry = { promise: Promise<Live>; abort: AbortController; client?: AgentHttpClient; tunnel?: SshTunnel };
const tunnelSchema = z.object({ connectionId: z.string().min(1), remoteHost: z.enum(['127.0.0.1', 'localhost', '::1']), remotePort: z.number().int().min(1).max(65535) }).strict();
function sshAgentUrl(tunnel: z.infer<typeof tunnelSchema>, previousUrl?: string) {
  const url = new URL(`http://${tunnel.remoteHost === '::1' ? '[::1]' : tunnel.remoteHost}:${tunnel.remotePort}/`);
  // Preserve an existing service path while discarding the obsolete local port.
  if (previousUrl) url.pathname = new URL(agentBaseUrl(previousUrl)).pathname;
  return url.href;
}
/** All Agent hosts use HTTP; desktop Runtime IPC and plugin MCP stay independent. */
export class AgentConnectionManager implements Omit<AgentDesktopApi, 'watchEvents' | 'filePreview' | 'releaseFilePreview'> {
  #clients = new Map<string, Entry>();
  #live = new Map<string, Live>();
  #desired = new Set<string>();
  #managed = new Set<string>();
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #attempts = new Map<string, number>();
  #errors = new Map<string, string>();
  #writes: Promise<unknown> = Promise.resolve();
  #closing = false;
  constructor(readonly path: string, readonly cipher: { encrypt(value: string): string; decrypt(value: string): string },
    readonly options: { ssh?: Pick<SshConnectionManager, 'list' | 'tunnel'>; reconnectDelayMs?: number; healthIntervalMs?: number } = {}) {}
  /** Restore saved managed tunnels without delaying desktop startup. */
  async restore() {
    if (this.#closing) return;
    for (const item of await this.#read()) if (item.sshTunnel && !item.migrationIssue && !this.#closing) void this.connect(item.id).catch(() => undefined);
  }
  async #read(): Promise<Saved[]> {
    const raw = await readFile(this.path, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return '[]'; throw error; });
    const items = JSON.parse(raw); if (!Array.isArray(items)) throw new Error('Invalid Agent connection store.');
    return items.map(item => {
      if (item.transport === 'stdio') {
        const { command, args, cwd, ...rest } = item;
        return { ...rest, transport: 'http', url: '', legacyLaunch: { command, args, cwd },
          migrationIssue: '此连接原先使用 stdio。请先将 Agent 启动为 HTTP 服务，再重新添加连接；原服务数据保留。' };
      }
      return { ...item, transport: 'http', url: item.sshTunnel ? sshAgentUrl(tunnelSchema.parse(item.sshTunnel), item.url) : item.url ? agentBaseUrl(item.url) : '' };
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
      sshTunnel: item.sshTunnel, agentId: item.agentId, migrationIssue: item.migrationIssue, hasToken: Boolean(item.token),
      connected: this.#live.has(item.id), info: this.#live.get(item.id)?.info,
      connectionState: this.#live.has(item.id) ? 'connected' : this.#desired.has(item.id) && this.#managed.has(item.id) && this.#errors.has(item.id)
        ? 'reconnecting' : this.#clients.has(item.id) ? 'connecting' : 'disconnected', connectionError: this.#errors.get(item.id) }));
  }
  async save(input: AgentConnectionInput) {
    const value = z.object({ id: z.string().optional(), name: z.string().trim().min(1).max(100), transport: z.literal('http'),
      url: z.string().min(1).optional(), token: z.string().optional(), sshTunnel: tunnelSchema.nullable().optional(),
    }).strict().parse(input);
    if (value.sshTunnel) {
      if (!this.options.ssh || !(await this.options.ssh.list()).some(item => item.id === value.sshTunnel!.connectionId)) throw Error('请选择已保存的 SSH 连接。');
    }
    await this.#change(items => {
      const old = items.find(item => item.id === value.id);
      if (value.id && !old) throw new Error('Agent connection was removed.');
      const sshTunnel = value.sshTunnel === undefined ? old?.sshTunnel : value.sshTunnel ?? undefined;
      if (!sshTunnel && !value.url) throw Error('请填写 Agent 服务地址。');
      const url = sshTunnel ? sshAgentUrl(tunnelSchema.parse(sshTunnel), old?.sshTunnel ? old.url : undefined) : agentBaseUrl(value.url!);
      if (old && !old.sshTunnel && old.url !== url && !sshTunnel) throw new Error('Add a new connection when changing its endpoint.');
      const token = value.token === undefined || value.token === '' ? old?.token : this.cipher.encrypt(value.token);
      if (!token) throw new Error('Enter the Agent access token.');
      const item: Saved = { ...value, url, id: old?.id ?? randomUUID(), agentId: old?.agentId, token, sshTunnel };
      return [...items.filter(item => item.id !== old?.id), item];
    });
    if (value.id) await this.disconnect(value.id);
    return this.list();
  }
  async remove(id: string) { await this.disconnect(id); await this.#change(items => items.filter(item => item.id !== id)); return this.list(); }
  async #connection(id: string): Promise<Live> {
    if (this.#closing) throw new Error('Agent connections are closing.');
    const current = this.#clients.get(id); if (current) return current.promise;
    this.#clearTimer(id);
    const entry: Entry = { abort: new AbortController(), promise: undefined! };
    this.#clients.set(id, entry);
    const assertCurrent = () => { entry.abort.signal.throwIfAborted(); if (this.#clients.get(id) !== entry || this.#closing) throw Error('Agent connection was closed.'); };
    entry.promise = (async () => {
      const saved = (await this.#read()).find(item => item.id === id);
      assertCurrent();
      if (!saved) throw new Error('Unknown Agent connection.');
      if (saved.migrationIssue) throw new Error(saved.migrationIssue);
      if (!saved.token) throw new Error('Enter the Agent access token.');
      const endpoint = new URL(saved.url);
      if (saved.sshTunnel) {
        this.#managed.add(id);
        const tunnel = tunnelSchema.parse(saved.sshTunnel);
        if (!this.options.ssh) throw Error('SSH 隧道管理不可用。');
        entry.tunnel = await this.options.ssh.tunnel(tunnel.connectionId, tunnel.remoteHost, tunnel.remotePort, entry.abort.signal);
        void entry.tunnel.closed.then(() => this.#failed(id, entry, Error('SSH 隧道已断开，正在重新连接。')));
        assertCurrent();
      }
      const client = entry.client = new AgentHttpClient(endpoint.href, this.cipher.decrypt(saved.token), saved.agentId, entry.tunnel?.connect);
      const info = await client.info();
      assertCurrent();
      await this.#change(items => items.map(item => item.id === id ? { ...item, agentId: info.id } : item));
      assertCurrent();
      const live = { client, info }; this.#live.set(id, live); this.#errors.delete(id); this.#attempts.delete(id);
      this.#health(id, entry);
      return live;
    })().catch(error => { this.#failed(id, entry, error); throw error; });
    return entry.promise;
  }
  #clearTimer(id: string) { clearTimeout(this.#timers.get(id)); this.#timers.delete(id); }
  #timer(id: string, delay: number, run: () => void) {
    this.#clearTimer(id);
    const timer = setTimeout(() => { this.#timers.delete(id); run(); }, delay); timer.unref(); this.#timers.set(id, timer);
  }
  #health(id: string, entry: Entry) {
    if (!this.#managed.has(id) || !this.#desired.has(id) || this.#closing) return;
    this.#timer(id, this.options.healthIntervalMs ?? 15_000, () => {
      void entry.client!.info().then(() => {
        if (this.#clients.get(id) === entry) this.#health(id, entry);
      }, error => this.#failed(id, entry, error));
    });
  }
  #failed(id: string, entry: Entry, error: unknown) {
    if (this.#clients.get(id) !== entry) return;
    this.#clients.delete(id); this.#live.delete(id); this.#clearTimer(id);
    entry.abort.abort(); entry.client?.close();
    const closed = entry.tunnel?.close() ?? Promise.resolve();
    this.#errors.set(id, error instanceof Error ? error.message : String(error));
    const detail = error as { fingerprint?: string; level?: string; code?: string } | undefined;
    if (error instanceof AgentIdentityError || error instanceof z.ZodError || detail?.fingerprint ||
        detail?.level === 'client-authentication' || detail?.code === 'ENOENT' ||
        (error instanceof AgentHttpError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status))) {
      this.#desired.delete(id); // Credentials or identity require correction, not repeated login attempts.
    }
    if (!this.#closing && this.#desired.has(id) && this.#managed.has(id)) {
      const attempts = this.#attempts.get(id) ?? 0; this.#attempts.set(id, attempts + 1);
      this.#timer(id, Math.min(30_000, (this.options.reconnectDelayMs ?? 1_000) * 2 ** Math.min(attempts, 5)), () => {
        void closed.then(() => {
          if (!this.#closing && this.#desired.has(id)) return this.#connection(id);
        }).catch(() => undefined);
      });
    }
  }
  async connect(id: string) { if (this.#closing) throw Error('Agent connections are closing.'); this.#desired.add(id); return (await this.#connection(id)).info; }
  async disconnect(id: string) {
    this.#desired.delete(id); this.#managed.delete(id); this.#clearTimer(id); this.#attempts.delete(id); this.#errors.delete(id);
    const entry = this.#clients.get(id); this.#clients.delete(id); this.#live.delete(id);
    entry?.abort.abort(); entry?.client?.close(); await entry?.tunnel?.close();
    await entry?.promise.catch(() => undefined);
  }
  async call(id: string, operation: AgentOperation, input: Record<string, unknown> = {}) {
    this.#desired.add(id);
    const { client } = await this.#connection(id);
    // Never replay a failed mutation. chat.send is explicitly deduplicated by requestId.
    try { return await client.call(operation, input); }
    catch (error) { const entry = this.#clients.get(id); if (error instanceof AgentNetworkError && entry?.client === client) this.#failed(id, entry, error); throw error; }
  }
  async *events(id: string, input: AgentEventRequest, signal: AbortSignal, format: 'sse' | 'ndjson' = 'sse') {
    this.#desired.add(id);
    const { client } = await this.#connection(id);
    yield* client.events(input, signal, format);
  }
  async close() { this.#closing = true; await Promise.allSettled([...new Set([...this.#clients.keys(), ...this.#desired])].map(id => this.disconnect(id))); await this.#writes; }
}
