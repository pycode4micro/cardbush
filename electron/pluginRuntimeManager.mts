import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { activePluginRuntime, pluginRuntimeExecutable, pluginRuntimeRoot, runtimeVersionPattern, type PluginRuntime, type PluginRuntimeAction, type PluginRuntimeStatus } from '@cardbush/platform';
import { withFileLock } from './fileLock.mjs';
import { resolveRuntimeBuild, type RuntimeBuild } from './pluginRuntimeCatalog.mjs';

const run = promisify(execFile);
const kinds = ['node', 'python'] as const;
async function installed(kind: PluginRuntime, version: string, root: string) {
  return stat(pluginRuntimeExecutable(kind, version, root)).then(file => file.isFile(), (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}
async function status(kind: PluginRuntime, root: string): Promise<PluginRuntimeStatus> {
  const entries = await readdir(join(root, kind), {withFileTypes:true}).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const versions = [];
  for (const entry of entries) {
    if (entry.isDirectory() && runtimeVersionPattern.test(entry.name) && await installed(kind, entry.name, root)) versions.push(entry.name);
  }
  return {kind, active: activePluginRuntime(kind, root)?.version, versions: versions.sort((a,b) => b.localeCompare(a, 'en', {numeric:true}))};
}

async function download(build: RuntimeBuild, path: string, request: typeof fetch) {
  const signal = AbortSignal.timeout(600_000);
  const response = await request(build.url, {signal});
  if (!response.ok || !response.body) throw Error(`Runtime download failed (HTTP ${response.status}).`);
  let bytes = 0;
  const hash = createHash('sha256');
  const verify = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > 256 * 1024 * 1024) return done(Error('Runtime archive exceeds the download limit.'));
      hash.update(chunk); done(null, chunk);
    },
    flush(done) { done(hash.digest('hex') === build.digest ? undefined : Error('Runtime archive checksum mismatch.')); },
  });
  await pipeline(response.body, verify, createWriteStream(path, {flags:'wx', mode:0o600}), {signal});
}

async function installBuild(kind: PluginRuntime, build: RuntimeBuild, root: string, request: typeof fetch) {
  if (await installed(kind, build.version, root)) return;
  const directory = join(root, kind);
  const stage = await mkdtemp(join(directory, '.install-'));
  try {
    const archive = join(stage, 'download');
    await download(build, archive, request);
    // Only upstream archives verified against their release digest reach the platform extractor.
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
    const env = {...process.env};
    delete env.TAR_OPTIONS; delete env.NODE_OPTIONS; delete env.PYTHONHOME; delete env.PYTHONPATH;
    await run(tar, ['--no-same-owner', '-xf', archive], {cwd: stage, env, windowsHide:true, timeout:180_000});
    const staged = join(stage, build.directory);
    const executable = join(staged, process.platform === 'win32' ? '' : 'bin', basename(pluginRuntimeExecutable(kind, build.version, root)));
    const {stdout} = await run(executable, kind === 'python' ? ['-I', '--version'] : ['--version'], {cwd: stage, env, windowsHide:true, timeout:15_000});
    if (stdout.trim() !== (kind === 'python' ? 'Python ' : 'v') + build.version) throw Error('Installed interpreter reported an unexpected version.');
    await rename(staged, join(directory, build.version));
  } finally { await rm(stage, {recursive:true, force:true, maxRetries:3}); }
}

export async function managePluginRuntime(action: PluginRuntimeAction, kind?: PluginRuntime, selector?: string,
  root = pluginRuntimeRoot(), request: typeof fetch = fetch): Promise<PluginRuntimeStatus[]> {
  if (action === 'list' && kind === undefined && selector === undefined) return Promise.all(kinds.map(item => status(item, root)));
  if (!kind || !kinds.includes(kind) || !['install','update','use'].includes(action)) throw Error('Use cardbush runtime --help.');
  if (selector !== undefined && (typeof selector !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){0,2}$/.test(selector))) throw Error('Expected a numeric runtime version.');
  if (action === 'use' && (!selector || !runtimeVersionPattern.test(selector))) throw Error('Select an exact installed version.');
  if (action === 'update' && selector !== undefined) throw Error('Update follows the active series. Use install to change series.');
  const directory = join(root, kind), activeFile = join(directory, 'active');
  await mkdir(directory, {recursive:true, mode:0o700});
  await withFileLock(activeFile, async () => {
    const active = activePluginRuntime(kind, root)?.version;
    if (action === 'update' && !active) throw Error('Install the runtime before updating it.');
    let version = selector;
    if (!version || !runtimeVersionPattern.test(version) || !await installed(kind, version, root)) {
      if (action === 'use') throw Error('This version is not installed.');
      const series = action === 'update' ? active!.split('.').slice(0, kind === 'node' ? 1 : 2).join('.') : kind === 'node' ? '24' : '3.12';
      const build = await resolveRuntimeBuild(kind, selector ?? series, request);
      if (action === 'update' && active!.localeCompare(build.version, 'en', {numeric:true}) > 0) return;
      await installBuild(kind, build, root, request);
      version = build.version;
    }
    if (version === active) return;
    const temporary = join(directory, '.active-' + randomUUID());
    try {
      await writeFile(temporary, version + '\n', {flag:'wx', mode:0o600});
      await rename(temporary, activeFile);
    } finally { await rm(temporary, {force:true}); }
  });
  return Promise.all(kinds.map(item => status(item, root)));
}
