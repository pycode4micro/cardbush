import { mkdir, open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';

const chunkSize = 512 * 1024;
const maxSize = 64 * 1024 * 1024;
function inside(root: string, path: string) {
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('File is outside this conversation workspace.');
  return path;
}
export async function agentFileRead(root: string, input: Record<string, unknown>) {
  const value = z.object({ path: z.string().min(1), offset: z.number().int().nonnegative().default(0) }).parse(input);
  const canonical = await realpath(root);
  const path = inside(canonical, await realpath(isAbsolute(value.path) ? value.path : join(canonical, value.path)));
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxSize) throw new Error('Only files up to 64 MiB can be transferred.');
    const buffer = Buffer.alloc(Math.min(chunkSize, Math.max(0, info.size - value.offset)));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, value.offset);
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
