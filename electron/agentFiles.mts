import { mkdir, open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { RuntimeFileReceipt } from '@cardbush/bush-protocol';

const chunkSize = 512 * 1024;
const maxSize = 64 * 1024 * 1024;
interface FileReceiptAccess {
  roots: string[];
  resolveReceipt(path: string): Promise<RuntimeFileReceipt | null | undefined>;
  readImageSnapshot(path: string): Promise<{ content: Buffer }>;
}
function isInside(root: string, path: string) {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\');
}
function inside(root: string, path: string) {
  if (!isInside(root, path)) throw new Error('File is outside this conversation workspace.');
  return path;
}
export async function agentFileRead(root: string, input: Record<string, unknown>, access?: FileReceiptAccess) {
  const value = z.object({ path: z.string().min(1), offset: z.number().int().nonnegative().default(0) }).parse(input);
  const canonical = await realpath(root);
  const requested = resolve(isAbsolute(value.path) ? value.path : join(canonical, value.path));
  const receipt = await access?.resolveReceipt(requested);
  // Resolve before touching the source: it may have been removed or changed
  // after injection. Never fall back to that mutable external file on failure.
  if (receipt?.kind === 'model_image') {
    const { content } = await access!.readImageSnapshot(receipt.path);
    const name = basename(requested, extname(requested)) + extname(receipt.path).toLowerCase();
    const bytes = content.subarray(value.offset, value.offset + chunkSize);
    return { name, size: content.length, offset: value.offset, content: bytes.toString('base64'), done: value.offset + bytes.length >= content.length };
  }
  const path = await realpath(requested);
  const external = !isInside(canonical, path);
  if (external && receipt?.kind === 'file_memo') {
    // remember_file already admitted the read and recorded a canonical file
    // version. It does not grant siblings, descendants or redirected targets.
    if (relative(receipt.path, path) !== '') throw new Error('File is outside this conversation workspace.');
  } else if (external) {
    // A capture directory is not a blanket read grant. Both its real location
    // and this conversation's persisted native artifact receipt must agree.
    let owned = false;
    for (const captureRoot of access?.roots ?? []) {
      if (!isInside(captureRoot, path)) continue;
      const actualRoot = await realpath(captureRoot);
      if (isInside(actualRoot, path)) { owned = true; break; }
    }
    if (!owned || receipt?.kind !== 'capture') inside(canonical, path);
  }
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxSize) throw new Error('Only files up to 64 MiB can be transferred.');
    if (external && receipt?.kind === 'file_memo' && (info.size !== receipt.size || info.mtimeMs !== receipt.mtimeMs)) {
      throw new Error('文件已变化，请在会话中更新文件回执后重试。File changed since its conversation receipt was recorded.');
    }
    const buffer = Buffer.alloc(Math.min(chunkSize, Math.max(0, info.size - value.offset)));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, value.offset);
    const after = await file.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('File changed during transfer.');
    return { name: basename(path), size: info.size, offset: value.offset, content: buffer.subarray(0, bytesRead).toString('base64'), done: value.offset + bytesRead >= info.size };
  } finally { await file.close(); }
}
export async function agentFileUpload(root: string, input: Record<string, unknown>) {
  const value = z.object({ uploadId: z.string().uuid(), name: z.string().min(1).max(200).regex(/^[^/\\\x00-\x1f:]+$/),
    offset: z.number().int().nonnegative().max(maxSize), content: z.string().max(710_000).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).parse(input);
  if (['.', '..'].includes(value.name)) throw new Error('Invalid file name.');
  const bytes = Buffer.from(value.content, 'base64');
  if (bytes.length > chunkSize || value.offset + bytes.length > maxSize) throw new Error('Upload exceeds 64 MiB.');
  const canonical = await realpath(root);
  const attachmentRoot = join(canonical, '.cardbush-attachments');
  await mkdir(attachmentRoot, { recursive: true });
  inside(canonical, await realpath(attachmentRoot));
  const directory = join(attachmentRoot, value.uploadId);
  await mkdir(directory, { recursive: true });
  inside(canonical, await realpath(directory));
  const path = join(directory, value.name);
  const exists = await stat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  if (exists) inside(directory, await realpath(path));
  const file = await open(path, exists ? 'r+' : 'wx', 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Upload target is not a file.');
    const size = info.size;
    if (size !== value.offset) {
      const previous = Buffer.alloc(bytes.length);
      const { bytesRead } = await file.read(previous, 0, previous.length, value.offset);
      if (size < value.offset + bytes.length || bytesRead !== bytes.length || !previous.equals(bytes)) throw new Error('Upload offset conflict.');
    } else { await file.write(bytes, 0, bytes.length, value.offset); await file.sync(); }
    return { path: join(await realpath(dirname(path)), basename(path)), name: value.name, nextOffset: value.offset + bytes.length };
  } finally { await file.close(); }
}
