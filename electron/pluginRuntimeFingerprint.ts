import { createHash } from 'node:crypto';
import { open, readdir, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const normalized = (path: string) => path.replaceAll('\\', '/');

/** Dependency trees and generated state are not live package source. */
export function ignoredCapabilityPath(path: string) {
  return /(^|\/)(node_modules|\.git|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|logs|cache|\.cache|tmp|temp|output|outputs)(\/|$)/i.test(normalized(path));
}

/** Shared by the watcher and fingerprint scan so a source-only edit is noticed. */
export function pluginRuntimeSource(path: string) {
  const name = normalized(path);
  if (ignoredCapabilityPath(name) || /(^|\/)(skills|docs|\.codex-plugin|\.claude-plugin)(\/|$)/i.test(name)) return false;
  return /\.(py|pyi|js|cjs|mjs|ts|cts|mts|tsx|jsx|ps1|sh|cmd|bat|rb|php|lua|exe|dll|so|dylib|node|wasm|jar)$/i.test(name) ||
    /(^|\/)(package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|uv\.lock|poetry\.lock|requirements(?:[.-][^/]*)?\.txt|setup\.cfg)$/i.test(name) ||
    /(^|\/)(src|lib|dist|build|bin)\/.*\.(json|yaml|yml|toml|ini)$/i.test(name);
}

type CachedFile = { stamp: string; hash: string };
const roots = new Map<string, Map<string, CachedFile>>();
const stamp = (info: Stats) => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');

async function fileIdentity(path: string): Promise<{ stamp: string; physical: boolean }> {
  if (process.versions.electron) {
    // Electron invents a new inode for every stat of an ASAR entry. Use the
    // archive on disk (and the sidecar for unpacked entries) as the cache key.
    const disk = (require('original-fs') as typeof import('node:fs')).promises;
    const diskStat = (name: string) => disk.stat(name).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
      throw error;
    });
    for (const match of path.matchAll(/\.asar(?=[\\/])/gi)) {
      const archive = path.slice(0, match.index + 5);
      const container = await diskStat(archive);
      if (!container?.isFile()) continue;
      const unpacked = await diskStat(`${archive}.unpacked${path.slice(archive.length)}`);
      return { stamp: JSON.stringify([stamp(container), unpacked ? stamp(unpacked) : null]), physical: false };
    }
  }
  return { stamp: stamp(await stat(path)), physical: true };
}

async function fileHash(path: string, previous: CachedFile | undefined): Promise<CachedFile> {
  const current = await fileIdentity(path);
  const pathStamp = current.stamp;
  if (previous?.stamp === pathStamp) return previous;
  const file = await open(path, 'r');
  try {
    const before = stamp(await file.stat());
    const hash = createHash('sha256');
    // Bound memory even for native binaries; repeated refreshes reuse unchanged hashes.
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    // ASAR open() returns a temporary extracted file. Validate that handle and
    // its container independently; physical paths must also match the handle.
    if (before !== stamp(await file.stat()) || pathStamp !== (await fileIdentity(path)).stamp ||
      (current.physical && before !== pathStamp)) {
      throw new Error('Plugin source changed while refreshing. Wait for the package update to finish and refresh again.');
    }
    return { stamp: pathStamp, hash: hash.digest('hex') };
  } finally { await file.close(); }
}

/** Host-only identity: no timestamps or file contents enter model instructions.
 * Version changes also cover implementations installed outside the package. */
export async function pluginRuntimeFingerprint(root: string, version: string): Promise<string> {
  const base = resolve(root);
  const previous = roots.get(base);
  const next = new Map<string, CachedFile>();
  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      const name = normalized(relative(base, path));
      if (ignoredCapabilityPath(name) || /(^|\/)(skills|docs|\.codex-plugin|\.claude-plugin)(\/|$)/i.test(name)) continue;
      // Do not scan dependency links or follow junctions outside the plugin package.
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && pluginRuntimeSource(name)) next.set(name, await fileHash(path, previous?.get(name)));
    }
  }
  await visit(base);
  roots.delete(base); roots.set(base, next);
  // This is only a disposable hash cache; removed packages must not accumulate forever.
  while (roots.size > 64) roots.delete(roots.keys().next().value!);
  return digest(JSON.stringify([version, [...next].map(([name, file]) => [name, file.hash])]));
}
