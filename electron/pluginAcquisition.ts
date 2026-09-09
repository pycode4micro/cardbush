import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Parser, extract } from 'tar';
import { safePackagePath, withinPackage } from './pluginPackagePaths';

export interface NpmPluginSource { kind: 'npm'; package: string; version?: string; registry?: string }
export type AcquisitionCommand = (command: string, args: string[], cwd: string) => Promise<string>;

export function gitSource(input: string): { url: string; ref: string } {
  const value = input.trim();
  if (/^[\w-]+\/[\w.-]+(?:@.+)?$/.test(value)) {
    const [repo, ref = 'HEAD'] = value.split('@');
    return { url: `https://github.com/${repo}.git`, ref: gitRef(ref) };
  }
  const scp = value.match(/^([A-Za-z0-9_.-]+@[A-Za-z0-9.-]+):([^\s#]+)(?:#(.+))?$/);
  if (scp) return { url: `${scp[1]}:${scp[2]}`, ref: gitRef(scp[3] ?? 'HEAD') };
  const url = new URL(value);
  if (!['http:', 'https:', 'ssh:'].includes(url.protocol) || url.password || url.search || ((url.protocol !== 'ssh:') && url.username)) throw new Error('Use an HTTP(S) or SSH Git URL without embedded credentials.');
  const ref = gitRef(decodeURIComponent(url.hash.slice(1)) || 'HEAD');
  url.hash = '';
  return { url: url.toString(), ref };
}
export function gitRef(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || /\.\.|\/\/|[/.]$/.test(value)) throw new Error('Invalid Git branch, tag or commit.');
  return value;
}
export function npmSource(source: Record<string, unknown>): NpmPluginSource {
  const name = String(source.package ?? '');
  const version = source.version === undefined ? undefined : String(source.version);
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error('Invalid npm plugin package name.');
  // Restrict the selector to registry versions/tags/ranges; npm validates the exact grammar.
  if (version !== undefined && !/^[A-Za-z0-9*~^<>=][A-Za-z0-9_*~^<>=| .+-]*$/.test(version.trim())) throw new Error('npm plugin versions must be versions, tags or ranges, not paths or URLs.');
  const registry = source.registry === undefined ? undefined : String(source.registry);
  if (registry) {
    const url = new URL(registry);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('npm registry must be an HTTPS URL without credentials, query or fragment.');
  }
  return { kind: 'npm', package: name, version, registry };
}

/** Bare Git acquisition never checks out a project or runs package hooks. */
export async function withGitSnapshot<T>(url: string, ref: string, dataRoot: string,
  read: (repository: string, revision: string, run: AcquisitionCommand) => Promise<T>, run: AcquisitionCommand = runAcquisitionCommand): Promise<T> {
  gitSource(url); gitRef(ref);
  const base = resolve(dataRoot, 'acquisitions');
  await mkdir(base, { recursive: true });
  const stage = await mkdtemp(join(base, 'git-'));
  const repository = join(stage, 'repo.git');
  try {
    await run('git', ['init', '--bare', '--template=', repository], stage);
    await run('git', ['-C', repository, 'remote', 'add', 'origin', url], stage);
    await run('git', ['-C', repository, '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never',
      'fetch', '--depth=1', '--filter=blob:none', '--no-tags', 'origin', ref], stage);
    const revision = (await run('git', ['-C', repository, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}'], stage)).trim();
    if (!/^[a-f0-9]{40,64}$/i.test(revision)) throw new Error('Git did not return a valid commit.');
    if (/^[a-f0-9]{40,64}$/i.test(ref) && revision.toLowerCase() !== ref.toLowerCase()) throw new Error('Git snapshot does not match its pinned commit.');
    return await read(repository, revision, run);
  } finally {
    if (dirname(stage) !== base) throw new Error('Invalid Git acquisition cleanup path.');
    await rm(stage, { recursive: true, force: true, maxRetries: 2 });
  }
}
export async function gitCatalogFile(repository: string, revision: string, path: string, run: AcquisitionCommand) {
  try {
    await run('git', ['-C', repository, 'cat-file', '-e', `${revision}:${safePackagePath(path)}`], dirname(repository));
  } catch (error) {
    if ((error as { exitCode?: number }).exitCode === 128) throw Object.assign(new Error('Marketplace file not found.'), { code: 'ENOENT' });
    throw error;
  }
  return run('git', ['-C', repository, 'show', `${revision}:${path}`], dirname(repository));
}
export async function gitPluginArchive(repository: string, revision: string, path: string, run: AcquisitionCommand) {
  const file = join(dirname(repository), 'plugin.zip');
  await run('git', ['-C', repository, 'archive', '--format=zip', '--prefix=plugin/', '-o', file, revision, '--', ...(path ? [`:(literal)${safePackagePath(path)}`] : [])], dirname(repository));
  if ((await stat(file)).size > 32 * 1024 * 1024) throw new Error('Plugin archive exceeds the size limit.');
  return readFile(file);
}

export async function acquireNpmPlugin(source: NpmPluginSource, stage: string, destination: string, run: AcquisitionCommand = runAcquisitionCommand) {
  const pack = join(stage, 'npm');
  await mkdir(pack);
  const [command, prefix] = await npmCommand();
  const args = [...prefix, 'pack', `${source.package}${source.version ? `@${source.version}` : ''}`, '--ignore-scripts', '--json', '--pack-destination', pack,
    ...(source.registry ? ['--registry', source.registry] : [])];
  const output = JSON.parse(await run(command, args, stage));
  if (!Array.isArray(output) || output.length !== 1 || typeof output[0].filename !== 'string') throw new Error('npm returned an invalid plugin archive.');
  const metadata = output[0];
  const file = withinPackage(pack, metadata.filename);
  if ((await stat(file)).size > 32 * 1024 * 1024) throw new Error('Plugin archive exceeds the size limit.');
  const seen = new Set<string>(); let size = 0;
  await new Promise<void>((fulfill, reject) => {
    const input = createReadStream(file);
    const parser = new Parser({ strict: true, maxDecompressionRatio: 2000 });
    parser.once('error', error => { input.destroy(); reject(error); });
    parser.once('end', fulfill);
    input.once('error', error => parser.abort(error));
    parser.on('entry', entry => {
      try {
        if (!['File', 'Directory', 'OldFile'].includes(entry.type)) throw new Error('Plugin archives cannot contain links or special files.');
        if (entry.path !== 'package/' || entry.type !== 'Directory') {
          if (!entry.path.startsWith('package/')) throw new Error('Invalid npm archive root.');
          const path = safePackagePath(entry.path.slice('package/'.length)).toLowerCase();
          if (seen.has(path)) throw new Error('Plugin archive contains conflicting paths.');
          seen.add(path); size += entry.size;
          if (seen.size > 2000 || entry.size > 16 * 1024 * 1024 || size > 64 * 1024 * 1024) throw new Error('Expanded plugin exceeds the size limit.');
        }
        entry.resume();
      } catch (error) { parser.abort(error as Error); }
    });
    input.pipe(parser);
  });
  await mkdir(destination);
  await extract({ file, cwd: destination, strip: 1, strict: true, noChmod: true, noMtime: true });
  return { revision: `npm:${metadata.version}:${metadata.shasum ?? metadata.integrity ?? ''}`, source: `${source.registry ?? 'https://registry.npmjs.org'}/${source.package}` };
}

async function npmCommand(): Promise<[string, string[]]> {
  if (process.platform !== 'win32') return ['npm', []];
  const paths = (process.env.PATH ?? '').split(';');
  for (const directory of paths) {
    const cli = join(directory.replace(/^"|"$/g, ''), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (await access(cli).then(() => true, () => false)) return ['node', [cli]];
  }
  throw new Error('npm is required to download registry plugins. Install Node.js with npm.');
}

export async function runAcquisitionCommand(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((fulfill, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never', SSH_ASKPASS_REQUIRE: 'never', npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' } });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : fulfill(Buffer.concat(stdout).toString('utf8')); };
    const stop = (reason: string) => {
      if (process.platform === 'win32' && child.pid) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined);
      else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      finish(new Error(reason));
    };
    const timer = setTimeout(() => stop('Plugin acquisition timed out.'), 60_000);
    for (const [stream, output] of [[child.stdout, true], [child.stderr, false]] as const) stream.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) { stop('Plugin acquisition output exceeds the size limit.'); return; }
      (output ? stdout : stderr).push(chunk);
    });
    child.on('error', finish);
    child.on('close', code => finish(code !== 0 ? Object.assign(new Error(`${command} failed (${code}): ${Buffer.concat(stderr).toString('utf8').slice(-4000)}`), { exitCode: code }) : undefined));
  });
}
