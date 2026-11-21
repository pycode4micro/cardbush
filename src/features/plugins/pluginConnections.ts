import { mcpConnectionState, type McpConnectionOverview, type McpConnectionState } from '../../backend/mcpConnectionOverview';
import type { CardbushAppPlugin } from '../../types';

export type PluginMcpConnection = {
  id: string;
  name: string;
  description: string;
  plugin?: CardbushAppPlugin;
  state: McpConnectionState;
  toolCount?: number;
};

export function pluginMcpServerId(pluginId: string, componentId: string) {
  if (pluginId === 'computer-use') return 'cardbush_apps';
  if (pluginId === 'chrome') return 'browser_use';
  return `plugin_${pluginId.replaceAll('.', '_')}_${componentId}`;
}

export function pluginServicesEnabled(plugin: CardbushAppPlugin, serviceEnabled: boolean) {
  return serviceEnabled && plugin.installed && plugin.enabled && !plugin.removalPending;
}

export function pluginMcpConnections(
  plugins: CardbushAppPlugin[], overview: McpConnectionOverview | null, serviceEnabled: boolean, pluginRevision?: number,
): PluginMcpConnection[] {
  const snapshot = overview?.snapshot ?? null;
  const owned = plugins.filter(plugin => plugin.installed).flatMap(plugin => {
    // Components describe capabilities; several declarations can belong to one
    // connection. Count by owner + runtime ID, preferring transport metadata.
    const components = plugin.components
      .filter(component => component.kind === 'mcp' || (component.kind === 'app' && !component.app))
      .sort((a, b) => Number(a.kind === 'app') - Number(b.kind === 'app'));
    const connections = new Map<string, PluginMcpConnection>();
    for (const component of components) {
      // Product-owned launchers have fixed IDs; external plugins use productPlugins.ts's namespace.
      const id = pluginMcpServerId(plugin.id, component.id);
      if (connections.has(id)) continue;
      connections.set(id, { id, name: component.name, description: component.description, plugin,
        state: mcpConnectionState(id, pluginServicesEnabled(plugin, serviceEnabled) && (plugin.config.mcp_servers as Record<string, { enabled?: boolean }> | undefined)?.[component.id]?.enabled !== false, snapshot, overview?.revision, pluginRevision),
        toolCount: snapshot?.servers.find(server => server.id === id)?.tools.length });
    }
    return [...connections.values()];
  });
  // Product configuration contains standalone servers only. An ID collision is still
  // a separate editable configuration, and must not disappear behind a plugin entry.
  return [...owned, ...(overview?.servers ?? []).map(server => ({
    id: server.id, name: server.name, description: server.description,
    state: mcpConnectionState(server.id, server.enabled, snapshot, overview?.revision),
    toolCount: snapshot?.servers.find(item => item.id === server.id)?.tools.length,
  }))];
}
