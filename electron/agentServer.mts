import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { z } from 'zod';
import { AgentService } from './agentService.mjs';
import { agentApiPath, agentOperations, type AgentEventFrame } from './agentTypes.js';

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));
}
async function body(request: IncomingMessage) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'Use application/json.');
  let bytes = 0; const chunks: Buffer[] = [];
  // Do not destroy the socket before the client can receive a 413 response.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) throw new HttpError(413, 'body_too_large', 'Request exceeds 2 MiB.');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'invalid_json', 'Invalid JSON request.'); }
}
function encodeFrame(frame: AgentEventFrame, sse: boolean) {
  if (!sse) return JSON.stringify(frame) + '\n';
  if (frame.type === 'heartbeat') return ': heartbeat\n\n';
  return `${frame.type === 'event' ? `id: ${frame.event.sequence}\n` : ''}event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`;
}
async function writeFrame(response: ServerResponse, frame: AgentEventFrame, sse: boolean, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!response.write(encodeFrame(frame, sse))) {
    // Bound a stalled reader; reconnecting clients replay from their last cursor.
    await once(response, 'drain', { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
  }
}

/** Direct, versioned HTTP API. Plugin MCP connections remain inside AgentService. */
export async function serveAgentHttp(service: AgentService, options: { host?: string; port?: number; token: string }) {
  if (options.token.length < 32) throw new Error('Use an Agent access token of at least 32 characters.');
  const authorization = Buffer.from(`Bearer ${options.token}`);
  const requests = new Set<AbortController>();
  const pending = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const abort = new AbortController(); requests.add(abort);
    response.once('close', () => { abort.abort(); requests.delete(abort); });
    const task = (async () => {
      const supplied = Buffer.from(request.headers.authorization ?? '');
      if (request.headers.origin !== undefined || supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
        response.setHeader('WWW-Authenticate', 'Bearer');
        throw new HttpError(401, 'unauthorized', 'Agent authentication required.');
      }
      const info = service.info();
      response.setHeader('X-CardBush-Agent-ID', info.id);
      if (request.headers['x-cardbush-agent-id'] && request.headers['x-cardbush-agent-id'] !== info.id) throw new HttpError(409, 'agent_identity_changed', 'Agent identity changed. Add a new connection after verifying the server.');
      const url = new URL(request.url ?? '/', 'http://agent.internal');
      const method = url.pathname === `${agentApiPath}/call` ? 'POST'
        : ['/health', `${agentApiPath}/info`, `${agentApiPath}/events`].includes(url.pathname) ? 'GET' : null;
      if (!method) throw new HttpError(404, 'not_found', 'Unknown Agent HTTP endpoint.');
      if (request.method !== method) { response.setHeader('Allow', method); throw new HttpError(405, 'method_not_allowed', `Use ${method}.`); }
      if (url.pathname === '/health' || url.pathname === `${agentApiPath}/info`) { json(response, 200, info); return; }
      if (url.pathname === `${agentApiPath}/call`) {
        const input = z.object({ operation: z.enum(agentOperations), input: z.record(z.string(), z.unknown()).default({}) }).strict().parse(await body(request));
        // Losing this HTTP request never cancels a submitted task or replays it.
        const result = await service.call(input.operation, input.input, abort.signal);
        if (!abort.signal.aborted) json(response, 200, { result: result ?? null });
        return;
      }
      const rawCursor = url.searchParams.get('afterSequence') ?? request.headers['last-event-id'];
      if (rawCursor !== undefined && (typeof rawCursor !== 'string' || !/^\d+$/.test(rawCursor))) throw new HttpError(400, 'invalid_cursor', 'Event cursor must be a non-negative integer.');
      const afterSequence = rawCursor === undefined ? undefined : Number(rawCursor);
      const stream = service.eventStream({ sessionId: url.searchParams.get('sessionId'), turnId: url.searchParams.get('turnId'), ...(afterSequence === undefined ? {} : { afterSequence }) }, abort.signal);
      const accept = request.headers.accept ?? 'text/event-stream';
      const sse = accept.includes('text/event-stream') || accept === '*/*';
      if (!sse && !accept.includes('application/x-ndjson')) throw new HttpError(406, 'unsupported_stream', 'Use text/event-stream or application/x-ndjson.');
      response.writeHead(200, { 'Content-Type': sse ? 'text/event-stream; charset=utf-8' : 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
      response.flushHeaders();
      await writeFrame(response, { type: 'ready', agentId: info.id }, sse, abort.signal);
      const heartbeat = setInterval(() => {
        if (!abort.signal.aborted && !response.writableNeedDrain) response.write(encodeFrame({ type: 'heartbeat' }, sse));
      }, 15_000);
      heartbeat.unref();
      let cursor = afterSequence ?? null;
      try {
        for await (const event of stream) {
          await writeFrame(response, { type: 'event', event }, sse, abort.signal);
          cursor = event.sequence;
        }
        await writeFrame(response, { type: 'end', afterSequence: cursor }, sse, abort.signal);
        response.end();
      } catch (error) {
        if (!abort.signal.aborted && !response.writableNeedDrain) {
          response.end(encodeFrame({ type: 'error', error: error instanceof Error ? error.message : 'Agent event stream failed.' }, sse));
        } else response.destroy();
      } finally { clearInterval(heartbeat); abort.abort(); }
    })().catch(error => {
      if (!response.headersSent && !response.destroyed) {
        const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 409;
        json(response, status, { error: { code: error instanceof HttpError ? error.code : status === 400 ? 'invalid_request' : 'operation_failed', message: error instanceof Error ? error.message : 'Agent request failed.' } });
      } else if (!response.writableEnded) response.destroy();
      request.resume();
    });
    pending.add(task); void task.finally(() => pending.delete(task));
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 4780, options.host ?? '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Agent HTTP listener did not bind.');
  return { port: address.port, close: async () => {
    for (const abort of requests) abort.abort();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.allSettled([...pending]);
  } };
}
