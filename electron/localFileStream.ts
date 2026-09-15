import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';

/** File responses keep a bounded byte queue, including open-ended media ranges. */
export async function localFileResponse(filePath: string, contentType: string, request: Request,
  range?: { start: number; end: number }, maxBytes = Infinity): Promise<Response> {
  const handle = await open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Not a file.');
    if (stat.size > maxBytes) return await closeResponse(new Response('文件较大，已暂停内置预览。', { status: 413 }));
    const start = range?.start ?? 0, end = Math.min(range?.end ?? stat.size - 1, stat.size - 1);
    const length = Math.max(0, end - start + 1);
    if (range && !length) return await closeResponse(new Response(null, { status: 416, headers: { 'content-range': `bytes */${stat.size}` } }));
    const headers = { 'content-type': contentType, 'content-length': String(length), 'accept-ranges': 'bytes', 'cache-control': 'no-store',
      ...(range ? { 'content-range': `bytes ${start}-${end}/${stat.size}` } : {}) };
    if (request.method === 'HEAD' || !length) return await closeResponse(new Response(null, { status: range ? 206 : 200, headers }));
    request.signal.throwIfAborted();
    const stream = handle.createReadStream({ start, end, autoClose: true, highWaterMark: 64 * 1024 });
    const abort = () => stream.destroy();
    request.signal.addEventListener('abort', abort, { once: true });
    stream.once('close', () => request.signal.removeEventListener('abort', abort));
    // Explicit byte sizing avoids treating a 64 KiB chunk as one queue unit.
    const body = Readable.toWeb(stream, { strategy: { highWaterMark: 128 * 1024, size: chunk => chunk.byteLength } });
    return new Response(body, { status: range ? 206 : 200, headers });
  } catch (error) { await handle.close(); throw error; }
  async function closeResponse(response: Response): Promise<Response> { await handle.close(); return response; }
}
