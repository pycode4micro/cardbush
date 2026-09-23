import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const limit = 64 * 1024 * 1024;
const filePart = z.object({ name: z.string(), size: z.number().int().min(0).max(limit),
  offset: z.number().int().min(0), content: z.string().max(710_000).regex(/^[A-Za-z0-9+/]*={0,2}$/), done: z.boolean() });
type Grant = { owner: number; connectionId: string; sessionId: string; absolute: boolean };

/** An opaque, disposable origin reads only through the selected Agent's workspace API. */
export class AgentFilePreviews {
  readonly #grants = new Map<string, Grant>();
  constructor(readonly read: (connectionId: string, input: { sessionId: string; path: string; offset: number }) => Promise<unknown>,
    readonly contentType: (path: string) => string) {}

  create(owner: number, connectionId: string, sessionId: string, filePath: string) {
    z.string().min(1).max(200).parse(connectionId); z.string().min(1).max(200).parse(sessionId);
    z.string().min(1).max(16000).refine(value => !/[\x00-\x1f]/.test(value)).parse(filePath);
    const normalized = filePath.replaceAll('\\', '/');
    if (/^[a-z][a-z0-9+.-]*:/i.test(normalized) && !/^[a-z]:\//i.test(normalized)) throw Error('Expected an Agent file path.');
    if ([...this.#grants.values()].filter(grant => grant.owner === owner).length >= 128) throw Error('Too many open Agent previews.');
    const id = randomUUID();
    this.#grants.set(id, { owner, connectionId, sessionId, absolute: normalized.startsWith('/') });
    return { id, url: `cardbush-agent://${id}/${normalized.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}` };
  }
  release(owner: number, id: string) { if (this.#grants.get(id)?.owner === owner) this.#grants.delete(id); }
  releaseOwner(owner: number) { for (const [id, grant] of this.#grants) if (grant.owner === owner) this.#grants.delete(id); }

  async respond(request: Request): Promise<Response> {
    const url = new URL(request.url), grant = this.#grants.get(url.hostname);
    if (url.protocol !== 'cardbush-agent:' || !grant || url.username || url.password) return new Response('Preview expired', { status: 404 });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    let path: string;
    try { path = decodeURIComponent(url.pathname).slice(grant.absolute ? 0 : 1); }
    catch { return new Response('Invalid path', { status: 400 }); }
    if (!path || /[\x00-\x1f]/.test(path)) return new Response('Invalid path', { status: 400 });
    // Fetching arbitrary local/protocol URLs is never a fallback. The service
    // resolves real paths and rejects escapes from this session's workspace.
    const read = async (offset: number) => {
      request.signal.throwIfAborted();
      if (this.#grants.get(url.hostname) !== grant) throw Error('Preview expired');
      const part = filePart.parse(await this.read(grant.connectionId, { sessionId: grant.sessionId, path, offset }));
      request.signal.throwIfAborted();
      if (this.#grants.get(url.hostname) !== grant) throw Error('Preview expired');
      const bytes = Buffer.from(part.content, 'base64');
      if (part.offset !== offset || bytes.length > 512 * 1024 || offset + bytes.length > part.size ||
        part.done !== (offset + bytes.length === part.size) || (!part.done && !bytes.length)) throw Error('Invalid Agent file response');
      return { ...part, bytes };
    };
    try {
      let part = await read(0);
      const size = part.size;
      let start = 0, end = size - 1;
      const range = request.headers.get('range');
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
        start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
      }
      const headers = new Headers({ 'content-type': this.contentType(path), 'content-length': String(Math.max(0, end - start + 1)),
        'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'self' data: blob: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:; connect-src 'self' https:; object-src 'none'; base-uri 'self'; frame-src 'self' https:; form-action 'none'",
      });
      if (range) headers.set('content-range', `bytes ${start}-${end}/${size}`);
      if (request.method === 'HEAD' || !size) return new Response(null, { status: range ? 206 : 200, headers });
      let offset = start, cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull: async controller => {
          try {
            if (offset < part.offset || offset >= part.offset + part.bytes.length) part = await read(offset);
            if (cancelled) return;
            if (part.size !== size) throw Error('Agent file changed during transfer');
            const bytes = part.bytes.subarray(offset - part.offset, Math.min(part.bytes.length, end - part.offset + 1));
            if (!bytes.length) throw Error('Incomplete Agent file response');
            controller.enqueue(bytes); offset += bytes.length;
            if (offset > end) controller.close();
          } catch (error) { if (!cancelled) controller.error(error); }
        },
        cancel: () => { cancelled = true; },
      }, { highWaterMark: 1 });
      return new Response(stream, { status: range ? 206 : 200, headers });
    } catch {
      return new Response('Remote file unavailable. Reconnect the Agent or refresh the preview.', { status: 404 });
    }
  }
}
