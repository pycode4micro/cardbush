import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { posix } from 'node:path';
import { Readable, type Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { WebError } from './webCommon.mjs';
import type { WebAgent, WebAgents } from './webAgentPool.mjs';

type Zip = Transform & {
  entry(source: Readable, options: { name: string }, callback: (error?: Error | null) => void): void;
  finalize(): void;
};
const ZipStream = createRequire(import.meta.url)('zip-stream') as new (options: {
  store: boolean; forceZip64: boolean; highWaterMark: number;
}) => Zip;
const chunkSize = 512 * 1024;
const generatedRoot = '/data/workspaces/generated/';
const personalImage = z.string().min(1).max(1000).refine(path =>
  path.startsWith(generatedRoot) && /\.(png|jpe?g|webp)$/i.test(path) &&
  !/[\\\x00-\x1f\x7f]/.test(path) && !path.slice(generatedRoot.length).split('/').some(part => !part || part === '.' || part === '..'),
  '只能下载当前账号生成的图片。');
export const archiveRequest = z.object({ sessionId: z.string().regex(/^web-[a-f0-9]{40}$/), paths: z.array(personalImage).min(1).max(1024) }).strict();
const description = z.object({ path: personalImage, size: z.number().int().min(0).max(64 * 1024 * 1024), mime: z.enum(['image/png', 'image/jpeg', 'image/webp']) });
const readChunk = z.object({ name: z.string().min(1).max(1000), size: z.number().int().min(0), offset: z.number().int().min(0), content: z.string().max(Math.ceil(chunkSize / 3) * 4), done: z.boolean() });
type Entry = { path: string; name: string; size: number };
type Ticket = {
  id: string; userId: string; token: string; sessionId: string; entries: Entry[]; filename: string;
  state: 'ready' | 'queued' | 'streaming' | 'completed' | 'failed'; completed: number; bytes: number; totalBytes: number;
  expires: number; error?: string;
};

/** A shared bound for metadata and transfers; queued requests hold no image bytes. */
class ArchiveSlots {
  private owners = new Set<string>();
  private waiting: { owner: string; start: () => void }[] = [];
  async acquire(owner: string, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.owners.has(owner) || this.waiting.some(item => item.owner === owner)) throw new WebError(429, '该账号已有下载正在准备或传输，请稍后重试。');
    if (this.waiting.length >= 16) throw new WebError(503, '下载人数较多，请稍后重试。');
    if (this.owners.size >= 2) await new Promise<void>((resolve, reject) => {
      const cancel = () => { this.waiting = this.waiting.filter(item => item !== entry); reject(signal.reason); };
      const entry = { owner, start: () => { signal.removeEventListener('abort', cancel); this.owners.add(owner); resolve(); } };
      signal.addEventListener('abort', cancel, { once: true }); this.waiting.push(entry);
    });
    else this.owners.add(owner);
    let released = false;
    return () => {
      if (released) return; released = true;
      this.owners.delete(owner); this.waiting.shift()?.start();
    };
  }
}

function archiveNames(paths: string[]) {
  const used = new Set<string>();
  return paths.map(path => {
    const extension = posix.extname(path), stem = posix.basename(path, extension).normalize('NFC').replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 180) || '图片';
    const safe = /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(stem) ? '_' + stem : stem;
    let name = safe + extension, suffix = 1;
    while (used.has(name.toLowerCase())) name = `${safe} (${suffix++})${extension}`;
    used.add(name.toLowerCase()); return name;
  });
}

