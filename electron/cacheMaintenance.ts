import { lstat, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export type CleanupResult = { counts: Record<string, number>; errors: string[] };
export const emptyCleanup = (): CleanupResult => ({ counts: { files: 0, bytes: 0 }, errors: [] });
export function mergeCleanup(...results: CleanupResult[]): CleanupResult {
  const merged = emptyCleanup();
  for (const result of results) {
    for (const [key, value] of Object.entries(result.counts)) merged.counts[key] = (merged.counts[key] ?? 0) + value;
    merged.errors.push(...result.errors);
  }
  return merged;
}

async function ownedDirectory(root: string) {
  const stat = await lstat(root).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing linked cache directory: ${root}`);
  return true;
}

/** Recurses only inside an explicit owned root; links and persistent metadata are untouched. */
export async function clearDiagnosticFiles(root: string, accept: (name: string, modified: number) => boolean = () => true): Promise<CleanupResult> {
  const result = emptyCleanup();
  const visit = async (directory: string) => {
    if (!await ownedDirectory(directory)) return;
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.isSymbolicLink()) continue;
      const file = join(directory, item.name);
      if (item.isDirectory()) { await visit(file); continue; }
      if (!item.isFile()) continue;
      try {
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || !accept(item.name, stat.mtimeMs)) continue;
        await unlink(file); result.counts.files!++; result.counts.bytes! += stat.size;
      } catch (error) { result.errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  };
  await visit(resolve(root));
  return result;
}

const activeTemporaryDirectories = new Set<string>();
const ownerFile = '.cardbush-cache-owner.json';
export async function leaseTemporaryDirectory(directory: string) {
  directory = resolve(directory);
  activeTemporaryDirectories.add(directory);
  try { await writeFile(join(directory, ownerFile), JSON.stringify({ pid: process.pid, createdAt: Date.now() })); }
  catch (error) { activeTemporaryDirectories.delete(directory); throw error; }
  return () => { activeTemporaryDirectories.delete(directory); };
}

/** Reclaims restart leftovers, never a running process's staging data or a rollback backup. */
export async function collectTemporaryDirectories(root: string, prefix: string, ageMs: number, protectedPaths = new Set<string>()): Promise<CleanupResult> {
  root = resolve(root);
  const result = emptyCleanup();
  if (!await ownedDirectory(root)) return result;
  const before = Date.now() - ageMs;
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (!item.isDirectory() || item.isSymbolicLink() || !item.name.startsWith(prefix)) continue;
    const directory = resolve(root, item.name);
    if (dirname(directory) !== root || basename(directory) !== item.name || activeTemporaryDirectories.has(directory) || protectedPaths.has(directory)) continue;
    try {
      if ((await lstat(directory)).mtimeMs > before) continue;
      // The previous installation may be the user's only recoverable copy.
      if (await lstat(join(directory, 'previous')).catch(error => { if (error.code !== 'ENOENT') throw error; })) continue;
      let owner: { pid?: number } | undefined;
      try { owner = JSON.parse(await readFile(join(directory, ownerFile), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (owner?.pid && owner.pid !== process.pid) {
        try { process.kill(owner.pid, 0); continue; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
      }
      const counts = await directorySize(directory);
      // Validate the literal target again immediately before recursive deletion.
      if ((await lstat(directory)).isSymbolicLink() || dirname(directory) !== root) continue;
      await rm(directory, { recursive: true, force: true, maxRetries: 2 });
      result.counts.files! += counts.files; result.counts.bytes! += counts.bytes;
      result.counts.directories = (result.counts.directories ?? 0) + 1;
    } catch (error) { result.errors.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return result;
}

async function directorySize(root: string): Promise<{ files: number; bytes: number }> {
  if (!await ownedDirectory(root)) return { files: 0, bytes: 0 };
  let files = 0, bytes = 0;
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw new Error('A temporary directory contains a link; kept for inspection.');
    const path = join(root, item.name), stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('Temporary directory changed during cleanup.');
    if (stat.isDirectory()) { const child = await directorySize(path); files += child.files; bytes += child.bytes; }
    else if (stat.isFile()) { files++; bytes += stat.size; }
  }
  return { files, bytes };
}

export async function removeTemporaryDirectory(root: string, directory: string, prefix: string): Promise<CleanupResult> {
  root = resolve(root); directory = resolve(directory);
  if (!await ownedDirectory(root) || dirname(directory) !== root || !basename(directory).startsWith(prefix)) throw new Error('Invalid temporary cleanup path.');
  if (!await ownedDirectory(directory)) return emptyCleanup();
  if (await lstat(join(directory, 'previous')).catch(error => { if (error.code !== 'ENOENT') throw error; })) throw new Error('A rollback backup must be kept.');
  const counts = await directorySize(directory);
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Temporary directory changed during cleanup.');
  await rm(directory, { recursive: true, force: true, maxRetries: 2 });
  return { counts: { ...counts, directories: 1 }, errors: [] };
}

type BrowserCacheSession = Pick<Electron.Session, 'clearCache' | 'clearCodeCaches' | 'clearStorageData' | 'getCacheSize'>;
export async function clearBrowserCaches(sessions: Iterable<BrowserCacheSession>): Promise<CleanupResult> {
  const result = emptyCleanup();
  for (const session of new Set(sessions)) {
    const before = await session.getCacheSize().catch(() => 0);
    for (const clear of [() => session.clearCache(), () => session.clearCodeCaches({}), () => session.clearStorageData({ storages: ['shadercache'] })]) {
      try { await clear(); } catch (error) { result.errors.push(error instanceof Error ? error.message : String(error)); }
    }
    result.counts.http_cache_bytes = (result.counts.http_cache_bytes ?? 0) + Math.max(0, before - await session.getCacheSize().catch(() => 0));
    result.counts.browser_sessions = (result.counts.browser_sessions ?? 0) + 1;
  }
  return result;
}
