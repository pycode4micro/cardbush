import { DatabaseSync } from 'node:sqlite';
import { setTimeout as pause } from 'node:timers/promises';
import { WEB_IMAGE_TOOLS } from '@cardbush/bush-runtime/web-policy';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { installProductPlugin } from './productPlugins.js';
import type { ElectronProductHostController } from './productHostController.mjs';

export const WEB_PLUGIN_ID = 'volcengine_images';
const configuration = z.object({ imageEnabled: z.boolean(), gateway: z.string().url(), credential: z.string().min(48).max(128) }).strict();
export class AgentWebPolicy {
  #desired?: z.infer<typeof configuration>;
  #applied = '';
  #pending?: Promise<void>;
  constructor(readonly root: string, readonly product: ElectronProductHostController) {}
  get imageEnabled() { return this.#desired?.imageEnabled === true; }
  async active() {
    const file = join(this.root, 'plugin-state', 'images', 'jobs.sqlite3');
    if (!await stat(file).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; })) return false;
    const db = new DatabaseSync(file, { readOnly: true });
    try { return Number((db.prepare("SELECT count(*) AS count FROM jobs WHERE status IN ('queued','running')").get() as { count: number }).count) > 0; } finally { db.close(); }
  }
  async configure(value: unknown) {
    const next = configuration.parse(value), url = new URL(next.gateway);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid private plugin gateway.');
    if (JSON.stringify(next) !== JSON.stringify(this.#desired)) {
      await mkdir(join(this.root, 'config'), { recursive: true });
      await writeFile(join(this.root, 'config', 'web-policy.json'), JSON.stringify(next), { mode: 0o600 });
      this.#desired = next;
    }
    return { configured: true };
  }
  async apply() {
    if (this.#pending) return this.#pending;
    this.#pending = this.#apply().finally(() => { this.#pending = undefined; });
    return this.#pending;
  }
  async #apply() {
    this.#desired ??= configuration.parse(JSON.parse(await readFile(join(this.root, 'config', 'web-policy.json'), 'utf8')));
    const desired = this.#desired, signature = JSON.stringify(desired);
    if (this.#applied === signature) return;
    if (await this.active()) return;
    await mkdir(join(this.root, 'workspaces'), { recursive: true });
    // Only the image-only, reviewed package shipped with this deployment can be installed.
    const target = join(this.root, 'plugins', WEB_PLUGIN_ID);
    const installed = Boolean(await readFile(join(target, '.codex-plugin', 'plugin.json'), 'utf8').catch(() => ''));
    if (!desired.imageEnabled && installed) await this.product.uninstallPlugin(WEB_PLUGIN_ID);
    if (desired.imageEnabled && !installed) {
      await installProductPlugin(resolve('deploy/web/plugins/volcengine_images'), join(this.root, 'plugins'), (id, replace) => this.product.replacePlugin(id, replace));
    }
    const current = await this.product.execute({ protocol: 'cardbush.product_host_ipc.v1', kind: 'apps.get' }) as any;
    if (!current.ok) throw new Error('Plugin configuration unavailable.');
    const apps = current.value;
    const plugins = (apps.plugins ?? []).map((plugin: any) => ({ id: plugin.id, installed: plugin.installed,
      enabled: plugin.id === WEB_PLUGIN_ID && desired.imageEnabled,
      config: plugin.id === WEB_PLUGIN_ID ? { mcp_servers: { images: { enabled: desired.imageEnabled, default_tools_approval_mode: 'approve',
        enabled_tools: [...WEB_IMAGE_TOOLS], connection: { env: { ZHAOCAI_IMAGE_GATEWAY: desired.gateway, ZHAOCAI_IMAGE_TOKEN: desired.credential, ZHAOCAI_PERSONAL_ROOT: join(this.root, 'workspaces'), ZHAOCAI_IMAGE_STATE: join(this.root, 'plugin-state', 'images'), PYTHONDONTWRITEBYTECODE: '1' } } } } } : plugin.config }));
    const result = await this.product.execute({ protocol: 'cardbush.product_host_ipc.v1', kind: 'apps.update', config: { expectedRevision: apps.revision, serviceEnabled: true, plugins } }) as any;
    if (!result.ok) throw new Error('Plugin configuration failed.');
    await this.product.refreshMcp();
    // Native catalog publication is asynchronous. Await this one authorized plugin
    // before freezing this turn's allowlist; keep the transport/job queue non-blocking.
    if (desired.imageEnabled) {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await this.product.listMcpServers() as any;
        const connection = state.runtime?.servers?.find((server: any) => server.id === 'plugin_volcengine_images_images');
        if (connection?.health === 'ready' && connection.tools?.length === WEB_IMAGE_TOOLS.length) { ready = true; break; }
        if (state.runtime?.applicationError || (!connection?.updateState && ['unavailable','configuration_required','auth_required'].includes(connection?.health))) throw new Error('Image plugin connection failed.');
        await pause(150);
      }
      if (!ready) throw new Error('Image plugin is still loading. Try the conversation again.');
    }
    this.#applied = signature;
  }
}
