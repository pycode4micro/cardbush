import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { AgentHttpClient } from './agentHttpClient.mjs';
import { equalSecret, json, readJson, tenantToken, WebError } from './webCommon.mjs';

export type BrokerConfig = { secret: string; image: string; network: string; prefix: string; maxActive?: number; idleMinutes?: number; memoryMiB?: number; port?: number };
type DockerContainer = { Image?: string; Id: string; Names: string[]; State: string; Labels: Record<string, string> };
/** Only this private control process has the Docker socket. Neither the website
 * nor any Agent container receives it, host paths, or container-management tools. */
export class DockerTenantBroker {
  #queue = Promise.resolve();
  readonly #lastUsed = new Map<string, number>();
  constructor(readonly config: BrokerConfig) {
    if (config.secret.length < 48 || !/^[a-z][a-z0-9-]{2,30}$/.test(config.prefix)) throw new Error('Invalid private broker configuration.');
  }
  async docker<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const request = httpRequest({ socketPath: '/var/run/docker.sock', path: `/v1.41${path}`, method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, response => {
        let raw = ''; response.setEncoding('utf8'); response.on('data', value => { raw += value; });
        response.on('end', () => {
          if ((response.statusCode ?? 500) >= 400) { reject(new WebError(response.statusCode === 404 ? 404 : 503, '会话运行服务暂不可用。')); return; }
          try { resolve(raw ? JSON.parse(raw) as T : undefined as T); } catch { reject(new Error('Invalid Docker response.')); }
        });
      });
      request.setTimeout(70_000, () => request.destroy(new Error('Container operation timed out.')));
      request.once('error', reject); request.end(data);
    });
  }
  async containers() {
    return this.docker<DockerContainer[]>('GET', `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [`cardbush.web.owner=${this.config.prefix}`] }))}`);
  }
  serial<T>(work: () => Promise<T>) {
    const operation = this.#queue.then(work); this.#queue = operation.then(() => undefined, () => undefined); return operation;
  }
  async idle(container: DockerContainer, minimumAge: number) {
    const key = container.Labels['cardbush.web.tenant'];
    if (!/^[a-f0-9]{64}$/.test(key) || Date.now() - (this.#lastUsed.get(key) ?? 0) < minimumAge) return false;
    const client = new AgentHttpClient(`http://${this.config.prefix}-${key.slice(0, 24)}:4780/`, tenantToken(this.config.secret, key));
    try {
      const jobs = await client.call('chat.jobs', {}) as Array<{ status: string }>;
      if (jobs.some(job => ['queued', 'running'].includes(job.status))) return false;
      const info = await client.info();
      if (info.capabilities.webRestricted) return !(await client.call('web.activity', {}) as { active: boolean }).active;
      return true;
    } catch { return false; } finally { client.close(); }
  }
  async ensure(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new WebError(400, 'Invalid tenant identity.');
    return this.serial(async () => {
      const containers = await this.containers();
      let existing = containers.find(item => item.Labels['cardbush.web.tenant'] === key);
      const name = `${this.config.prefix}-${key.slice(0, 24)}`;
      if (existing && existing.Image !== this.config.image) {
        if (existing.State === 'running' && !await this.idle(existing, 0)) throw new WebError(503, '会话正在执行，完成后将自动更新服务。');
        if (existing.State === 'running') await this.docker('POST', `/containers/${existing.Id}/stop?t=30`);
        await this.docker('DELETE', `/containers/${existing.Id}`); existing = undefined;
      }
      if (existing?.State !== 'running') {
        const active = containers.filter(item => item.State === 'running');
        if (active.length >= (this.config.maxActive ?? 3)) {
          const ordered = active.sort((a, b) => (this.#lastUsed.get(a.Labels['cardbush.web.tenant']) ?? 0) - (this.#lastUsed.get(b.Labels['cardbush.web.tenant']) ?? 0));
          let released = false;
          for (const candidate of ordered) if (await this.idle(candidate, 120_000)) {
            await this.docker('POST', `/containers/${candidate.Id}/stop?t=30`); released = true; break;
          }
          if (!released) throw new WebError(503, '当前对话服务繁忙，请稍后重试。已提交的对话会继续处理。');
        }
        if (!existing) {
          const created = await this.docker<{ Id: string }>('POST', `/containers/create?name=${name}`, {
            Image: this.config.image, User: '1100:1100', WorkingDir: '/opt/cardbush',
            Entrypoint: ['/usr/bin/tini', '--', 'node', 'dist-electron/agentServiceCli.mjs'],
            Cmd: ['--data-dir', '/data', '--host', '0.0.0.0', '--web-restricted'],
            Env: [`CARDBUSH_AGENT_TOKEN=${tenantToken(this.config.secret, key)}`, 'NODE_ENV=production', 'HOME=/home/cardbush', 'NODE_OPTIONS=--max-old-space-size=384'],
            Labels: { 'cardbush.web.owner': this.config.prefix, 'cardbush.web.tenant': key },
            HostConfig: { NetworkMode: this.config.network, ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
              PidsLimit: 128, Memory: (this.config.memoryMiB ?? 768) * 1024 * 1024, NanoCpus: 1_000_000_000,
              Mounts: [{ Type: 'volume', Source: `${name}-data`, Target: '/data' }],
              Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=128m,mode=1777', '/home/cardbush': 'rw,nosuid,nodev,size=16m,uid=1100,gid=1100' },
              RestartPolicy: { Name: 'unless-stopped' }, LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '2' } } },
          });
          existing = { Id: created.Id, Names: [name], State: 'created', Labels: {} };
        }
        await this.docker('POST', `/containers/${existing.Id}/start`);
      }
      this.#lastUsed.set(key, Date.now());
      return { url: `http://${name}:4780/`, token: tenantToken(this.config.secret, key), containerId: existing.Id };
    });
  }
  sweep() {
    return this.serial(async () => {
      for (const container of await this.containers()) {
        if (container.State === 'running' && await this.idle(container, (this.config.idleMinutes ?? 10) * 60_000)) await this.docker('POST', `/containers/${container.Id}/stop?t=30`);
      }
    });
  }
}

export async function serveTenantBroker(config: BrokerConfig) {
  const broker = new DockerTenantBroker(config);
  const server = createServer((request, response) => { void (async () => {
    if (request.headers.origin !== undefined || !equalSecret(request.headers.authorization ?? '', `Bearer ${config.secret}`)) throw new WebError(401, 'Unauthorized.');
    if (request.url !== '/ensure' || request.method !== 'POST') throw new WebError(404, 'Not found.');
    const data = await readJson(request, 200); const result = await broker.ensure(String(data.key)); json(response, 200, result);
  })().catch(error => { json(response, error instanceof WebError ? error.status : 503, { error: error instanceof WebError ? error.message : '会话运行服务暂不可用。' }); request.resume(); }); });
  const sweep = setInterval(() => { void broker.sweep().catch(() => console.error('Tenant idle sweep failed.')); }, 60_000); sweep.unref();
  server.listen(config.port ?? 4881, '0.0.0.0');
  return { server, close() { clearInterval(sweep); server.close(); } };
}
if (process.argv[1]?.endsWith('webTenantBroker.mjs')) {
  const config = JSON.parse(await readFile(process.env.CARDBUSH_WEB_BROKER_CONFIG ?? '/run/cardbush/broker.json', 'utf8')) as BrokerConfig;
  await serveTenantBroker(config);
}
