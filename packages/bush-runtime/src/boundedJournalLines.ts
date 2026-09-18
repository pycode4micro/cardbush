import { createReadStream } from 'node:fs';

/** Complete lines only. Oversized payloads are skipped without retaining them. */
export async function* boundedJournalLines(path: string, options: {
  start?: number; end?: number; maxBytes: number; signal?: AbortSignal; skip?: (prefix: string) => boolean;
}) {
  let start = options.start ?? 0, position = start, length = 0;
  let parts: Buffer[] = [], prefix = Buffer.alloc(0);
  let skipped = false;
  if (options.end !== undefined && options.end <= start) return;
  const stream = createReadStream(path, { start, ...(options.end === undefined ? {} : { end: options.end - 1 }),
    highWaterMark: 64 * 1024, signal: options.signal });
  for await (const chunk of stream) {
    const bytes = chunk as Buffer;
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset);
      const stop = newline < 0 ? bytes.length : newline;
      const part = bytes.subarray(offset, stop);
      length += part.length;
      if (prefix.length < 4096) prefix = Buffer.concat([prefix, part.subarray(0, 4096 - prefix.length)]);
      skipped ||= options.skip?.(prefix.toString('utf8')) === true;
      if (!skipped && length <= options.maxBytes) parts.push(part); else parts = [];
      position += part.length;
      if (newline >= 0) {
        position++;
        yield { start, end: position, prefix: prefix.toString('utf8'),
          text: !skipped && length <= options.maxBytes ? Buffer.concat(parts).toString('utf8') : undefined };
        start = position; length = 0; parts = []; prefix = Buffer.alloc(0); skipped = false;
      }
      offset = newline < 0 ? bytes.length : newline + 1;
    }
  }
}
