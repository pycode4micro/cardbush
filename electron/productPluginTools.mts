import { isAbsolute } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { mcpSnapshotResultSchema } from '@cardbush/bush-protocol';
import { z } from 'zod';
import type { PluginMarketplaceService } from './pluginMarketplaces.js';
import type { ElectronProductHostController } from './productHostController.mjs';

export type ProductPluginToolHost = Pick<ElectronProductHostController,
  'pluginInstallation' | 'pluginInstallOptions' | 'installLocalPlugin' | 'uninstallPluginForTool' | 'refreshMcp'>;

const pluginId = z.string().max(160).regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/);
const sourceId = z.string().trim().min(1).max(160);
const installSource = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('marketplace'), source_id: sourceId }),
  z.strictObject({
    kind: z.literal('local'),
    path: z.string().max(4096).refine(isAbsolute, 'Use an absolute folder or ZIP path on this CardBush host.'),
  }),
]);

export function registerProductPluginTools(server: McpServer, getHost: () => ProductPluginToolHost, getMarket: () => PluginMarketplaceService) {
  const result = async (work: () => Promise<unknown>) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await work()) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }; }
  };

  server.registerTool('list_plugin_marketplaces', {
    description: 'Find plugins available for installation from the CardBush marketplaces already configured on this host. Omit source_id to list sources, then supply one source_id and optionally a query or offset for its entries. Use the returned exact plugin_id and source_id with install_plugin. Use search_plugins in plugins mode to read the installed catalog.',
    inputSchema: z.strictObject({
      source_id: sourceId.optional(),
      query: z.string().trim().max(200).optional(),
      offset: z.number().int().min(0).max(5000).optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input, context) => result(async () => {
    const market = getMarket();
    if (!input.source_id) {
      return { sources: (await market.sources()).map(source => ({
        source_id: source.id, kind: source.kind, location: source.location, bundled: source.builtin === true,
      })) };
    }
    const catalog = await market.catalog(input.source_id);
    context.mcpReq.signal.throwIfAborted();
    const query = input.query?.toLowerCase() ?? '';
    const offset = input.offset ?? 0;
    const entries = catalog.entries.filter(entry => `${entry.name} ${entry.description}`.toLowerCase().includes(query));
    const page = entries.slice(offset, offset + 25).map(entry => ({
      plugin_id: entry.name, description: entry.description.slice(0, 400), available: entry.available, reason: entry.unavailableReason,
    }));
    return { source_id: catalog.source.id, name: catalog.displayName, cached: catalog.cached ?? false,
      entries: page, total: entries.length, ...(offset + page.length < entries.length ? { next_offset: offset + page.length } : {}) };
  }));

  server.registerTool('install_plugin', {
    description: 'Install one requested CardBush plugin on this host. Use the exact plugin_id and a configured marketplace source_id from list_plugin_marketplaces, or an absolute local package folder or ZIP path. Accepts Agent Plugins, OpenAI Codex, and Anthropic Claude plugin manifests. Existing packages are retained. Report the installed version, enabled state and observed MCP status separately. A package can be installed while its MCP services still need configuration or discovery.',
    inputSchema: z.strictObject({ plugin_id: pluginId, source: installSource }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async (input, context) => result(async () => {
    const host = getHost(), signal = context.mcpReq.signal;
    const existing = await host.pluginInstallation(input.plugin_id);
    if (existing) return { status: 'already_installed', ...existing };
    const options = host.pluginInstallOptions(input.plugin_id, signal);
    let warnings;
    try {
      if (input.source.kind === 'local') {
        await host.installLocalPlugin(input.source.path, options);
      } else {
        const market = getMarket();
        signal.throwIfAborted();
        const preview = await market.preview(input.source.source_id, input.plugin_id);
        if (preview.issues.length) throw new Error(`Plugin is not compatible with CardBush: ${preview.issues.map(issue => issue.detail || issue.code).join('; ')}`);
        warnings = (await market.install(preview.token, options)).warnings;
      }
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'plugin_already_installed') throw error;
      const installed = await host.pluginInstallation(input.plugin_id);
      if (!installed) throw error;
      return { status: 'already_installed', ...installed };
    }
    const application = await host.refreshMcp().then(value => mcpSnapshotResultSchema.safeParse(value).data, () => undefined);
    const saved = await host.pluginInstallation(input.plugin_id);
    if (!saved) return { status: 'installation_changed', plugin_id: input.plugin_id, installed: false };
    return { status: 'installed', ...saved, application_state: application?.applicationState ?? 'unverified',
      application_phase: application?.applicationPhase, warnings };
  }));

  server.registerTool('uninstall_plugin', {
    description: 'Uninstall exactly one user-installed CardBush plugin on this host using its plugin_id from search_plugins in plugins mode. Stops its services and removes the package, plugin-specific data and credentials through the product lifecycle. Bundled plugins are protected. If removal_pending is returned, the package still exists; retry after the blocking work has settled. Shared accounts and unrelated MCP services are preserved.',
    inputSchema: z.strictObject({ plugin_id: pluginId }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ plugin_id }, context) => result(() => getHost().uninstallPluginForTool(plugin_id, context.mcpReq.signal)));
}
