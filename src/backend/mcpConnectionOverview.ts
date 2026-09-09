import type { McpSnapshotResult } from '@cardbush/bush-protocol';
import type { McpServerConfig } from '../types';

export type McpConnectionState = 'connected' | 'auth_required' | 'configuration_required' | 'pending' | 'restarting' | 'unavailable' | 'disabled' | 'unknown';
export type McpConnectionOverview = {
  revision: number;
  servers: Pick<McpServerConfig, 'id' | 'name' | 'description' | 'enabled' | 'transport'>[];
  snapshot: McpSnapshotResult | null;
};

/** Configuration and connection health are separate facts; an older runtime is not confirmation. */
export function mcpConnectionState(
  id: string, enabled: boolean, snapshot: McpSnapshotResult | null, revision?: number,
): McpConnectionState {
  if (!snapshot || snapshot.snapshotId !== 'cardbush-product-mcp') return enabled ? 'unknown' : 'disabled';
  if (revision !== undefined && snapshot.configurationRevision !== revision) return enabled ? 'unknown' : 'disabled';
  if (snapshot.applicationState === 'pending') return 'pending';
  if (snapshot.applicationState === 'failed') return 'unavailable';
  if (!enabled) return 'disabled';
  const server = snapshot.servers.find(item => item.id === id);
  if (server?.health === 'auth_required') return 'auth_required';
  if (server?.health === 'configuration_required') return 'configuration_required';
  if (server?.health === 'ready') return 'connected';
  if (server?.health === 'restarting') return 'restarting';
  return server?.health === 'unavailable' ? 'unavailable' : 'unknown';
}
