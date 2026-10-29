import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { assertConnectorFile, secureConnectorResource, writeConnectorFile } from './browserConnectorFiles.js';
import { handleMcpHostRequest } from './mcpHostBridge.js';
import { SiwcError, safeSiwcError } from './siwcOAuth.mjs';

const protocol = 'cardbush.local-model-access.v1';
const maxBytes = 64 * 1024;
const payloadSchema = z.object({ accountId: z.string().uuid(), rejectedToken: z.string().max(16384).optional() }).strict();
type Payload = z.infer<typeof payloadSchema>;
const unavailable = () => Object.assign(new Error('Open CardBush App on this computer to use its signed-in ChatGPT account, then retry.'), { code: 'siwc_desktop_unavailable' });
const cancelled = () => new SiwcError('ChatGPT request cancelled.');
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const send = (socket: Socket, value: unknown) => { if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n'); };

function lines(socket: Socket, receive: (message: Record<string, unknown>) => void) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > maxBytes) { socket.destroy(); return; }
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { receive(object(JSON.parse(line))); } catch { socket.destroy(); return; }
    }
  });
}
async function bridgeDirectory(profile: string, create = false) {
  const root = await realpath(profile), directory = join(root, 'model-access');
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink() || dirname(await realpath(directory)) !== root) throw unavailable();
  return directory;
}

/** The GUI remains the single credential/refresh owner. This private local IPC
 * serves access tokens only, never registrations, refresh tokens or arbitrary
 * desktop commands. It has no HTTP listener or remote-service entry point. */
