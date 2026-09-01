import {
  BUSH_MCP_SNAPSHOT_PROTOCOL,
  mcpSnapshotSchema,
  type McpSnapshot,
  type McpSnapshotResult,
} from '@cardbush/bush-protocol';

import type { McpServerConfig, McpTransport } from '../types';
import type { ProtocolRuntimeClient } from '../runtime-client/ProtocolRuntimeClient';

const snapshotId = 'cardbush-product-mcp';
export const CARDBUSH_APPS_MCP_SERVER_ID = 'cardbush_apps';

export async function readProductMcpServers(): Promise<McpServerConfig[]> {
  const stored = await productHostMcp('mcp.get');
  return (Array.isArray(stored.servers) ? stored.servers : [])
    .map(serverFromStored)
    .filter((value): value is McpServerConfig => (
      value != null && value.id !== CARDBUSH_APPS_MCP_SERVER_ID
    ));
}

export async function synchronizeProductMcpSnapshot(
  client: Pick<ProtocolRuntimeClient, 'applyMcpSnapshot'>,
): Promise<McpSnapshotResult> {
  const stored = await productHostMcp('mcp.get');
  const servers = (Array.isArray(stored.servers) ? stored.servers : [])
    .map(serverFromStored).filter((value): value is McpServerConfig => value != null);
  return client.applyMcpSnapshot(snapshot(servers, Number(stored.revision) || 1));
}

export async function replaceProductMcpServers(
  client: Pick<ProtocolRuntimeClient, 'applyMcpSnapshot'>,
  servers: McpServerConfig[],
): Promise<McpSnapshotResult> {
  if (servers.some((server) => server.id === CARDBUSH_APPS_MCP_SERVER_ID)) {
    throw new Error(`${CARDBUSH_APPS_MCP_SERVER_ID} is a reserved bundled MCP server ID.`);
  }
  const saved = await productHostMcp('mcp.update', {
    servers: servers.map(storedServer),
  });
  return client.applyMcpSnapshot(snapshot(servers, Number(saved.revision) || 1));
}

export function validateProductMcpServer(server: McpServerConfig) {
  if (server.id === CARDBUSH_APPS_MCP_SERVER_ID) {
    return mcpSnapshotSchema.safeParse({
      ...snapshot([], 1),
      servers: [{ id: '', transport: { kind: 'stdio', command: '' } }],
    });
  }
  return mcpSnapshotSchema.safeParse(snapshot([server], 1));
}

function snapshot(servers: McpServerConfig[], revision: number): McpSnapshot {
  return {
    protocol: BUSH_MCP_SNAPSHOT_PROTOCOL,
    snapshotId,
    revision,
    servers: servers.filter((server) => server.enabled).map((server) => ({
      id: server.id,
      transport: server.transport === 'stdio'
        ? {
            kind: 'stdio' as const,
            command: server.command ?? '',
            args: server.args,
            ...(server.cwd ? { cwd: server.cwd } : {}),
            env: server.env ?? {},
          }
        : {
            kind: server.transport === 'http' ? 'streamable_http' as const : server.transport,
            url: server.url ?? '',
            headers: server.headers ?? {},
          },
      versionMode: 'auto',
      restartBackoffMs: 250,
      acceptCardbushExtensions: false,
      defaultToolPolicy: {
        permission: 'ask',
        parallelSafe: false,
        visibleToChild: true,
      },
      toolPolicies: {},
    })),
  };
}

function storedServer(server: McpServerConfig) {
  return {
    id: server.id,
    name: server.name,
    description: server.description,
    enabled: server.enabled,
    transport: server.transport,
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    env: server.env,
    url: server.url,
    headers: server.headers,
  };
}

function serverFromStored(value: unknown): McpServerConfig | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = String(record.id ?? '').trim();
  const transport = transportFrom(record.transport);
  if (!id || !transport) return null;
  return {
    id,
    name: String(record.name ?? id),
    description: String(record.description ?? ''),
    enabled: record.enabled !== false,
    transport,
    command: optionalString(record.command),
    args: stringArray(record.args),
    cwd: optionalString(record.cwd),
    env: stringRecord(record.env),
    url: optionalString(record.url),
    headers: stringRecord(record.headers),
    raw: { ...record, source: 'cardbush_product' },
  };
}

function transportFrom(value: unknown): McpTransport | null {
  return value === 'stdio' || value === 'streamable_http' || value === 'sse' || value === 'http'
    ? value
    : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String) : [];
}

function stringRecord(value: unknown) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item)]),
  );
}

function optionalString(value: unknown) {
  const normalized = String(value ?? '').trim();
  return normalized || undefined;
}

async function productHostMcp(
  kind: 'mcp.get' | 'mcp.update',
  config?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const execute = window.cardbushDesktop?.productHostCommand;
  if (!execute) throw new Error('CardBush Product Host is unavailable.');
  const response = await execute({
    protocol: 'cardbush.product_host_ipc.v1',
    kind,
    ...(config ? { config } : {}),
  });
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('CardBush Product Host returned an invalid MCP response.');
  }
  const envelope = response as Record<string, unknown>;
  if (envelope.ok !== true) {
    const error = envelope.error && typeof envelope.error === 'object'
      ? envelope.error as Record<string, unknown> : {};
    throw new Error(String(error.message ?? 'Product MCP configuration failed.'));
  }
  if (!envelope.value || typeof envelope.value !== 'object' || Array.isArray(envelope.value)) {
    throw new Error('Product MCP configuration payload is invalid.');
  }
  return envelope.value as Record<string, unknown>;
}
