import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { BotGateway } from './botGateway.mjs';
import { botError, BotGatewayError } from './botGatewayConfig.mjs';

const prefix = '/api/bots/v1/';
const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), message: z.unknown() }).strict(),
  z.object({ type: z.literal('watch'), messageId: z.string().min(1).max(200) }).strict(),
]);
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(JSON.stringify(value));
}
async function body(request: IncomingMessage) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new BotGatewayError('unsupported_media_type', 415);
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length; if (size > 128 * 1024) throw new BotGatewayError('body_too_large', 413);
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BotGatewayError('invalid_json'); }
}
export async function serveBotGatewayHttp(gateway: BotGateway) {
  const websockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
  const pending = new Set<Promise<unknown>>();
  const authenticate = (request: IncomingMessage) => {
    const url = new URL(request.url ?? '/', 'http://gateway.internal');
    if (!url.pathname.startsWith(prefix) || request.headers.origin !== undefined) throw new BotGatewayError('unauthorized', 401);
    let parts: string[];
    try { parts = url.pathname.slice(prefix.length).split('/').map(decodeURIComponent); }
    catch { throw new BotGatewayError('invalid_path'); }
    const channel = gateway.channel(parts[0]);
    const expected = Buffer.from(`Bearer ${channel.token}`), supplied = Buffer.from(request.headers.authorization ?? '');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new BotGatewayError('unauthorized', 401);
    return { channel, parts };
  };
  const server = createServer((request, response) => {
    const task = (async () => {
      const { channel, parts } = authenticate(request);
      if (parts[1] === 'messages' && parts.length === 2 && request.method === 'POST') {
        const result = await gateway.accept(channel.id, await body(request));
        response.setHeader('Location', `${prefix}${channel.id}/messages/${encodeURIComponent(result.messageId)}`);
        json(response, 202, result);
      } else if (parts[1] === 'messages' && parts.length === 3 && request.method === 'GET') {
        json(response, 200, gateway.get(channel.id, parts[2]));
      } else throw new BotGatewayError('endpoint_not_found', 404);
    })().catch(error => {
      if (!response.headersSent && !response.destroyed) json(response, error instanceof BotGatewayError ? error.status : error instanceof z.ZodError ? 400 : 503, botError(error, gateway.config.language));
      else response.destroy();
      request.resume();
    });
    pending.add(task); void task.finally(() => pending.delete(task));
  });
  server.headersTimeout = 10_000; server.requestTimeout = 15_000; server.maxConnections = 128;
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    try {
      const { channel, parts } = authenticate(request);
      if (parts.length !== 2 || parts[1] !== 'events' || websockets.clients.size >= 64) throw new BotGatewayError('endpoint_not_found', 404);
      websockets.handleUpgrade(request, socket, head, client => {
        let alive = true, queued = 0;
        const watched = new Set<string>();
        const send = (value: unknown) => {
          if (client.readyState !== WebSocket.OPEN) return;
          if (client.bufferedAmount > 1024 * 1024) { client.close(1013); return; }
          client.send(JSON.stringify(value));
        };
        const unsubscribe = gateway.subscribe(receipt => { if (receipt.channelId === channel.id && watched.has(receipt.messageId)) send(receipt); });
        const timer = setInterval(() => { if (!alive) client.terminate(); else { alive = false; client.ping(); } }, 30_000);
        timer.unref(); client.on('pong', () => { alive = true; }); client.on('error', () => {});
        client.once('close', () => { clearInterval(timer); unsubscribe(); });
        send({ protocol: 'cardbush.webhook.v1', type: 'ready', channelId: channel.id });
        client.on('message', (bytes, binary) => {
          if (binary || queued >= 16) { client.close(1008); return; }
          queued++;
          const work = (async () => {
            const command = commandSchema.parse(JSON.parse(bytes.toString()));
            if (watched.size >= 128) throw new BotGatewayError('watch_limit', 429);
            const receipt = command.type === 'message' ? await gateway.accept(channel.id, command.message) : gateway.get(channel.id, command.messageId);
            watched.add(receipt.messageId);
            // Read after subscribing so a completion racing with acceptance is visible.
            send(gateway.get(channel.id, receipt.messageId));
          })().catch(error => send(botError(error instanceof SyntaxError ? new BotGatewayError('invalid_json') : error, gateway.config.language)))
            .finally(() => { queued--; pending.delete(work); });
          pending.add(work);
        });
      });
    } catch (error) {
      const status = error instanceof BotGatewayError ? error.status : 400;
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(gateway.config.port, gateway.config.host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new BotGatewayError('listener_failed');
  return { host: address.address, port: address.port, async close() {
    for (const client of websockets.clients) client.terminate();
    await new Promise<void>(resolve => websockets.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.allSettled([...pending]);
  } };
}
