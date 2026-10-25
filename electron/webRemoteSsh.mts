import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { Client } from 'ssh2';
import { z } from 'zod';
import { AgentHttpClient, AgentNetworkError } from './agentHttpClient.mjs';
import { openSshTunnel } from './sshTunnel.mjs';
import { WebError } from './webCommon.mjs';

export const remoteSshSchema = z.object({
  host: z.string().trim().min(1).max(253).regex(/^[a-zA-Z0-9.:_-]+$/),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).max(128).regex(/^[^\s\0\r\n]+$/),
  authentication: z.enum(['key', 'password']),
  privateKey: z.string().max(32000).optional(), passphrase: z.string().max(8192).optional(),
  password: z.string().max(8192).optional(),
  fingerprint: z.string().regex(/^(?:SHA256:[A-Za-z0-9+/]{43})?$/).default(''),
  remotePort: z.number().int().min(1).max(65535).default(4780),
}).strict();
export type RemoteSsh = z.infer<typeof remoteSshSchema>;
export type RemoteSshView = Omit<RemoteSsh, 'privateKey' | 'passphrase' | 'password'> & { hasPrivateKey: boolean; hasPassphrase: boolean; hasPassword: boolean };
export function remoteSshView(ssh: RemoteSsh): RemoteSshView {
  const { privateKey, passphrase, password, ...publicFields } = ssh;
  return { ...publicFields, hasPrivateKey: Boolean(privateKey), hasPassphrase: Boolean(passphrase), hasPassword: Boolean(password) };
}
export function blockedRemoteAddress(address: string) {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (ip.includes(':')) return ip === '::' || ip === '::1' || ip.startsWith('::ffff:') || /^fe[89ab]/.test(ip) || ip.startsWith('ff');
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 127 || a === 169 && b === 254 || a >= 224;
}
export class RemoteSshTrustRequired extends WebError {
  constructor(readonly fingerprint: string) { super(400, '请先核对 SSH 服务器指纹，再确认信任并检测连接。'); }
}

/** Only authenticated direct-tcpip channels to the remote loopback Agent.
 * No local listener, shell, SFTP, agent forwarding, process creation or deployment. */
export async function createSshRemoteClient(connection: { ssh: RemoteSsh; token: string; agentId?: string }) {
  const ssh = remoteSshSchema.parse(connection.ssh);
  if (/^(localhost|.*\.localhost)$/i.test(ssh.host) || blockedRemoteAddress(ssh.host))
    throw new WebError(400, 'SSH 服务器必须是远程地址，禁止本机和链路本地地址。');
  const addresses = await lookup(ssh.host, { all: true }).catch(() => { throw new WebError(400, '无法解析 SSH 服务器地址。'); });
  if (!addresses.length || addresses.some(item => blockedRemoteAddress(item.address)))
    throw new WebError(400, 'SSH 服务器解析到了禁止连接的地址。');
  return reconnectingSshRemoteClient(() => connectSshRemoteClient(connection, addresses[0].address));
}

/** Reconnect only for the next operation. Never replay a mutation here: native
 * delegation owns idempotent task IDs and event cursors after an uncertain reply. */
export async function reconnectingSshRemoteClient(open: () => ReturnType<typeof connectSshRemoteClient>) {
  let current = await open(), stopped = false;
  let pending: ReturnType<typeof connectSshRemoteClient> | undefined;
  const get = async () => {
    if (stopped) throw new Error('SSH connection closed.');
    if (current.isClosed()) {
      pending ??= open().then(next => { current = next; if (stopped) { next.close(); throw new Error('SSH connection closed.'); } return next; }).finally(() => { pending = undefined; });
      return pending;
    }
    return current;
  };
  const disconnected = (error: unknown, client: typeof current) => {
    if (!stopped && client.isClosed()) return new AgentNetworkError('SSH disconnected; resume the original remote task.', { cause: error });
    return error;
  };
  return {
    async info(...args: Parameters<AgentHttpClient['info']>) { const client = await get(); try { return await client.info(...args); } catch (error) { throw disconnected(error, client); } },
    async call(...args: Parameters<AgentHttpClient['call']>) { const client = await get(); try { return await client.call(...args); } catch (error) { throw disconnected(error, client); } },
    async *events(...args: Parameters<AgentHttpClient['events']>) { const client = await get(); try { yield* client.events(...args); } catch (error) { throw disconnected(error, client); } },
    close() { stopped = true; current.close(); },
  };
}

// Internal transport primitive: caller must resolve and validate the pinned address.
// Exported for isolated local SSH fixture tests; never accepts web request bodies.
export async function connectSshRemoteClient(connection: { ssh: RemoteSsh; token: string; agentId?: string }, address: string) {
  const { ssh } = connection, client = new Client(), abort = new AbortController();
  let observed = '', ready = false;
  client.on('error', () => undefined);
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = () => {
        if (ready) return;
        if (observed && !ssh.fingerprint) reject(new RemoteSshTrustRequired(observed));
        else if (observed && observed !== ssh.fingerprint) reject(new WebError(409, 'SSH 服务器指纹已改变，连接已拒绝。请核实服务器身份后重新注册。'));
        else reject(new WebError(502, 'SSH 连接失败，请检查服务器、端口、用户名和认证凭据。'));
      };
      client.once('ready', () => { ready = true; resolve(); });
      client.once('error', fail); client.once('close', fail);
      client.connect({ host: address, port: ssh.port, username: ssh.username,
        ...(ssh.authentication === 'password' ? { password: ssh.password } : { privateKey: ssh.privateKey, passphrase: ssh.passphrase }),
        readyTimeout: 15_000, keepaliveInterval: 10_000, keepaliveCountMax: 3,
        hostVerifier: (key: Buffer) => {
          observed = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
          return Boolean(ssh.fingerprint) && observed === ssh.fingerprint;
        },
      });
    });
    const tunnel = await openSshTunnel(client, '127.0.0.1', ssh.remotePort, abort.signal);
    const http = new AgentHttpClient(`http://127.0.0.1:${ssh.remotePort}/`, connection.token, connection.agentId, tunnel.connect);
    let closed = false;
    const close = () => { if (closed) return; closed = true; http.close(); abort.abort(); void tunnel.close(); client.destroy(); };
    void tunnel.closed.then(close);
    return { info: http.info.bind(http), call: http.call.bind(http), events: http.events.bind(http), close, isClosed: () => closed };
  } catch (error) {
    abort.abort(); client.destroy();
    if (error instanceof WebError) throw error;
    throw new WebError(502, 'SSH 连接失败，请检查私钥格式、口令及服务器配置。');
  }
}
