import { mcpSnapshotResultSchema, type McpSnapshotResult } from '@cardbush/bush-protocol';
import type { ChatToolExecution } from '../../types';

export type McpActivation = {
  serverId: string;
  snapshotId: string;
  revision: number;
  initial: McpSnapshotResult;
};
export type McpActivationState = 'pending' | 'connected' | 'failed' | 'superseded' | 'unknown';

export function mcpActivations(executions: ChatToolExecution[]): McpActivation[] {
  const byServer = new Map<string, McpActivation>();
  for (const item of executions) {
    if (item.name !== 'mcp__cardbush_management__configure_mcp_server' || item.state !== 'completed') continue;
    const serverId = item.metadata.mcpServerId;
    const result = item.metadata.nativeResult as { isError?: boolean; content?: Array<{ type: string; text?: string }> } | undefined;
    if (typeof serverId !== 'string' || result?.isError || !Array.isArray(result?.content)) continue;
    for (const block of result.content) {
      if (block.type !== 'text' || !block.text) continue;
      try {
        const value = JSON.parse(block.text);
        const parsed = mcpSnapshotResultSchema.safeParse(value.runtime);
        if (value.saved !== true || !parsed.success) continue;
        const snapshot = parsed.data;
        byServer.set(serverId, { serverId, snapshotId: snapshot.snapshotId,
          revision: snapshot.pendingRevision ?? snapshot.revision, initial: snapshot });
      } catch { /* Non-JSON Tool text is not a connection fact. */ }
    }
  }
  return [...byServer.values()];
}

export function mcpActivationState(target: McpActivation, snapshot: McpSnapshotResult | null): McpActivationState {
  if (!snapshot || snapshot.snapshotId !== target.snapshotId) return 'unknown';
  if (Math.max(snapshot.revision, snapshot.pendingRevision ?? 0) > target.revision) return 'superseded';
  if (snapshot.revision < target.revision && snapshot.pendingRevision !== target.revision) return 'unknown';
  const server = snapshot.servers.find(item => item.id === target.serverId);
  if (server?.updateState === 'failed') return 'failed';
  if (server?.updateState) return server.updateState === 'waiting_for_catalog' && server.health !== 'ready' && server.health !== 'restarting' ? 'failed' : 'pending';
  const affected = snapshot.pendingServerIds === undefined || snapshot.pendingServerIds.includes(target.serverId);
  if (snapshot.applicationState === 'failed' && affected) return 'failed';
  if (snapshot.applicationState === 'pending' && affected) return 'pending';
  return server?.health === 'ready' ? 'connected' : server?.health === 'unavailable' ? 'failed' : 'unknown';
}
