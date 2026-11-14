import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { WebAgent } from './webAgentPool.mjs';
import type { FileChunk } from './agentFileTransfer.mjs';

export function fileRange(header: string | undefined, size: number): { start: number; end: number; partial: boolean } | null {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end, partial: true };
}

export async function webFileResponse(request: IncomingMessage, response: ServerResponse, agent: WebAgent, path: string, download: boolean, signal: AbortSignal) {
  const file = await agent.call('web.files', { action: 'describe', path }) as { name: string; size: number; mime: string };
  const range = fileRange(request.headers.range, file.size);
  if (!range) { response.writeHead(416, { 'Content-Range': `bytes */${file.size}`, 'Accept-Ranges': 'bytes' }); response.end(); return; }
  const inline = !download && /^(image|audio|video)\//.test(file.mime);
  response.writeHead(range.partial ? 206 : 200, {
    'Content-Type': file.mime, 'Content-Length': Math.max(0, range.end - range.start + 1), 'Accept-Ranges': 'bytes',
    ...(range.partial ? { 'Content-Range': `bytes ${range.start}-${range.end}/${file.size}` } : {}),
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
  });
  if (request.method === 'HEAD') { response.end(); return; }
  let offset = range.start, version: string | undefined;
  while (offset <= range.end) {
    signal.throwIfAborted();
    const chunk = await agent.call('web.files', { action: 'read', path, offset, version }) as FileChunk;
    if (chunk.offset !== offset || chunk.size !== file.size || version && chunk.version !== version) throw new Error('file_transfer_source_changed');
    version = chunk.version;
    const bytes = Buffer.from(chunk.content, 'base64').subarray(0, range.end - offset + 1);
    if (!bytes.length) throw new Error('file_transfer_incomplete');
    if (!response.write(bytes)) await once(response, 'drain', { signal });
    offset += bytes.length;
  }
  response.end();
}
