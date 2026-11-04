import { withWorkspaceFileAccess, openWorkspaceFile } from '@cardbush/bush-runtime';
import { basename, extname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { BOT_MAX_FILE_BYTES, BOT_MAX_TOTAL_BYTES, type BotCapabilities, type BotFileAccess } from '@cardbush/bush-protocol';
import { WebhookError } from './contextWebhookProtocol.mjs';

const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.txt': 'text/plain', '.csv': 'text/csv', '.zip': 'application/zip' };
export async function snapshotWebhookFiles(paths: string[], capabilities: BotCapabilities, signal?: AbortSignal, access?: BotFileAccess[]) {
  if (!paths.length) return [];
  return withWorkspaceFileAccess(paths, false, async () => {
  const files = []; let total = 0;
  for (const [index, path] of paths.entries()) {
    signal?.throwIfAborted();
    if (!isAbsolute(path)) throw new WebhookError('local_file_required');
    const handle = await openWorkspaceFile(path);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new WebhookError('regular_file_required');
      if (info.size > Math.min(capabilities.maxFileBytes, BOT_MAX_FILE_BYTES)) throw new WebhookError('file_too_large');
      if (total + info.size > Math.min(capabilities.maxTotalBytes, BOT_MAX_TOTAL_BYTES)) throw new WebhookError('files_too_large');
      // Read the opened file into a bounded snapshot. Growth never increases the limit.
      const bytes = Buffer.alloc(info.size); let read = 0;
      while (read < bytes.length) {
        signal?.throwIfAborted();
        const next = await handle.read(bytes, read, bytes.length - read, read);
        if (!next.bytesRead) throw new WebhookError('file_changed');
        read += next.bytesRead;
      }
      const after = await handle.stat();
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new WebhookError('file_changed');
      total += bytes.length;
      files.push({ bytes, part: `file_${index}`, name: basename(path).replace(/[\r\n\0]/g, '_').slice(0, 220),
        mimeType: types[extname(path).toLowerCase()] ?? 'application/octet-stream', size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') });
    } finally { await handle.close(); }
  }
  return files;
  }, { signal, ...(access ? { expectedIdentities: Object.fromEntries(access.map(file => [file.path, file.identity])) } : {}) });
}
export async function readBotAcknowledgement(response: Response) {
  const reader = response.body?.getReader(); if (!reader) throw new WebhookError('bot_ack_missing');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length; if (size > 16384) throw new WebhookError('bot_ack_too_large');
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } finally { await reader.cancel().catch(() => {}); }
}
