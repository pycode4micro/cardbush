import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { PluginMarketplaceService } from './pluginMarketplaces.js';
import { PluginNetwork } from './pluginNetwork.mjs';
import { runAcquisitionCommand, collectPluginAcquisitionCache } from './pluginAcquisition.js';
import { mergeCleanup } from './cacheMaintenance.js';
import type { ProductPluginReplacement } from './productPlugins.js';
import { createHeadlessProxySession } from './headlessProxySession.mjs';

const name = z.string().trim().min(1).max(512);
const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('sources') }).strict(),
  z.object({ action: z.literal('add'), source: z.string().trim().min(1).max(4096) }).strict(),
  z.object({ action: z.literal('addLocal'), directory: z.string().trim().min(1).max(4096).refine(isAbsolute, 'Use an absolute directory on the Agent host.') }).strict(),
  z.object({ action: z.literal('remove'), sourceId: name }).strict(),
  z.object({ action: z.literal('catalog'), sourceId: name, refresh: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('preview'), sourceId: name, name }).strict(),
  z.object({ action: z.literal('presentation'), sourceId: name, name }).strict(),
  z.object({ action: z.literal('install'), token: z.string().uuid() }).strict(),
]);

/** Host adapter only: acquisition, validation, preview tokens and replacement are shared with desktop. */
export class AgentPluginMarketplaces {
  private readonly network: PluginNetwork;
  private readonly market: PluginMarketplaceService;
  private readonly dataRoot: string;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(root: string, bundledRoot: string, replacePlugin: ProductPluginReplacement, env: NodeJS.ProcessEnv) {
    this.dataRoot = join(root, 'plugin-marketplaces');
    this.network = new PluginNetwork(join(root, 'config', 'apps.json'), () => createHeadlessProxySession(env));
    // A headless host has no desktop model-network preference. Inherit its process proxy environment.
    this.network.setModel({ mode: 'system' });
    this.market = new PluginMarketplaceService({
      dataRoot: this.dataRoot, userPluginRoot: join(root, 'plugins'), bundledPluginRoot: join(bundledRoot, 'plugins'),
      fetch: this.network.fetch, replacePlugin,
      runAcquisition: async (command, args, cwd) => {
        const proxyEnv = await this.network.environment();
        return runAcquisitionCommand(command, command === 'git' ? ['-c', `http.proxy=${proxyEnv.HTTPS_PROXY}`, ...args] : args, cwd, { ...env, ...proxyEnv });
      },
    });
  }
  call(input: unknown) {
    const task = this.execute(request.parse(input));
    this.pending.add(task);
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
    return task;
  }
  private async execute(input: z.infer<typeof request>) {
    switch (input.action) {
      case 'sources': return this.market.sources();
      case 'add': return this.market.addSource(input.source);
      case 'addLocal': return this.market.addLocal(input.directory);
      case 'remove': await this.market.remove(input.sourceId); return null;
      case 'catalog': return this.market.catalog(input.sourceId, input.refresh);
      case 'preview': return this.market.preview(input.sourceId, input.name);
      case 'presentation': return this.market.presentation(input.sourceId, input.name);
      case 'install': return this.market.install(input.token);
    }
  }
  async collectCache() {
    return mergeCleanup(await this.market.collectCache(), await collectPluginAcquisitionCache(this.dataRoot));
  }
  async close() { await Promise.allSettled([...this.pending]); await this.network.close(); }
}
