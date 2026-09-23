import type { McpSnapshotResult } from '@cardbush/bush-protocol';
import { cardbushAppsConfigurationFromPayload, type McpServerConfigInput } from '../../backend/api';
import { serverFromStored } from '../../backend/productMcp';
import { mcpConnectionState } from '../../backend/mcpConnectionOverview';
import type { CardbushAppsConfiguration, McpServerConfig } from '../../types';
import type { AgentCall } from '../agents/agentConversationBackend';
import type { SettingsHost } from './SettingsHostContext';

type McpState = { configuration: { revision: number; servers: McpServerConfig[] }; runtime: McpSnapshotResult | null; runtimeError?: string };
export function createAgentSettingsHost(call: AgentCall, supportsSharedSettings: boolean): SettingsHost {
  const configuration = (value: Record<string, unknown>) => {
    const result = cardbushAppsConfigurationFromPayload(value);
    // Server filesystem paths are not local image URLs.
    return { ...result, plugins: result.plugins.map(plugin => ({ ...plugin, logoPath: '', logoDarkPath: '' })) };
  };
  const readApps = async () => configuration(await call('product.command', { kind: 'apps.get' }));
  const writeApps = async (value: CardbushAppsConfiguration) => configuration(await call('product.command', { kind: 'apps.update', config: {
    expectedRevision: value.revision, proxy: value.proxy, searchResultLimit: value.searchResultLimit, serviceEnabled: value.serviceEnabled,
    plugins: value.plugins.map(({ id, installed, enabled, config }) => ({ id, installed, enabled, config })),
  } }));
  const readMcp = async (): Promise<McpState> => {
    const [status, stored] = await Promise.all([
      call<McpState>('mcp.list'),
      call<{ revision: number; servers: Record<string, unknown>[] }>('product.command', { kind: 'mcp.get' }),
    ]);
    // mcp.list intentionally exposes only names/status. The authenticated product
    // read is the editable configuration, including commands, paths and headers.
    return { ...status, configuration: { revision: stored.revision,
      servers: stored.servers.map(serverFromStored).filter((server): server is McpServerConfig => server !== null),
    } };
  };
  const readServers = async () => {
    const state = await readMcp();
    return { servers: state.configuration.servers.map(server => ({ ...server, args: server.args ?? [], raw: server.raw ?? {},
      toolCount: state.runtime?.servers.find(item => item.id === server.id)?.tools.length ?? 0,
      lastError: state.runtimeError || state.runtime?.applicationError || state.runtime?.servers.find(item => item.id === server.id)?.lastError,
      status: mcpConnectionState(server.id, server.enabled, state.runtime, state.configuration.revision),
    })), protocolVersions: [], raw: {} };
  };
  const apply = async (patch: Record<string, unknown>) => {
    const receipt = await call<{ applicationError?: string; runtimeError?: string }>('mcp.configure', patch);
    if (receipt.applicationError || receipt.runtimeError) throw new Error(receipt.applicationError || receipt.runtimeError);
    const server = (await readServers()).servers.find(item => item.id === patch.id);
    if (!server) throw new Error('MCP server disappeared after saving.');
    return server;
  };
  // Explicit implementation: never fall back to the desktop for a missing remote API.
  return {
    remote: true,
    supportsPluginConnections: supportsSharedSettings,
    fetchSandboxSetup: () => call('product.command', { kind: 'sandbox.get' }),
    installSandbox: () => call('product.command', { kind: 'sandbox.install', confirm: true }),
    updateSandbox: enabled => call('product.command', { kind: 'sandbox.update', enabled }),
    fetchCardbushAppsConfiguration: readApps, saveCardbushAppsConfiguration: writeApps,
    fetchMcpConnectionOverview: async () => { const state = await readMcp(); return { ...state.configuration, snapshot: state.runtime }; },
    savePluginSearchResultLimit: async searchResultLimit => writeApps({ ...await readApps(), searchResultLimit }),
    uninstallCardbushPlugin: async id => ({ configuration: configuration(await call('plugins.uninstall', { id })) }),
    setMcpServerProxy: async (id, proxy) => { await apply({ id, proxy: proxy ?? null }); },
    resetMcpServerProxies: async () => {
      const state = await call<{ revision: number; servers: McpServerConfig[] }>('product.command', { kind: 'mcp.get' });
      await call('product.command', { kind: 'mcp.update', config: { expectedRevision: state.revision, servers: state.servers.map(server => ({ ...server, proxy: undefined })) } });
    },
    fetchMcpServers: readServers,
    saveMcpServerConfig: async (input: McpServerConfigInput) => {
      // The server patch API merges env/headers; send explicit removals from the shared editor.
      const prior = (await readMcp()).configuration.servers.find(server => server.id === input.id);
      const changes = (before: Record<string, string> = {}, after: Record<string, string> = {}) => ({ ...Object.fromEntries(Object.keys(before).filter(key => !(key in after)).map(key => [key, null])), ...after });
      return apply({ ...input, env: changes(prior?.env, input.env), headers: changes(prior?.headers, input.headers) });
    },
    setMcpServerEnabled: (id, enabled) => apply({ id, enabled }),
    deleteMcpServerConfig: id => call('mcp.remove', { id }),
    savePluginConnections: async input => {
      if (!supportsSharedSettings) throw new Error('请更新 Agent 服务以编辑插件连接。Update the Agent service to edit plugin connections.');
      return call('plugins.connections.save', input);
    },
    mcpConnectionAction: async (id, action) => {
      if (action !== 'reconnect') throw new Error('Remote browser authorization is unavailable.');
      return call('mcp.reconnect', { id });
    },
    installDirectory: path => call('plugins.install', { path }),
  };
}
