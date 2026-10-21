import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { buildConnector } from 'undici';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AgentHttpClient } from './agentHttpClient.mjs';
import type { AgentInfo } from './agentTypes.js';
import { WebError } from './webCommon.mjs';
import type { ModelSettingsRepository } from './webModelSettings.mjs';

export const remoteAgentToken = (secret: string, userId: string) => createHmac('sha256', secret).update(`remote-agents:${userId}`).digest('hex');
export const remoteIdentity = (secret: string, ...parts: string[]) => createHmac('sha256', secret).update(JSON.stringify(parts)).digest('hex');
type Connection = { id: string; name: string; description: string; url: string; token: string; enabled: boolean; userIds: string[]; agentId: string; verifiedAt: string; boundUserId?: string; deleted?: boolean };
export type RemoteConnectionView = Omit<Connection, 'token'> & { hasToken: boolean };
export type RemoteClient = Pick<AgentHttpClient, 'info' | 'call' | 'events' | 'close'>;
export type RemoteClientFactory = (connection: Pick<Connection, 'url' | 'token'> & { agentId?: string }) => Promise<RemoteClient>;
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const inputSchema = z.object({
  id: identifier, name: z.string().trim().min(1).max(120), description: z.string().trim().max(1000).default(''),
  url: z.string().trim().url().max(2048), token: z.string().trim().max(8192).optional(),
  enabled: z.boolean(), userIds: z.array(identifier).max(1),
}).strict();
const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), revision: z.number().int().positive(), agent: inputSchema }).strict(),
  z.object({ action: z.literal('delete'), revision: z.number().int().positive(), id: identifier }).strict(),
  z.object({ action: z.literal('test'), agent: inputSchema }).strict(),
]);
function blockedAddress(address: string) {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (ip.includes(':')) return ip === '::' || ip === '::1' || ip.startsWith('::ffff:') || /^fe[89ab]/.test(ip) || ip.startsWith('ff');
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 127 || a === 169 && b === 254 || a >= 224;
}
function privateAddress(address: string) {
  const [a, b] = address.split('.').map(Number);
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || /^f[cd]/i.test(address);
}
export function remoteAgentUrl(value: string) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      /^(localhost|.*\.localhost)$/i.test(url.hostname) || blockedAddress(url.hostname))
    throw new WebError(400, '请填写远程 HTTP(S) Agent 地址，不支持本机地址、命令、SSH 或嵌入式凭据。');
  url.pathname = url.pathname.replace(/\/$/, '').replace(/\/api\/agent\/v1$/, '').replace(/\/$/, '') + '/';
  return url.href;
}
/** Resolve once and pin that address in the connector. Redirects are also disabled
 * by AgentHttpClient, so a registry entry cannot rebound into the local broker. */
export const createRemoteClient: RemoteClientFactory = async connection => {
  const url = new URL(remoteAgentUrl(connection.url));
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!addresses.length || addresses.some(item => blockedAddress(item.address)) ||
      url.protocol === 'http:' && addresses.some(item => !privateAddress(item.address)))
    throw new WebError(400, '远程公网服务需要 HTTPS；HTTP 仅支持内网地址，禁止本机和链路本地地址。');
  const address = addresses[0];
  const connector = buildConnector({ lookup: (_hostname, options, callback) => {
    if (typeof options === 'object' && options.all) callback(null, [address] as never);
    else callback(null, address.address, address.family);
  } });
  return new AgentHttpClient(url.href, connection.token, connection.agentId, connector);
};

