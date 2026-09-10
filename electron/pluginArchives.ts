import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import JSZip from 'jszip';
import { safePackagePath, withinPackage } from './pluginPackagePaths';

export const pluginArchiveLimits = { compressedBytes: 32 * 1024 * 1024, expandedBytes: 64 * 1024 * 1024,
  fileBytes: 16 * 1024 * 1024, files: 2000, entries: 10000 } as const;

async function loadArchive(archive: Buffer) {
  if (archive.length > pluginArchiveLimits.compressedBytes) throw new Error('Plugin archive exceeds the size limit.');
  return Object.values((await JSZip.loadAsync(archive)).files);
}

/** Repository acquisition selects one declared package from its pinned archive. */
export async function extractPluginArchive(archive: Buffer, pluginPath: string, destination: string) {
  const entries = await loadArchive(archive);
  const roots = new Set(entries.map(file => file.name.split('/')[0]));
  if (roots.size !== 1) throw new Error('Expected a GitHub repository archive.');
  const prefix = `${[...roots][0]}/${pluginPath ? safePackagePath(pluginPath) + '/' : ''}`;
  await extractEntries(entries, prefix, destination);
}

/** Local packages can be flat or include enclosing folders; manifests decide their identity. */
export async function extractLocalPluginArchive(archive: Buffer, destination: string) {
  await extractEntries(await loadArchive(archive), '', destination);
}

async function extractEntries(entries: JSZip.JSZipObject[], prefix: string, destination: string) {
  const selected = entries.filter(file => {
    const original = file.unsafeOriginalName ?? file.name;
    return original.startsWith(prefix) && original.length > prefix.length;
  });
  const fileCount = selected.filter(file => !file.dir).length;
  if (!fileCount || fileCount > pluginArchiveLimits.files || selected.length > pluginArchiveLimits.entries) {
    throw new Error('Plugin folder is missing or exceeds the 2000 file limit.');
  }
  const paths = new Map<string, 'file' | 'directory'>();
  // Validate the complete selection before writing any entries, including empty directories.
  const validated = selected.map(file => {
    const original = file.unsafeOriginalName ?? file.name;
    const name = safePackagePath(original.slice(prefix.length));
    if (original !== file.name) throw new Error('Archive contains conflicting or unsafe paths.');
    const mode = Number(file.unixPermissions ?? 0), type = mode & 0o170000;
    if (type && type !== (file.dir ? 0o040000 : 0o100000)) throw new Error('Plugin archives cannot contain links or special files.');
    const segments = name.toLowerCase().split('/');
    for (let length = 1; length <= segments.length; length++) {
      const key = segments.slice(0, length).join('/');
      const kind = length < segments.length || file.dir ? 'directory' : 'file';
      const previous = paths.get(key);
      if (previous && (previous !== 'directory' || kind !== 'directory')) throw new Error('Archive contains conflicting or unsafe paths.');
      paths.set(key, kind);
    }
    return { file, mode, target: withinPackage(destination, name) };
  });
  let total = 0;
  for (const { file, mode, target } of validated) {
    if (file.dir) { await mkdir(target, { recursive: true }); continue; }
    const data = await new Promise<Buffer>((fulfill, reject) => {
      const stream = file.nodeStream('nodebuffer') as Readable;
      const chunks: Buffer[] = []; let size = 0, settled = false;
      const fail = (error: Error) => { if (!settled) { settled = true; stream.destroy(); reject(error); } };
      stream.on('data', (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > pluginArchiveLimits.fileBytes || total + size > pluginArchiveLimits.expandedBytes) {
          fail(new Error('Expanded plugin exceeds the size limit.')); return;
        }
        chunks.push(chunk);
      }).on('error', fail).on('end', () => {
        if (!settled) { settled = true; fulfill(Buffer.concat(chunks)); }
      });
    });
    total += data.length;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data, { flag: 'wx', mode: mode & 0o111 ? 0o755 : 0o644 });
  }
}
