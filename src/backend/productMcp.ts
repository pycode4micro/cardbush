import {
  BUSH_MCP_SNAPSHOT_PROTOCOL,
  mcpSnapshotSchema,
  type McpSnapshot,
  type McpSnapshotResult,
} from '@cardbush/bush-protocol';

import type { McpServerConfig, McpTransport } from '../types';
import type { ProtocolRuntimeClient } from '../runtime-client/ProtocolRuntimeClient';

const serverStorageKey = 'cardbush_product_mcp_servers_v1';
const revisionStorageKey = 'cardbush_product_mcp_revision_v1';
const snapshotId = 'cardbush-product-mcp';

export function readProductMcpServers(): McpServerConfig[] {
  const raw = window.localStorage.getItem(serverStorageKey);
  if (!raw?.trim()) return [];
  try {
    const decoded: unknown = JSON.parse(raw);
    return Array.isArray(decoded)
      ? decoded.map(serverFromStored).filter((value): value is McpServerConfig => value != null)
      : [];
  } catch {
    return [];
  }
}

export async function synchronizeProductMcpSnapshot(
  client: Pick<ProtocolRuntimeClient, 'applyMcpSnapshot'>,
): Promise<McpSnapshotResult> {
  return client.applyMcpSnapshot(snapshot(
    await withProductOwnedServers(readProductMcpServers()),
    readRevision(),
  ));
}

export async function replaceProductMcpServers(
  client: Pick<ProtocolRuntimeClient, 'applyMcpSnapshot'>,
  servers: McpServerConfig[],
): Promise<McpSnapshotResult> {
  const previousServers = window.localStorage.getItem(serverStorageKey);
  const previousRevision = window.localStorage.getItem(revisionStorageKey);
  const revision = readRevision() + 1;
  window.localStorage.setItem(serverStorageKey, JSON.stringify(servers.map(storedServer)));
  window.localStorage.setItem(revisionStorageKey, String(revision));
  try {
    return await client.applyMcpSnapshot(snapshot(
      await withProductOwnedServers(servers),
      revision,
    ));
  } catch (error) {
    restore(serverStorageKey, previousServers);
    restore(revisionStorageKey, previousRevision);
    throw error;
  }
}

export function validateProductMcpServer(server: McpServerConfig) {
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
      defaultToolPolicy: {
        permission: 'ask',
        parallelSafe: false,
        visibleToChild: true,
      },
      toolPolicies: {},
    })),
  };
}

async function withProductOwnedServers(
  configured: McpServerConfig[],
): Promise<McpServerConfig[]> {
  const bridge = window.cardbushDesktop?.cardbushAppMcpServer;
  if (!bridge) return configured;
  const builtin = serverFromProduct(await bridge());
  return [
    ...configured.filter((server) => server.id !== builtin.id),
    builtin,
  ];
}

function serverFromProduct(value: unknown): McpServerConfig {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CardBush App returned an invalid MCP server descriptor.');
  }
  const record = value as Record<string, unknown>;
  if (
    record.id !== 'cardbush_app'
    || record.transport !== 'streamable_http'
    || record.enabled !== true
  ) {
    throw new Error('CardBush App returned an unsupported MCP server descriptor.');
  }
  const url = optionalString(record.url);
  if (!url) throw new Error('CardBush App MCP endpoint is missing.');
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
    throw new Error('CardBush App MCP endpoint must use IPv4 loopback HTTP.');
  }
  return {
    id: 'cardbush_app',
    name: String(record.name ?? 'CardBush App'),
    description: String(record.description ?? ''),
    enabled: true,
    transport: 'streamable_http',
    args: [],
    url: parsed.toString(),
    headers: stringRecord(record.headers),
    raw: { source: 'cardbush_product' },
  };
}

function readRevision() {
  const value = Number(window.localStorage.getItem(revisionStorageKey));
  return Number.isInteger(value) && value > 0 ? value : 1;
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
    timeoutSeconds: server.timeoutSeconds,
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
    timeoutSeconds: positiveInteger(record.timeoutSeconds),
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

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function restore(key: string, value: string | null) {
  if (value == null) window.localStorage.removeItem(key);
  else window.localStorage.setItem(key, value);
}
