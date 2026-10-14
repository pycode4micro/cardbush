type Json = Record<string, unknown>;
export interface McpManagementViewOptions { serverId?: string; detail?: boolean }

const record = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const pick = (value: Json, keys: string[]): Json => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));

/** Project the model-facing observation only; UI and host snapshots retain their full shape. */
export function mcpManagementView(value: unknown, options: McpManagementViewOptions = {}): Json {
  const source = record(value), result: Json = { ...source, view: options.detail ? 'detail' : 'summary' };
  let matched = false;
  const select = (items: unknown[], key: string) => items.filter(item => {
    const included = !options.serverId || record(item)[key] === options.serverId;
    matched ||= included;
    return included;
  });
  const configuration = record(source.configuration);
  if (Array.isArray(configuration.servers)) {
    result.configuration = { ...configuration, servers: select(configuration.servers, 'id') };
  }
  if (Array.isArray(source.connections)) {
    result.connections = select(source.connections, 'serverId').map(item => {
      if (options.detail) return item;
      const connection = record(item);
      return { ...pick(connection, ['pluginId', 'componentId', 'name', 'serverId', 'pluginEnabled', 'registeredAppId', 'source', 'configurationError']),
        effective: connection.effective == null ? null : pick(record(connection.effective), ['transport', 'auth']) };
    });
  }
  const runtime = record(source.runtime);
  if (Array.isArray(runtime.servers)) {
    // A summary is not the protocol's complete native MCP snapshot.
    const { protocol, ...status } = runtime;
    result.runtime = { ...status, ...(options.detail && protocol ? { protocol } : {}),
      servers: select(runtime.servers, 'id').map(item => {
        if (options.detail) return item;
        const server = record(item);
        return { ...pick(server, ['id', 'health', 'negotiatedProtocolVersion', 'restartAttempts', 'lastError', 'updateState']),
          toolCount: Array.isArray(server.tools) ? server.tools.length : null,
          ...(server.lastFailure ? { lastFailure: pick(record(server.lastFailure), ['code', 'message', 'occurredAt']) } : {}) };
      }) };
  }
  return { ...result, ...(options.serverId ? { serverId: options.serverId, matched } : {}) };
}