/** Only small manifests are retained. Bytes flow from the authenticated tenant to the HTTP socket. */
export class WebArtifactArchives {
  private tickets = new Map<string, Ticket>();
  private slots = new ArchiveSlots();
  constructor(private agents: WebAgents, private now = Date.now) {}
  private prune() {
    for (const [id, ticket] of this.tickets) if (!['queued', 'streaming'].includes(ticket.state) && ticket.expires <= this.now()) this.tickets.delete(id);
  }
  get(id: string, userId: string, token: string) {
    this.prune();
    const ticket = this.tickets.get(id);
    if (!ticket || ticket.userId !== userId || ticket.token !== token) throw new WebError(404, '下载已失效，请重新点击下载全部。');
    return ticket;
  }
  status(ticket: Ticket) {
    return { id: ticket.id, state: ticket.state, completed: ticket.completed, total: ticket.entries.length, bytes: ticket.bytes, totalBytes: ticket.totalBytes, filename: ticket.filename, ...(ticket.error ? { error: ticket.error } : {}) };
  }
  async prepare(userId: string, token: string, input: z.infer<typeof archiveRequest>, signal: AbortSignal) {
    this.prune();
    // Reserve capacity before awaiting RPCs, including overlapping prepare requests.
    for (const [id, ticket] of this.tickets) if (ticket.userId === userId && ['ready', 'completed', 'failed'].includes(ticket.state)) this.tickets.delete(id);
    if (this.tickets.size >= 256) throw new WebError(503, '下载人数较多，请稍后重试。');
    const paths = [...new Set(archiveRequest.parse(input).paths)], names = archiveNames(paths);
    const ticket: Ticket = { id: randomBytes(32).toString('hex'), userId, token, sessionId: input.sessionId,
      entries: [], filename: `招财-本轮产物-${new Date(this.now()).toISOString().slice(0, 10)}.zip`, state: 'queued', completed: 0, bytes: 0, totalBytes: 0, expires: this.now() + 300_000 };
    this.tickets.set(ticket.id, ticket);
    let release: (() => void) | undefined;
    try {
      release = await this.slots.acquire(userId, AbortSignal.any([signal, AbortSignal.timeout(300_000)]));
      signal.throwIfAborted();
      const agent = await this.agents.get(userId);
      for (const [i, path] of paths.entries()) {
        signal.throwIfAborted();
        const file = description.parse(await agent.call('web.files', { action: 'describe', path }));
        // Symlink aliases cannot broaden the manifest to other personal folders.
        if (file.path !== path) throw new Error('File identity changed');
        ticket.entries.push({ path, name: names[i], size: file.size }); ticket.totalBytes += file.size;
      }
      signal.throwIfAborted(); ticket.state = 'ready'; ticket.expires = this.now() + 300_000;
      return ticket;
    } catch (error) {
      this.tickets.delete(ticket.id);
      if (error instanceof WebError || signal.aborted) throw error;
      throw new WebError(503, '部分产物暂时无法读取，请刷新后重试。');
    } finally { release?.(); }
  }
  async download(ticket: Ticket, response: ServerResponse, signal: AbortSignal, authorized: () => Promise<boolean>) {
    if (ticket.state !== 'ready') throw new WebError(409, '该下载已开始或已结束，请重新点击下载全部。');
    ticket.state = 'queued';
    const cancelled = new AbortController(), combined = AbortSignal.any([signal, cancelled.signal]);
    let release: (() => void) | undefined, zip: Zip | undefined, source: Readable | undefined;
    let pendingRead: Promise<unknown> | undefined, output: Promise<void> | undefined, validating = false;
    const validation = setInterval(() => {
      if (validating || combined.aborted) return;
      validating = true;
      void authorized().then(ok => { if (!ok) cancelled.abort(new Error('下载授权已失效。')); }).catch(() => cancelled.abort()).finally(() => { validating = false; });
    }, 15_000);
    validation.unref();
    const stop = () => { source?.destroy(new Error('下载已中断。')); zip?.destroy(new Error('下载已中断。')); response.destroy(); };
    combined.addEventListener('abort', stop, { once: true });
    try {
      release = await this.slots.acquire(ticket.userId, AbortSignal.any([combined, AbortSignal.timeout(300_000)]));
      combined.throwIfAborted();
      if (!await authorized()) throw new WebError(401, '下载授权已失效。');
      const agent = await this.agents.get(ticket.userId);
      combined.throwIfAborted();
      response.setTimeout(120_000, () => cancelled.abort(new Error('下载连接超时。')));
      response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="artifacts.zip"; filename*=UTF-8''${encodeURIComponent(ticket.filename)}`, 'X-Accel-Buffering': 'no', 'Accept-Ranges': 'none' });
      response.flushHeaders(); ticket.state = 'streaming';
      // STORE avoids recompressing PNG/JPG/WebP. ZIP64 supports archives beyond 4 GiB.
      zip = new ZipStream({ store: true, forceZip64: true, highWaterMark: 64 * 1024 });
      output = pipeline(zip, response, { signal: combined });
      void output.catch(error => cancelled.abort(error));
      for (const entry of ticket.entries) {
        combined.throwIfAborted();
        source = Readable.from(chunks(agent, entry, combined, promise => { pendingRead = promise; }, bytes => { ticket.bytes += bytes; }), { objectMode: false, highWaterMark: chunkSize });
        const input = source, archive = zip;
        await new Promise<void>((resolve, reject) => {
          const fail = (error: Error) => { input.destroy(); archive.destroy(); finish(error); };
          const abort = () => fail(new Error('下载已中断。'));
          const finish = (error?: Error | null) => {
            input.off('error', fail); archive.off('error', fail); combined.removeEventListener('abort', abort);
            if (error) reject(error); else resolve();
          };
          input.once('error', fail); archive.once('error', fail); combined.addEventListener('abort', abort, { once: true });
          archive.entry(input, { name: entry.name }, finish);
        });
        ticket.completed++;
      }
      zip.finalize(); await output;
      ticket.state = 'completed';
    } catch (error) {
      ticket.state = 'failed'; ticket.error = error instanceof WebError ? error.message : '下载已中断，请重新点击下载全部重试。';
      source?.destroy(); zip?.destroy();
      if (response.headersSent) response.destroy();
      throw error;
    } finally {
      clearInterval(validation); combined.removeEventListener('abort', stop);
      // One in-flight tenant RPC can finish after disconnect; never start further reads or release its slot early.
      await pendingRead?.catch(() => {}); await output?.catch(() => {});
      release?.(); ticket.expires = this.now() + 300_000;
    }
  }
}

async function* chunks(agent: WebAgent, entry: Entry, signal: AbortSignal, pending: (read: Promise<unknown>) => void, progress: (bytes: number) => void) {
  let offset = 0;
  do {
    signal.throwIfAborted();
    const request = agent.call('web.files', { action: 'read', path: entry.path, offset }); pending(request);
    const chunk = readChunk.parse(await request); signal.throwIfAborted();
    const bytes = Buffer.from(chunk.content, 'base64');
    if (chunk.name !== posix.basename(entry.path) || chunk.offset !== offset || chunk.size !== entry.size || bytes.length > chunkSize ||
        offset + bytes.length > entry.size || chunk.done !== (offset + bytes.length === entry.size) || (!bytes.length && !chunk.done)) throw new Error('Invalid file chunk');
    offset += bytes.length; progress(bytes.length); yield bytes;
  } while (offset < entry.size);
}
