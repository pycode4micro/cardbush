import { isAbsolute } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { mcpSnapshotResultSchema } from '@cardbush/bush-protocol';
import { z } from 'zod';
import type { PluginMarketplaceService } from './pluginMarketplaces.js';
import type { ElectronProductHostController } from './productHostController.mjs';

export type ProductPluginToolHost = Pick<ElectronProductHostController,
  'pluginInstallation' | 'pluginInstallOptions' | 'inspectLocalPlugin' | 'installLocalPlugin' | 'uninstallPluginForTool' | 'refreshMcp'>;

const pluginId = z.string().max(160).regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/);
const sourceId = z.string().trim().min(1).max(160);
const installSource = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('marketplace'), source_id: sourceId }),
  z.strictObject({
    kind: z.literal('local'),
    path: z.string().max(4096).refine(isAbsolute, 'Use an absolute folder or ZIP path on this CardBush host.'),
  }),
]);
const packageInput = z.strictObject({ plugin_id: pluginId, source: installSource });
type PackageInput = z.infer<typeof packageInput>;

export function registerProductPluginTools(server: McpServer, getHost: () => ProductPluginToolHost, getMarket: () => PluginMarketplaceService) {
  const result = async (work: () => Promise<unknown>) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await work()) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }; }
  };
  const inspect = async (input: PackageInput) => {
    if (input.source.kind === 'local') {
      const candidate = await getHost().inspectLocalPlugin(input.source.path);
      if (candidate.id !== input.plugin_id) throw new Error('The candidate plugin manifest does not match plugin_id.');
      return { candidate_version: candidate.version };
    }
    const market = getMarket();
    const preview = await market.preview(input.source.source_id, input.plugin_id);
    try { return { candidate_version: preview.version, issues: preview.issues }; }
    finally { await market.discardPreview(preview.token); }
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

  server.registerTool('inspect_plugin', {
    description: 'Compare one CardBush plugin with a specific candidate before a requested update. Supply a configured marketplace or absolute candidate package folder or ZIP. For the currently installed version or state alone, use search_plugins in plugins mode and use its installed catalog result.',
    inputSchema: packageInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => result(async () => {
    const installed = await getHost().pluginInstallation(input.plugin_id);
    return { plugin_id: input.plugin_id, installed_version: installed?.version ?? null, ...await inspect(input) };
  }));

  server.registerTool('install_plugin', {
    description: 'Install one requested CardBush plugin. Use the exact plugin_id and a configured marketplace or absolute local folder or ZIP. For a requested update, use inspect_plugin and supply both observed versions in update. Update uses the product replacement lifecycle and retains configuration. Without update, an installed package is kept and its version and the candidate version are reported separately. A package can be installed while its MCP services still need configuration or discovery.',
    inputSchema: packageInput.extend({ update: z.strictObject({ installed_version: z.string().min(1).max(160), candidate_version: z.string().min(1).max(160) }).optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async (input, context) => result(async () => {
    const host = getHost(), signal = context.mcpReq.signal;
    const existing = await host.pluginInstallation(input.plugin_id);
    const update = input.update && { installedVersion: input.update.installed_version, candidateVersion: input.update.candidate_version };
    const retained = async (installation: NonNullable<typeof existing>) => ({ status: 'already_installed', ...installation,
      installed_version: installation.version, ...await inspect(input) });
    if (update && existing?.version !== update.installedVersion) throw new Error('The installed package changed. Inspect it again.');
    if (existing && (!update || update.installedVersion === update.candidateVersion)) return retained(existing);
    const options = host.pluginInstallOptions(input.plugin_id, signal, update);
    let warnings;
    try {
      if (input.source.kind === 'local') {
        await host.installLocalPlugin(input.source.path, options);
      } else {
        const market = getMarket();
        signal.throwIfAborted();
        const preview = await market.preview(input.source.source_id, input.plugin_id);
        try {
          if (preview.issues.length) throw new Error(`Plugin is not compatible with CardBush: ${preview.issues.map(issue => issue.detail || issue.code).join('; ')}`);
          if (update && preview.version !== update.candidateVersion) throw new Error('The candidate package changed. Inspect it again.');
          warnings = (await market.install(preview.token, options)).warnings;
        } finally { await market.discardPreview(preview.token); }
      }
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'plugin_already_installed') throw error;
      const installed = await host.pluginInstallation(input.plugin_id);
      if (!installed) throw error;
      return retained(installed);
    }
    const application = await host.refreshMcp().then(value => mcpSnapshotResultSchema.safeParse(value).data, () => undefined);
    const saved = await host.pluginInstallation(input.plugin_id);
    if (!saved) return { status: 'installation_changed', plugin_id: input.plugin_id, installed: false };
    return { status: update ? 'updated' : 'installed', ...saved, application_state: application?.applicationState ?? 'unverified',
      application_phase: application?.applicationPhase, warnings };
  }));

  server.registerTool('uninstall_plugin', {
    description: 'Uninstall exactly one user-installed CardBush plugin on this host using its plugin_id from search_plugins in plugins mode. Stops its services and removes the package, plugin-specific data and credentials through the product lifecycle. Bundled plugins are protected. If removal_pending is returned, the package still exists; retry after the blocking work has settled. Shared accounts and unrelated MCP services are preserved.',
    inputSchema: z.strictObject({ plugin_id: pluginId }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ plugin_id }, context) => result(() => getHost().uninstallPluginForTool(plugin_id, context.mcpReq.signal)));
}
