import { readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export type WorkspaceDirectoryEntry = { name: string; path: string; kind: 'file' | 'folder' };
export type WorkspaceDirectoryPage = { entries: WorkspaceDirectoryEntry[]; nextOffset?: number };

function within(root: string, target: string) {
  const delta = relative(root, target);
  return !delta || (delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta));
}

/** One directory per request; no recursive project scan or synchronous main-thread I/O. */
export async function readWorkspaceDirectory(input: {
  rootPath: string; directoryPath?: string; offset?: number;
}): Promise<WorkspaceDirectoryPage> {
  if (!isAbsolute(input.rootPath)) throw new Error('An absolute workspace root is required.');
  const root = resolve(input.rootPath), directory = resolve(input.directoryPath || root);
  if (!within(root, directory)) throw new Error('Directory is outside the workspace.');
  const [actualRoot, actualDirectory] = await Promise.all([realpath(root), realpath(directory)]);
  if (!within(actualRoot, actualDirectory)) throw new Error('Directory link points outside the workspace.');
  const entries = (await readdir(actualDirectory, { withFileTypes: true }))
    .filter(entry => entry.name !== '.git' && (entry.isDirectory() || entry.isFile() || entry.isSymbolicLink()))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, undefined, { numeric: true }) || a.name.localeCompare(b.name));
  const offset = Math.max(0, Math.floor(Number.isFinite(input.offset) ? input.offset! : 0));
  const end = offset + 200;
  return {
    // Links stay leaf nodes: expanding a directory link could create a cycle.
    entries: entries.slice(offset, end).map(entry => ({ name: entry.name, path: join(directory, entry.name), kind: entry.isDirectory() ? 'folder' : 'file' })),
    ...(end < entries.length ? { nextOffset: end } : {}),
  };
}
