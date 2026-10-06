import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

/** Standard MCP over an authenticated loopback endpoint owned by the desktop host. */
export async function startDesktopMcpServer(createServerInstance: () => McpServer) {
  const token = randomBytes(32).toString('hex');
  const authorization = Buffer.from(`Bearer ${token}`);
  const handleMcp = createMcpHandler(createServerInstance);
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
      if (!address || typeof address === 'string') { reject(new Error('Desktop MCP endpoint did not bind.')); return; }
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
