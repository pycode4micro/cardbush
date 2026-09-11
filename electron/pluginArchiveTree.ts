import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { safePackagePath, withinPackage } from './pluginPackagePaths';

export const pluginArchiveLimits = { compressedBytes: 32 * 1024 * 1024, expandedBytes: 64 * 1024 * 1024,
  fileBytes: 16 * 1024 * 1024, files: 2000, entries: 10000, linkBytes: 4096, linkDepth: 64 } as const;

export type PluginArchiveEntry = { path: string } & (
  | { kind: 'directory' }
  | { kind: 'file'; data: Buffer; mode: number }
  | { kind: 'symlink' | 'hardlink'; linkpath: string }
);
type Directory = { kind: 'directory'; path: string; parent?: Directory; children: Map<string, ArchiveNode> };
type File = Extract<PluginArchiveEntry, { kind: 'file' }> & { parent: Directory };
type Link = Extract<PluginArchiveEntry, { kind: 'symlink' | 'hardlink' }> & { parent: Directory };
type ArchiveNode = Directory | File | Link;
const isLink = (node: ArchiveNode): node is Link => node.kind === 'symlink' || node.kind === 'hardlink';

const quote = (value: string) => JSON.stringify(value.length > 240 ? value.slice(0, 240) + '…' : value);
export function archivePath(value: string) {
  try { return safePackagePath(value); }
  catch { throw new Error(`Unsafe plugin archive path ${quote(value)}.`); }
}
export function archiveLinkError(path: string, target: string, reason: string): Error {
  return new Error(`Plugin link ${quote(path)} → ${quote(target)}: ${reason}.`);
}

/** Resolve only archive entries, never filesystem links. Windows receives ordinary files/directories. */
export async function materializePluginArchive(entries: PluginArchiveEntry[], destination: string) {
  const root: Directory = { kind: 'directory', path: '', children: new Map() };
  const conflict = (path: string) => new Error(`Plugin archive contains conflicting paths at ${quote(path)}.`);
  let files = 0, bytes = 0, nodes = 0;
  if (entries.length > pluginArchiveLimits.entries) throw new Error('Plugin archive exceeds the entry limit.');
  for (const entry of entries) {
    const path = archivePath(entry.path), parts = path.split('/');
    if (entry.kind !== 'directory' && ++files > pluginArchiveLimits.files) throw new Error('Plugin archive exceeds the 2000 file limit.');
    if (entry.kind === 'file') {
      bytes += entry.data.length;
      if (entry.data.length > pluginArchiveLimits.fileBytes || bytes > pluginArchiveLimits.expandedBytes) throw new Error('Expanded plugin exceeds the size limit.');
    }
    let parent = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts.slice(0, i + 1).join('/'), key = parts[i].toLowerCase();
      const kind = i < parts.length - 1 ? 'directory' : entry.kind;
      let node = parent.children.get(key);
      if (node && (node.path !== name || node.kind !== 'directory' || kind !== 'directory')) throw conflict(path);
      if (!node) {
        if (++nodes > pluginArchiveLimits.entries) throw new Error('Plugin archive exceeds the entry limit.');
        node = kind === 'directory'
          ? { kind: 'directory', path: name, parent, children: new Map() }
          : { ...entry, path: name, parent } as File | Link;
        parent.children.set(key, node);
      }
      if (node.kind === 'directory') parent = node;
    }
  }
  if (!files) throw new Error('Plugin folder is missing or contains no files.');

  const resolved = new Map<Link, File | Directory>();
  const resolveLink = (link: Link, pending = new Set<Link>()): File | Directory => {
    const fail: (reason: string) => never = reason => { throw archiveLinkError(link.path, link.linkpath, reason); };
    if (pending.has(link)) fail('cyclic link');
    if (pending.size >= pluginArchiveLimits.linkDepth) fail('exceeds the 64-link resolution limit');
    const cached = resolved.get(link);
    if (cached) return cached;
    const target = link.linkpath;
    if (!target || Buffer.byteLength(target) > pluginArchiveLimits.linkBytes) fail('empty or oversized link target');
    if (target.startsWith('/') || /^[A-Za-z]:/.test(target)) fail('target is outside the plugin package; use a relative path');
    if (/[\\\x00-\x1f]/.test(target)) fail('invalid link target');
    pending.add(link);
    let node: File | Directory = link.kind === 'hardlink' ? root : link.parent;
    // Walk components in order: alias/../file must use the alias target's parent.
    for (const part of target.split('/')) {
      if (node.kind !== 'directory') fail('target traverses a file instead of a directory');
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!node.parent) fail('target is outside the plugin package');
        node = node.parent;
        continue;
      }
      try { safePackagePath(part); } catch { fail('invalid link target path'); }
      const child: ArchiveNode | undefined = node.children.get(part.toLowerCase());
      if (!child || child.path.split('/').at(-1) !== part) fail('target does not exist in the plugin package (paths are case-sensitive)');
      node = isLink(child) ? resolveLink(child, pending) : child;
    }
    pending.delete(link);
    if (link.kind === 'hardlink' && node.kind !== 'file') fail('hard links must target a regular file');
    resolved.set(link, node);
    return node;
  };

  // Plan the full expanded tree before touching disk. Aliased content counts again
  // toward output limits; directory aliases can cycle even if individual links resolve.
  const plan: { path: string; node: File | Directory }[] = [];
  const ancestors = new Set<Directory>();
  const stack: ({ kind: 'visit'; node: ArchiveNode; path: string } | { kind: 'leave'; node: Directory })[] = [{ kind: 'visit', node: root, path: '' }];
  files = 0; bytes = 0;
  while (stack.length) {
    const step = stack.pop()!;
    if (step.kind === 'leave') { ancestors.delete(step.node); continue; }
    const source = step.node;
    const node = isLink(source) ? resolveLink(source) : source;
    if (step.path) {
      plan.push({ path: step.path, node });
      if (plan.length > pluginArchiveLimits.entries) throw new Error(`Expanded plugin exceeds the entry limit at ${quote(step.path)}.`);
    }
    if (node.kind === 'file') {
      bytes += node.data.length;
      if (++files > pluginArchiveLimits.files) throw new Error(`Expanded plugin exceeds the 2000 file limit at ${quote(step.path)}.`);
      if (bytes > pluginArchiveLimits.expandedBytes) throw new Error(`Expanded plugin exceeds the size limit at ${quote(step.path)}.`);
    } else {
      if (ancestors.has(node)) throw archiveLinkError(source.path, source.kind === 'symlink' ? source.linkpath : node.path, 'directory link creates a cycle');
      ancestors.add(node);
      stack.push({ kind: 'leave', node });
      for (const child of [...node.children.values()].reverse()) {
        const name = child.path.split('/').at(-1)!;
        stack.push({ kind: 'visit', node: child, path: step.path ? `${step.path}/${name}` : name });
      }
    }
  }

  // Callers own a fresh staging directory; never merge into a preexisting tree.
  await mkdir(destination, { recursive: true });
  const info = await lstat(destination);
  if (info.isSymbolicLink() || !info.isDirectory() || (await readdir(destination)).length) throw new Error('Plugin extraction requires an empty staging directory.');
  for (const { path, node } of plan) {
    const target = withinPackage(destination, path);
    if (node.kind === 'directory') await mkdir(target);
    else await writeFile(target, node.data, { flag: 'wx', mode: node.mode & 0o111 ? 0o755 : 0o644 });
  }
}