export class LocalModelAccessBroker {
  readonly #token = randomBytes(32).toString('hex');
  readonly #server = createServer();
  readonly #peers = new Map<Socket, { authenticated: boolean; pending: Map<string, AbortController> }>();
  #endpoint = '';
  #file = '';
  #closed = false;
  constructor(readonly access: (payload: Payload, signal: AbortSignal) => Promise<string>) {}
  async start(profile: string, nativeHostPath: string) {
    const directory = await bridgeDirectory(profile, true);
    if (process.platform === 'win32') secureConnectorResource(nativeHostPath, 'directory', directory);
    else await chmod(directory, 0o700);
    const id = randomBytes(16).toString('hex');
    this.#endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\cardbush-model-access-${id}` : join(directory, `access-${id}.sock`);
    this.#file = join(directory, 'bridge.json');
    this.#server.on('connection', socket => this.#accept(socket));
    this.#server.on('error', () => { /* Startup rejects below; established peers handle disconnects. */ });
    try {
      await new Promise<void>((done, fail) => {
        this.#server.once('error', fail);
        this.#server.listen(this.#endpoint, () => { this.#server.off('error', fail); done(); });
      });
      if (process.platform === 'win32') secureConnectorResource(nativeHostPath, 'pipe', this.#endpoint);
      else await chmod(this.#endpoint, 0o600);
      writeConnectorFile(this.#file, JSON.stringify({ protocol, endpoint: this.#endpoint, token: this.#token }));
    } catch (error) { await this.close(); throw error; }
  }
  #accept(socket: Socket) {
    if (this.#closed || this.#peers.size >= 64) { socket.destroy(); return; }
    const peer = { authenticated: false, pending: new Map<string, AbortController>() };
    this.#peers.set(socket, peer);
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => { this.#peers.delete(socket); for (const abort of peer.pending.values()) abort.abort(); });
    lines(socket, message => {
      if (!peer.authenticated) {
        if (message.protocol !== protocol || message.type !== 'hello' || typeof message.token !== 'string' ||
            !/^[a-f0-9]{64}$/.test(message.token) || !timingSafeEqual(Buffer.from(message.token), Buffer.from(this.#token))) { socket.destroy(); return; }
        peer.authenticated = true; socket.setTimeout(0); send(socket, { protocol, type: 'ready' }); return;
      }
      if (message.protocol !== 'cardbush.mcp_host.v1' || typeof message.id !== 'string' || !z.string().uuid().safeParse(message.id).success) { socket.destroy(); return; }
      const id = message.id;
      if (message.type === 'cancel') { peer.pending.get(id)?.abort(); return; }
      const payload = payloadSchema.safeParse(message.payload);
      if (message.type !== 'request' || message.operation !== 'siwc.access-token' || !payload.success || peer.pending.has(id) || peer.pending.size >= 32) { socket.destroy(); return; }
      const abort = new AbortController(); peer.pending.set(id, abort);
      void handleMcpHostRequest({ protocol: 'cardbush.mcp_host.v1', type: 'request', id, operation: 'siwc.access-token', payload: payload.data }, abort.signal,
        async () => {
          try { return await this.access(payload.data, abort.signal); }
          catch (error) { throw new SiwcError(safeSiwcError(error), (error as { code?: string })?.code === 'siwc_auth_required'); }
        }).then(response => { if (!abort.signal.aborted) send(socket, response); }).finally(() => peer.pending.delete(id));
    });
  }
  invalidate(accountId: string) {
    for (const [socket, peer] of this.#peers) if (peer.authenticated) send(socket, { protocol, type: 'invalidated', accountId });
  }
  async close() {
    if (this.#closed) return; this.#closed = true;
    for (const [socket, peer] of this.#peers) { for (const abort of peer.pending.values()) abort.abort(); socket.destroy(); }
    await new Promise<void>(done => this.#server.close(() => done()));
    if (this.#file) {
      try { if (JSON.parse(await readFile(this.#file, 'utf8')).token === this.#token) await rm(this.#file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (this.#endpoint && process.platform !== 'win32') await rm(this.#endpoint, { force: true });
  }
}

export interface LocalModelAccess {
  access(payload: unknown, signal: AbortSignal): Promise<string>;
  onInvalidated(listener: (accountId: string) => void): () => void;
}

/** Lazy: API-key CLI sessions never need the desktop. Re-read the descriptor
 * on reconnect; a restarted GUI rotates its transport secret. */
export class LocalModelAccessClient implements LocalModelAccess {
  #connection?: Promise<Socket>;
  #socket?: Socket;
  #closed = false;
  #pending = new Map<string, { accountId: string; resolve: (token: string) => void; reject: (error: Error) => void }>();
  #accounts = new Set<string>();
  #listeners = new Set<(accountId: string) => void>();
  constructor(readonly profile: string) {}
  onInvalidated(listener: (accountId: string) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #invalidate(accountId: string) {
    for (const pending of this.#pending.values()) if (pending.accountId === accountId) pending.reject(new SiwcError('This ChatGPT account changed. Retry with its current authorization.', true));
    for (const listener of this.#listeners) listener(accountId);
  }
  async #connect(): Promise<Socket> {
    if (this.#closed) throw unavailable();
    if (this.#connection) return this.#connection;
    const connect = async () => {
      const directory = await bridgeDirectory(this.profile);
      const file = join(directory, 'bridge.json'); assertConnectorFile(file);
      if ((await lstat(file)).size > 8192) throw unavailable();
      const data = z.object({ protocol: z.literal(protocol), endpoint: z.string(), token: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(JSON.parse(await readFile(file, 'utf8')));
      if (process.platform === 'win32' ? !/^\\\\\.\\pipe\\cardbush-model-access-[a-f0-9]{32}$/.test(data.endpoint)
        : dirname(resolve(data.endpoint)) !== directory || !/[/]access-[a-f0-9]{32}\.sock$/.test(data.endpoint)) throw unavailable();
      if (this.#closed) throw unavailable();
      return new Promise<Socket>((done, fail) => {
        const socket = this.#socket = createConnection(data.endpoint);
        let ready = false;
        const timer = setTimeout(() => socket.destroy(), 5000);
        socket.on('error', () => {});
        socket.once('connect', () => send(socket, { protocol, type: 'hello', token: data.token }));
        socket.once('close', () => {
          clearTimeout(timer);
          if (this.#socket === socket) { this.#socket = undefined; this.#connection = undefined; }
          if (ready) {
            for (const accountId of this.#accounts) this.#invalidate(accountId);
            this.#accounts.clear();
          }
          for (const pending of this.#pending.values()) pending.reject(unavailable());
          this.#pending.clear(); fail(unavailable());
        });
        lines(socket, message => {
          if (!ready) {
            if (message.protocol !== protocol || message.type !== 'ready') { socket.destroy(); return; }
            ready = true; clearTimeout(timer); done(socket); return;
          }
          if (message.protocol === protocol && message.type === 'invalidated' && z.string().uuid().safeParse(message.accountId).success) { this.#invalidate(String(message.accountId)); return; }
          if (message.protocol !== 'cardbush.mcp_host.v1' || message.type !== 'response' || typeof message.id !== 'string') { socket.destroy(); return; }
          const pending = this.#pending.get(message.id);
          if (!pending) return;
          if (typeof message.error === 'string') pending.reject(Object.assign(new Error(message.error.slice(0, 1000)),
            { code: message.errorCode === 'siwc_auth_required' ? 'siwc_auth_required' : 'siwc_unavailable' }));
          else if (typeof message.result === 'string' && message.result && message.result.length <= 16384) pending.resolve(message.result);
          else pending.reject(unavailable());
        });
      });
    };
    const connection = connect(); this.#connection = connection;
    try { return await connection; }
    catch { if (this.#connection === connection) this.#connection = undefined; throw unavailable(); }
  }
  async access(input: unknown, signal: AbortSignal) {
    const payload = payloadSchema.parse(input); signal.throwIfAborted();
    const socket = await this.#connect(); signal.throwIfAborted();
    if (socket.destroyed || this.#closed) throw unavailable();
    this.#accounts.add(payload.accountId);
    const id = randomUUID();
    const abort = () => { this.#pending.get(id)?.reject(cancelled()); send(socket, { protocol: 'cardbush.mcp_host.v1', type: 'cancel', id }); };
    const timer = setTimeout(abort, 120_000);
    try { return await new Promise<string>((resolve, reject) => {
      this.#pending.set(id, { accountId: payload.accountId, resolve, reject });
      signal.addEventListener('abort', abort, { once: true });
      send(socket, { protocol: 'cardbush.mcp_host.v1', type: 'request', id, operation: 'siwc.access-token', payload });
    }); } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); this.#pending.delete(id); }
  }
  close() { this.#closed = true; this.#socket?.destroy(); this.#listeners.clear(); }
}
