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

export function pluginMcpConnections(
  plugins: CardbushAppPlugin[], overview: McpConnectionOverview | null, serviceEnabled: boolean,
): PluginMcpConnection[] {
  const snapshot = overview?.snapshot ?? null;
  const owned = plugins.filter(plugin => plugin.installed).flatMap(plugin => {
    // Components describe capabilities; several declarations can belong to one
    // connection. Count by owner + runtime ID, preferring transport metadata.
    const components = plugin.components
      .filter(component => component.kind === 'mcp' || component.kind === 'app')
      .sort((a, b) => Number(a.kind === 'app') - Number(b.kind === 'app'));
    const connections = new Map<string, PluginMcpConnection>();
    for (const component of components) {
      // Product-owned launchers have fixed IDs; external plugins use productPlugins.ts's namespace.
      const id = plugin.id === 'computer-use' ? 'cardbush_apps' : plugin.id === 'chrome' ? 'chrome_devtools'
        : `plugin_${plugin.id.replaceAll('.', '_')}_${component.id}`;
      if (connections.has(id)) continue;
      connections.set(id, { id, name: component.name, description: component.description, plugin,
        state: mcpConnectionState(id, serviceEnabled && plugin.enabled && (plugin.config.mcp_servers as Record<string, { enabled?: boolean }> | undefined)?.[component.id]?.enabled !== false, snapshot),
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
