import { lstat, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { OpenDialogOptions } from 'electron';
import { readHandleBytes } from './fileRead';
import { extractLocalPluginArchive, pluginArchiveLimits } from './pluginArchives';
import { findPluginPackageRoot } from './pluginManifest';
import { installProductPlugin } from './productPlugins';

export function localPluginInstallDialog(kind: unknown = 'directory'): OpenDialogOptions {
  if (kind === 'directory') return { title: 'Install plugin from folder', properties: ['openDirectory'] };
  if (kind === 'zip') return { title: 'Install plugin from ZIP', properties: ['openFile'], filters: [{ name: 'Plugin ZIP', extensions: ['zip'] }] };
  throw new Error('Unsupported local plugin source.');
}

export async function installLocalProductPlugin(sourcePath: string, userPluginRoot: string) {
  const source = resolve(sourcePath);
  if ((await lstat(source)).isDirectory()) return installProductPlugin(await findPluginPackageRoot(source), userPluginRoot);
  if (extname(source).toLowerCase() !== '.zip') throw new Error('请选择插件文件夹或 ZIP 文件。');
  const handle = await open(source, 'r');
  let archive: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Plugin archive must be a regular file.');
    if (info.size > pluginArchiveLimits.compressedBytes) throw new Error('Plugin archive exceeds the size limit.');
    archive = await readHandleBytes(handle, info.size + 1);
    if (archive.length !== info.size) throw new Error('Plugin archive changed while being read. Try again.');
  } finally { await handle.close(); }
  const parent = dirname(resolve(userPluginRoot));
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(join(parent, '.cardbush-plugin-import-'));
  try {
    await extractLocalPluginArchive(archive, stage);
    return await installProductPlugin(await findPluginPackageRoot(stage), userPluginRoot);
  } finally {
    const child = relative(parent, resolve(stage));
    if (isAbsolute(child) || child.startsWith('..') || !child.startsWith('.cardbush-plugin-import-')) throw new Error('Invalid plugin import staging path.');
    await rm(stage, { recursive: true, force: true }).catch(error => {
      console.warn('Plugin import cleanup deferred:', stage, error instanceof Error ? error.message : String(error));
    });
  }
}
