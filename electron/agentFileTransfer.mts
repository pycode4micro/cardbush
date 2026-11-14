import { createHash } from 'node:crypto';
import { fromMarkdown } from 'mdast-util-from-markdown';

export const transferLimit = 2 * 1024 * 1024 * 1024;
export const transferChunkSize = 512 * 1024;
export type FileChunk = { name: string; size: number; offset: number; content: string; done: boolean; version?: string };
export type TransferredFile = { path: string; name: string; size: number; sha256: string };

/** The caller admits the source and destination; bytes never enter a model request. */
export async function transferFile(key: string, read: (offset: number, version?: string) => Promise<FileChunk>,
  write: (value: { uploadId: string; name: string; offset: number; content: string; size?: number; sha256?: string }) => Promise<{ path: string; nextOffset: number }>, signal?: AbortSignal): Promise<TransferredFile> {
  signal?.throwIfAborted();
  let chunk = await read(0), offset = 0;
  const { name, size, version } = chunk;
  if (!Number.isSafeInteger(size) || size < 0 || size > transferLimit || !version) throw new Error('file_transfer_invalid_source');
  let destinationName = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180).replace(/[ .]+$/, '') || 'file';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(destinationName)) destinationName = '_' + destinationName;
  const identity = createHash('sha256').update(JSON.stringify([key, name, size, version])).digest('hex');
  const uploadId = `${identity.slice(0,8)}-${identity.slice(8,12)}-4${identity.slice(13,16)}-8${identity.slice(17,20)}-${identity.slice(20,32)}`;
  const hash = createHash('sha256');
  let path = '';
  do {
    signal?.throwIfAborted();
    if (chunk.version !== version || chunk.size !== size || chunk.name !== name || chunk.offset !== offset || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk.content)) throw new Error('file_transfer_source_changed');
    const bytes = Buffer.from(chunk.content, 'base64');
    if (bytes.length > transferChunkSize || offset + bytes.length > size || (!bytes.length && offset < size) || chunk.done !== (offset + bytes.length === size)) throw new Error('file_transfer_invalid_chunk');
    hash.update(bytes);
    const receipt = await write({ uploadId, name: destinationName, offset, content: chunk.content });
    if (receipt.nextOffset !== offset + bytes.length) throw new Error('file_transfer_invalid_receipt');
    path = receipt.path; offset = receipt.nextOffset;
    if (chunk.done) break;
    chunk = await read(offset, version);
  } while (true);
  const sha256 = hash.digest('hex');
  signal?.throwIfAborted();
  const verified = await write({ uploadId, name: destinationName, offset, content: '', size, sha256 });
  if (verified.nextOffset !== size || verified.path !== path) throw new Error('file_transfer_verification_failed');
  return { path, name: destinationName, size, sha256 };
}

/** Only explicitly delivered Markdown links/images; never scrape reasoning or arbitrary paths. */
export function deliveredFilePaths(markdown: string): string[] {
  const tree = fromMarkdown(markdown), definitions = new Map<string, string>(), result = new Set<string>();
  const define = (node: any) => { if (node.type === 'definition') definitions.set(node.identifier, node.url); node.children?.forEach(define); };
  define(tree);
  const visit = (node: any) => {
    if (['code', 'inlineCode', 'html', 'definition'].includes(node.type)) return;
    if (['link', 'image', 'linkReference', 'imageReference'].includes(node.type)) {
      let path = node.url ?? definitions.get(node.identifier);
      if (typeof path === 'string') {
        try {
          if (path.startsWith('file://')) { const url = new URL(path); path = url.hostname ? '' : decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:\/)/, '$1'); }
          else path = decodeURIComponent(path);
          if (/^(?:[A-Za-z]:[\\/]|\/(?!\/))/.test(path) && !/[\x00-\x1f]/.test(path)) result.add(path);
        } catch { /* Malformed links are not file authority. */ }
      }
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  if (result.size > 32) throw new Error('file_transfer_too_many_files');
  return [...result];
}
