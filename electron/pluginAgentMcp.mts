import { createHash } from 'node:crypto';
import { mcpSnapshotSchema, BUSH_MCP_SNAPSHOT_PROTOCOL } from '@cardbush/bush-protocol';
import { ToolRegistry, type PluginAgent } from '@cardbush/bush-runtime';
import type { RuntimeSessionTurnRequest } from '@cardbush/bush-protocol';
import type { McpClientManager } from '@cardbush/bush-mcp-client';
import { pluginMcpServer } from './pluginMcpConfiguration.mjs';

/** Desktop transport adapter. Runtime owns scope lifetime; this module owns connection configuration. */
export async function openPluginAgentMcp(manager: McpClientManager, agent: PluginAgent, request: RuntimeSessionTurnRequest, signal?: AbortSignal) {
  const registry = new ToolRegistry(), scoped = manager.fork(registry);
  const suffix = createHash('sha256').update(request.sessionId).digest('hex').slice(0, 16);
  const aliases = new Set<string>();
  const servers = (agent.mcpServers ?? []).flatMap(value => typeof value === 'string' ? [] : Object.entries(value).map(([alias, declaration]) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(alias)) throw new Error('Invalid Agent MCP alias.');
    if (aliases.has(alias)) throw new Error(`Duplicate Agent MCP alias: ${alias}`); aliases.add(alias);
    const expand = (value: unknown): unknown => typeof value === 'string' ? value.replaceAll('${CLAUDE_PROJECT_DIR}', String(request.metadata.workspaceDir || request.metadata.projectDir || '')) : Array.isArray(value) ? value.map(expand) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)])) : value;
    const expanded = expand(declaration) as Record<string, unknown>;
    const server = pluginMcpServer(agent.pluginId, alias, agent.root, expanded, { required: true });
    if (!server) throw new Error(`Agent MCP ${alias} is not configured.`);
    return server;
  }));
  const abort = () => { void scoped.close(); }; signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    await scoped.apply(mcpSnapshotSchema.parse({ protocol: BUSH_MCP_SNAPSHOT_PROTOCOL, snapshotId: `agent:${request.sessionId}`, revision: 1, servers }));
    await scoped.prepareAgentScope(request, signal);
    signal?.throwIfAborted();
    // Transport/OAuth identity stays stable; only exposed tool names are unique per child.
    const registrations = registry.definitions().map(tool => {
      const registration = registry.resolve(tool.name)!;
      const prefix = `mcp__${registration.mcpHook!.server.replace(/[^A-Za-z0-9_-]/g, '_')}__`;
      return { ...registration, definition: { ...registration.definition, name: tool.name.replace(prefix, `${prefix.slice(0, -2)}__scope_${suffix}__`) } };
    });
    return { registrations, close: async () => { signal?.removeEventListener('abort', abort); await scoped.close(); } };
  } catch (error) { signal?.removeEventListener('abort', abort); await scoped.close(); throw error; }
}
