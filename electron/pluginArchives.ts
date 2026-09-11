import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { Parser } from 'tar';
import JSZip from 'jszip';
import { safePackagePath } from './pluginPackagePaths';
import { archiveLinkError, archivePath, materializePluginArchive, pluginArchiveLimits, type PluginArchiveEntry } from './pluginArchiveTree';

export { pluginArchiveLimits } from './pluginArchiveTree';

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
  const unpacked: PluginArchiveEntry[] = [];
  let total = 0;
  for (const file of selected) {
    const original = file.unsafeOriginalName ?? file.name;
    const path = archivePath(original.slice(prefix.length));
    if (original !== file.name) throw new Error(`Archive contains a conflicting or unsafe path: ${JSON.stringify(original)}.`);
    const mode = Number(file.unixPermissions ?? 0), type = mode & 0o170000;
    const link = type === 0o120000 && !file.dir;
    if (!link && type && type !== (file.dir ? 0o040000 : 0o100000)) {
      throw new Error(`Unsupported plugin archive entry ${JSON.stringify(path)}: special file (mode ${mode.toString(8)}).`);
    }
    if (file.dir) { unpacked.push({ path, kind: 'directory' }); continue; }
    const limit = Math.min(link ? pluginArchiveLimits.linkBytes : pluginArchiveLimits.fileBytes, pluginArchiveLimits.expandedBytes - total);
    const data = await readZipEntry(file, limit);
    total += data.length;
    if (link) {
      let linkpath: string;
      try { linkpath = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
      catch { throw new Error(`Plugin link ${JSON.stringify(path)} has an invalid UTF-8 target.`); }
      unpacked.push({ path, kind: 'symlink', linkpath });
    } else unpacked.push({ path, kind: 'file', data, mode });
  }
  await materializePluginArchive(unpacked, destination);
}

async function readZipEntry(file: JSZip.JSZipObject, limit: number): Promise<Buffer> {
  return new Promise((fulfill, reject) => {
    const stream = file.nodeStream('nodebuffer') as Readable;
    const chunks: Buffer[] = []; let size = 0, settled = false;
    const fail = (error: Error) => { if (!settled) { settled = true; stream.destroy(); reject(error); } };
    stream.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) { fail(new Error(`Expanded plugin exceeds the size limit at ${JSON.stringify(file.name)}.`)); return; }
      chunks.push(chunk);
    }).on('error', fail).on('end', () => {
      if (!settled) { settled = true; fulfill(Buffer.concat(chunks)); }
    });
  });
}

/** npm tarballs use the same link resolution and output limits as ZIP/Git packages. */
export async function extractNpmPluginArchive(file: string, destination: string) {
  if ((await stat(file)).size > pluginArchiveLimits.compressedBytes) throw new Error('Plugin archive exceeds the size limit.');
  const unpacked: PluginArchiveEntry[] = [];
  await new Promise<void>((fulfill, reject) => {
    const input = createReadStream(file);
    const parser = new Parser({ strict: true, maxDecompressionRatio: 2000 });
    let count = 0, files = 0, total = 0, compressed = 0, failed = false;
    parser.on('error', error => {
      if (failed) return;
      failed = true; input.destroy(); parser.abort(error);
      const path = (error as Error & { header?: { path?: string }; entry?: { path?: string } }).header?.path
        ?? (error as Error & { entry?: { path?: string } }).entry?.path;
      reject(path ? new Error(`Invalid plugin archive entry ${JSON.stringify(path)}: ${error.message}`, { cause: error }) : error);
    });
    parser.once('end', fulfill);
    input.once('error', error => parser.abort(error));
    input.on('data', chunk => {
      compressed += chunk.length;
      if (compressed > pluginArchiveLimits.compressedBytes) parser.abort(new Error('Plugin archive exceeds the size limit.'));
    });
    parser.on('ignoredEntry', entry => parser.abort(new Error(`Unsupported plugin archive entry ${JSON.stringify(entry.path)}: ${entry.type}.`)));
    parser.on('entry', entry => {
      if (failed) { entry.resume(); return; }
      try {
        if (++count > pluginArchiveLimits.entries) throw new Error('Plugin archive exceeds the entry limit.');
        if (!['File', 'Directory', 'OldFile', 'SymbolicLink', 'Link'].includes(entry.type)) {
          throw new Error(`Unsupported plugin archive entry ${JSON.stringify(entry.path)}: ${entry.type}.`);
        }
        if (!entry.path.startsWith('package/') || entry.header.path?.includes('\\')) throw new Error(`Invalid npm archive root: ${JSON.stringify(entry.path)}.`);
        if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(`Invalid archive entry size: ${JSON.stringify(entry.path)}.`);
        if (entry.type === 'Directory') {
          if (entry.size) throw new Error(`Invalid archive directory data: ${JSON.stringify(entry.path)}.`);
          if (entry.path !== 'package/') unpacked.push({ path: archivePath(entry.path.slice(8)), kind: 'directory' });
          entry.resume(); return;
        }
        const path = archivePath(entry.path.slice(8));
        if (++files > pluginArchiveLimits.files) throw new Error('Plugin archive exceeds the 2000 file limit.');
        if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
          const target = entry.linkpath ?? '';
          if (entry.size || entry.header.linkpath?.includes('\\')) throw archiveLinkError(path, target, 'invalid link entry');
          if (entry.type === 'Link' && !target.startsWith('package/')) throw archiveLinkError(path, target, 'hard link target is outside the plugin package');
          unpacked.push({ path, kind: entry.type === 'Link' ? 'hardlink' : 'symlink', linkpath: entry.type === 'Link' ? target.slice(8) : target });
          entry.resume(); return;
        }
        total += entry.size;
        if (entry.size > pluginArchiveLimits.fileBytes || total > pluginArchiveLimits.expandedBytes) throw new Error(`Expanded plugin exceeds the size limit at ${JSON.stringify(path)}.`);
        const chunks: Buffer[] = []; let size = 0;
        entry.on('data', (chunk: Buffer) => {
          if (failed) return;
          size += chunk.length;
          if (size > entry.size) { parser.abort(new Error(`Archive entry size changed: ${JSON.stringify(path)}.`)); return; }
          chunks.push(chunk);
        });
        entry.once('end', () => {
          if (failed) return;
          if (size !== entry.size) { parser.abort(new Error(`Truncated plugin archive entry: ${JSON.stringify(path)}.`)); return; }
          unpacked.push({ path, kind: 'file', mode: entry.mode ?? 0, data: Buffer.concat(chunks) });
        });
        entry.resume();
      } catch (error) { parser.abort(error as Error); }
    });
    input.pipe(parser);
  });
  await materializePluginArchive(unpacked, destination);
}