export class PostgresRemoteAgentRepository implements ModelSettingsRepository {
  constructor(readonly pool: Pool) {}
  async initialize(payload: string) {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS cardbush_web_remote_agents (
      id integer PRIMARY KEY CHECK(id=1), revision integer NOT NULL, payload text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now())`);
    await this.pool.query('INSERT INTO cardbush_web_remote_agents(id,revision,payload) VALUES(1,1,$1) ON CONFLICT DO NOTHING', [payload]);
  }
  async read() { return (await this.pool.query('SELECT revision,payload FROM cardbush_web_remote_agents WHERE id=1')).rows[0]; }
  async replace(revision: number, payload: string) {
    return (await this.pool.query('UPDATE cardbush_web_remote_agents SET revision=revision+1,payload=$2,updated_at=now() WHERE id=1 AND revision=$1 RETURNING revision,payload', [revision, payload])).rows[0] ?? null;
  }
}

export class WebRemoteAgents {
  #revision = 0;
  #connections: Connection[] = [];
  readonly #key: Buffer;
  constructor(readonly secret: string, readonly repository: ModelSettingsRepository, readonly clientFactory: RemoteClientFactory = createRemoteClient) {
    this.#key = createHash('sha256').update('cardbush-web-remote-agents-v1\0').update(secret).digest();
  }
  #encrypt(value: Connection[]) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from('cardbush-web-remote-agents-v1'));
    const payload = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return [iv, cipher.getAuthTag(), payload].map(item => item.toString('base64')).join('.');
  }
  async initialize() { await this.repository.initialize(this.#encrypt([])); await this.refresh(); }
  async refresh() {
    const row = await this.repository.read();
    if (row.revision <= this.#revision) return;
    const [iv, tag, payload] = row.payload.split('.').map(item => Buffer.from(item, 'base64'));
    const cipher = createDecipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from('cardbush-web-remote-agents-v1')); cipher.setAuthTag(tag);
    const entries = JSON.parse(Buffer.concat([cipher.update(payload), cipher.final()]).toString('utf8')) as Connection[];
    if (!Array.isArray(entries)) throw new Error('Invalid remote Agent registry.');
    this.#connections = entries; this.#revision = row.revision;
  }
  view() { return { revision: this.#revision, agents: this.#connections.filter(item => !item.deleted).map(({ token, ...item }) => ({ ...item, hasToken: Boolean(token) })) }; }
  async list(userId: string) {
    await this.refresh();
    return this.#connections.filter(item => !item.deleted && item.enabled && item.userIds.includes(userId)).map(({ id, name, description, agentId }) => ({ id, name, description, agentId }));
  }
  async authorized(userId: string, id: string) {
    await this.refresh();
    const item = this.#connections.find(entry => !entry.deleted && entry.id === id && entry.enabled && entry.userIds.includes(userId));
    if (!item) throw new WebError(403, '该远程 Agent 未启用或未向此账号授权。');
    return { ...item };
  }
  async update(value: unknown, validUsers: Set<string>) {
    const command = commandSchema.parse(value);
    await this.refresh();
    if (command.action !== 'test' && command.revision !== this.#revision) throw new WebError(409, '远程 Agent 配置已变更，请刷新列表后重试。');
    const revision = this.#revision;
    let next = this.#connections.slice();
    if (command.action === 'delete') {
      if (!next.some(item => item.id === command.id)) throw new WebError(404, '远程 Agent 不存在。');
      // Keep only the identity binding after deletion: removing and re-registering
      // a connection must not hand another person's remote workspace to a new user.
      next = next.map(item => item.id === command.id ? { ...item, token: '', enabled: false, userIds: [], deleted: true } : item);
    } else {
      const input = command.agent, previous = next.find(item => item.id === input.id);
      if (previous?.deleted) throw new WebError(400, '该连接已删除，请使用新的连接标识。');
      const url = remoteAgentUrl(input.url);
      if (previous && url !== previous.url) throw new WebError(400, '已有连接的服务地址不可替换，请新增远程 Agent。');
      if (input.userIds.some(id => !validUsers.has(id))) throw new WebError(400, '授权人员已删除或不存在，请刷新人员列表。');
      if (previous?.boundUserId && input.userIds.some(id => id !== previous.boundUserId)) throw new WebError(403, '远程实例已经绑定人员。为其他人员部署独立实例和数据目录后再注册。');
      const token = input.token || previous?.token;
      if (!token) throw new WebError(400, '请填写远程 Agent 访问令牌。');
      // A disabled connection can be revoked while its remote host is offline.
      const verify = command.action === 'test' || input.enabled || !previous || Boolean(input.token);
      let info: AgentInfo | undefined;
      if (verify) {
        let client: RemoteClient | undefined;
        try {
          client = await this.clientFactory({ url, token, agentId: previous?.agentId });
          info = await client.info();
          if (info.capabilities.delegation !== true || info.capabilities.webRestricted === true) throw new WebError(400, '目标必须是支持远程委派的独立 CardBush Agent 服务。');
          if (previous && previous.agentId !== info.id) throw new WebError(409, '远程 Agent 身份已改变，请核实后新增连接。');
        } catch (error) {
          if (error instanceof WebError) throw error;
          throw new WebError(502, '无法验证远程 Agent，请检查服务地址、访问令牌、证书及服务版本。');
        } finally { client?.close(); }
      }
      const agentId = info?.id ?? previous!.agentId;
      const historical = next.filter(item => item.agentId === agentId && item.id !== input.id);
      if (historical.some(item => !item.deleted)) throw new WebError(409, '此远程 Agent 实例已经注册，请编辑已有连接。');
      const boundUserId = previous?.boundUserId ?? historical.find(item => item.boundUserId)?.boundUserId ?? input.userIds[0];
      if (boundUserId && input.userIds.some(id => id !== boundUserId)) throw new WebError(403, '此远程实例曾绑定其他人员，不能跨账号复用其文件和会话。请部署新的独立实例。');
      if (command.action === 'test') return { ok: true, agentId: info!.id, name: info!.name, delegation: true };
      const entry: Connection = { ...input, token, url, userIds: [...new Set(input.userIds)], agentId, boundUserId, verifiedAt: info ? new Date().toISOString() : previous!.verifiedAt };
      next = next.filter(item => item.id !== entry.id).concat(entry);
      if (next.filter(item => !item.deleted).length > 50) throw new WebError(400, '最多注册 50 个远程 Agent。');
    }
    const row = await this.repository.replace(revision, this.#encrypt(next));
    if (!row) throw new WebError(409, '远程 Agent 配置已变更，请刷新列表后重试。');
    await this.refresh(); return this.view();
  }
}
