import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { mcpServerSnapshotSchema } from '@cardbush/bush-protocol';
import { z } from 'zod';

export const PRODUCT_MCP_MANAGEMENT_ID = 'cardbush_management';
const reservedIds = new Set([PRODUCT_MCP_MANAGEMENT_ID, 'cardbush_apps', 'chrome_devtools']);
const serverId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const stringChanges = z.record(z.string(), z.string().nullable());
export const mcpServerPatchSchema = z.object({
  id: serverId,
  name: z.string().optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  transport: z.enum(['stdio', 'http', 'streamable_http', 'sse']).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: stringChanges.optional(),
  url: z.string().optional(),
  headers: stringChanges.optional(),
}).strict();
export type McpServerPatch = z.infer<typeof mcpServerPatchSchema>;

export interface ProductMcpManagementHost {
  listMcpServers(): Promise<unknown>;
  configureMcpServer(input: McpServerPatch, signal?: AbortSignal): Promise<unknown>;
  removeMcpServer(id: string, signal?: AbortSignal): Promise<unknown>;
}

export function assertUserMcpServerId(id: string): void {
  serverId.parse(id);
  if (reservedIds.has(id) || id.startsWith('plugin_')) {
    throw new Error(`${id} belongs to a CardBush integration or plugin; manage it through its owner.`);
  }
}

export function mergeMcpServer(current: Record<string, unknown> | undefined, input: unknown) {
  const patch = mcpServerPatchSchema.parse(input);
  assertUserMcpServerId(patch.id);
  const server: Record<string, unknown> = {
    name: patch.id, description: '', enabled: true, ...current, ...patch,
  };
  for (const key of ['env', 'headers'] as const) {
    if (!patch[key]) continue;
    const values = { ...asRecord(current?.[key]) };
    for (const [name, value] of Object.entries(patch[key])) {
      if (value === null) delete values[name];
      else values[name] = value;
    }
    server[key] = values;
  }
  mcpServerSnapshotSchema.parse({
    id: server.id,
    transport: server.transport === 'stdio' ? {
      kind: 'stdio', command: server.command, args: server.args ?? [],
      ...(server.cwd ? { cwd: server.cwd } : {}), env: server.env ?? {},
    } : {
      kind: server.transport === 'http' ? 'streamable_http' : server.transport,
      url: server.url, headers: server.headers ?? {},
    },
  });
  return server;
}

/** Management observations expose configuration identity, never stored credentials. */
export function publicMcpServer(server: Record<string, unknown>) {
  return {
    id: server.id,
    name: server.name ?? server.id,
    description: server.description ?? '',
    enabled: server.enabled,
    transport: server.transport,
    environmentKeys: Object.keys(asRecord(server.env)),
    headerNames: Object.keys(asRecord(server.headers)),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function createProductMcpManagementServer(getHost: () => ProductMcpManagementHost) {
  const server = new McpServer({ name: PRODUCT_MCP_MANAGEMENT_ID, version: '1.0.0' });
  const result = async (operation: () => Promise<unknown>) => {
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(await operation()) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
      };
    }
  };
  server.registerTool('list_mcp_servers', {
    description: 'Read CardBush MCP configuration identities and the actual Runtime connection state and discovered tool names. CardBush has a native MCP client. A missing tool alone does not establish that its server is unconfigured or unsupported. Stored credentials are omitted.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => result(() => getHost().listMcpServers()));
  server.registerTool('configure_mcp_server', {
    description: 'Add or update a third-party MCP connection in CardBush. New servers require a transport and command or URL. Only supplied fields change; env/headers merge by key and null removes a key. Install server dependencies and any target-application add-on using that software’s installer. This registers the CardBush connection; it does not install an add-on into Blender or another application. Active turns queue changes: saved/pending is not connected, and new tools become available after active turns finish.',
    inputSchema: mcpServerPatchSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async (input, context) => result(() => getHost().configureMcpServer(input, context.mcpReq.signal)));
  server.registerTool('remove_mcp_server', {
    description: 'Remove one user-configured MCP connection from CardBush. Package files and target-application add-ons are retained. CardBush and plugin-owned connections must be managed through their owner. Active turns may defer disconnection.',
    inputSchema: { id: serverId },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ id }, context) => result(() => getHost().removeMcpServer(id, context.mcpReq.signal)));
  return server;
}

/** Standard MCP over an authenticated loopback endpoint; Product Host remains the owner. */
export async function startProductMcpManagement(getHost: () => ProductMcpManagementHost) {
  const token = randomBytes(32).toString('hex');
  const authorization = Buffer.from(`Bearer ${token}`);
  const handleMcp = createMcpHandler(() => createProductMcpManagementServer(getHost));
  const requests = new Set<AbortController>();
  let url = '';
  const server = createServer((request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (request.headers.host !== new URL(url).host || request.headers.origin ||
        supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
      response.writeHead(403).end();
      request.resume();
      return;
    }
    if (request.url !== '/mcp') {
      response.writeHead(404).end();
      request.resume();
      return;
    }
    const abort = new AbortController();
    requests.add(abort);
    response.on('close', () => { abort.abort(); requests.delete(abort); });
    void (async () => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { response.writeHead(413).end(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const result = await handleMcp.fetch(new Request(url, {
        method: request.method, headers, signal: abort.signal,
        ...(chunks.length ? { body: Buffer.concat(chunks).toString('utf8') } : {}),
      }));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) await pipeline(Readable.fromWeb(result.body), response);
      else response.end();
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
      else response.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('MCP management endpoint did not bind.')); return; }
      url = `http://127.0.0.1:${address.port}/mcp`;
      resolve();
    });
  });
  server.unref();
  return {
    url, token,
    close: async () => {
      for (const request of requests) request.abort();
      server.closeAllConnections();
      await handleMcp.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
