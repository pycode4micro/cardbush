import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, lstatSync, unlinkSync } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { RuntimeEvent } from '@cardbush/bush-protocol';
import { cacheFiles, journalChunks, sessionCacheKey, type CacheMaintenanceResult } from './cacheMaintenance.js';

export const EVENT_ARCHIVE_AGE_MS = 7 * 24 * 60 * 60_000;
const MIN_ARCHIVE_BYTES = 64 * 1024;

/** Validate every record without retaining the event history in memory. */
async function inspect(path: string, decode: (path: string, line: number, text: string) => RuntimeEvent, signal?: AbortSignal) {
  const digest = createHash('sha256');
  let parts: Buffer[] = [], size = 0, bytes = 0, sequence = 0;
  let identity: string | undefined, requestId: string | undefined, terminal = false;
  for await (const chunk of journalChunks(path, signal)) {
    signal?.throwIfAborted();
    digest.update(chunk); bytes += chunk.length;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset), end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      size += part.length;
      // Oversized journals remain readable through the existing loader; leave them unchanged here.
      if (size > 64 * 1024 * 1024) throw new Error('Event record exceeds the archive validation limit.');
      parts.push(part);
      if (newline >= 0) {
        const event = decode(path, sequence + 1, Buffer.concat(parts).toString('utf8'));
        const key = JSON.stringify([event.sessionId, event.turnId]);
        identity ??= key; requestId ??= event.requestId;
        if (terminal || key !== identity || event.requestId !== requestId || event.sequence !== sequence + 1 ||
            basename(path).replace(/\.gz$/, '') !== `${sessionCacheKey(key)}.jsonl`) {
          throw new Error('Event journal has inconsistent identity, sequence or terminal state.');
        }
        sequence = event.sequence; terminal = event.kind === 'turn_terminal';
        parts = []; size = 0;
      }
      offset = newline < 0 ? chunk.length : newline + 1;
    }
  }
  if (size) throw new Error('Event journal has an incomplete tail; left for normal recovery.');
  return { hash: digest.digest('hex'), bytes, terminal };
}

async function digestArchive(path: string, signal?: AbortSignal) {
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of journalChunks(path, signal, true)) { digest.update(chunk); bytes += chunk.length; }
  return { hash: digest.digest('hex'), bytes };
}

/** Archive only terminal journals. Original bytes remain authoritative until a verified archive exists. */
export async function archiveRuntimeEvents(root: string, decode: Parameters<typeof inspect>[1], options: {
  signal?: AbortSignal; now?: number; minBytes?: number; isOpen(path: string): boolean;
  after?: string; visited?(path: string): void;
}): Promise<CacheMaintenanceResult> {
  const result: CacheMaintenanceResult = { counts: { archived_files: 0, archived_bytes_saved: 0 }, errors: [] };
  const before = (options.now ?? Date.now()) - EVENT_ARCHIVE_AGE_MS;
  let files = (await cacheFiles(root, name => /^[a-f0-9]{64}\.jsonl$/.test(name)))
    .filter(file => file.mtimeMs <= before && file.bytes >= (options.minBytes ?? MIN_ARCHIVE_BYTES))
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  const previous = files.findIndex(file => file.path === options.after);
  if (previous >= 0) files = [...files.slice(previous + 1), ...files.slice(0, previous + 1)];
  let attempted = 0, scannedBytes = 0;
  for (const file of files) {
    options.signal?.throwIfAborted();
    if (options.isOpen(file.path)) continue;
    // Bound each idle pass; allow one large journal, then yield the remaining work to the next pass.
    if (attempted >= 16 || (attempted > 0 && scannedBytes >= 64 * 1024 * 1024)) break;
    options.visited?.(file.path);
    attempted++; scannedBytes += file.bytes;
    const temporary = join(root, `${randomUUID()}.tmp`), archive = `${file.path}.gz`;
    let createdTemporary = false;
    try {
      const original = await lstat(file.path);
      if (!original.isFile() || original.isSymbolicLink() || original.mtimeMs > before) continue;
      const checked = await inspect(file.path, decode, options.signal);
      if (!checked.terminal) continue;
      const existing = await lstat(archive).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('Archive target is not an owned regular file.');
      if (!existing) {
        const handle = await open(temporary, 'wx', 0o600);
        createdTemporary = true;
        await handle.close();
        await pipeline(createReadStream(file.path), createGzip(), createWriteStream(temporary), { signal: options.signal });
      }
      const archived = await digestArchive(existing ? archive : temporary, options.signal);
      if (archived.hash !== checked.hash || archived.bytes !== checked.bytes) throw new Error('Archive verification failed; original retained.');
      const compressedBytes = (await lstat(existing ? archive : temporary)).size;
      if (compressedBytes >= original.size) continue;
      if (!existing) {
        const handle = await open(temporary, 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
        // An exclusive hard link publishes a complete file without overwriting a competing archive.
        await link(temporary, archive);
      }
      options.signal?.throwIfAborted();
      // No await between the final ownership/change check and unlink. The host also holds its idle maintenance guard.
      const current = lstatSync(file.path);
      if (options.isOpen(file.path) || !current.isFile() || current.isSymbolicLink() || current.ino !== original.ino ||
          current.dev !== original.dev || current.size !== original.size || current.mtimeMs !== original.mtimeMs) {
        throw new Error('Event journal changed during archiving; original retained.');
      }
      unlinkSync(file.path);
      result.counts.archived_files!++;
      result.counts.archived_bytes_saved! += original.size - compressedBytes;
    } catch (error) {
      options.signal?.throwIfAborted();
      result.errors.push(`events: ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (createdTemporary) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') result.errors.push(`Archive staging cleanup: ${error.message}`); });
    }
  }
  return result;
}
