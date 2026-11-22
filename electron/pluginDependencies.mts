import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { activePluginRuntime, pluginRuntimeCommand, pluginRuntimeEnvironment, pluginRuntimeExecutable, runtimeVersionPattern } from '@cardbush/platform';
import { runResourceManagedCommand } from '@cardbush/bush-runtime/processes';
import { existsSync, readFileSync } from 'node:fs';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

export const pluginDependencyDirectory = '.cardbush-dependencies';
const receiptName = 'runtime.json';
type Runtime = 'python' | 'node';

function runtimeAlias(command: unknown): Runtime | undefined {
  if (typeof command !== 'string') return;
  const name = process.platform === 'win32' ? command.toLowerCase().replace(/\.exe$/, '') : command;
  if (name === 'python' || name === 'python3') return 'python';
  if (name === 'node') return 'node';
}

async function regularFile(path: string) {
  return (await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; }))?.isFile() === true;
}

/** Prepare dependencies in the staged package, before its atomic publication. */
export async function preparePluginDependencies(root: string, servers: Record<string, unknown>, signal?: AbortSignal,
  runtime = activePluginRuntime, run = runResourceManagedCommand) {
  const aliases = Object.values(servers).map(server => {
    const entry = server as { type?: unknown; transport?: unknown; url?: unknown; command?: unknown };
    if ((entry.type ?? entry.transport ?? (entry.url ? 'http' : 'stdio')) === 'stdio') return runtimeAlias(entry.command);
  });
  const kinds: Runtime[] = [];
  if (aliases.includes('python') && await regularFile(join(root, 'pyproject.toml'))) kinds.push('python');
  if (aliases.includes('node') && await regularFile(join(root, 'package.json')) && await regularFile(join(root, 'package-lock.json'))) kinds.push('node');
  if (!kinds.length) return;
  const directory = join(root, pluginDependencyDirectory);
  await mkdir(directory);
  const versions: Partial<Record<Runtime, string>> = {};
  for (const kind of kinds) {
    signal?.throwIfAborted();
    const selected = runtime(kind);
    if (!selected) throw Error(`Select a CardBush-managed ${kind} runtime before installing this plugin's dependencies.`);
    const env = pluginRuntimeEnvironment(getDefaultEnvironment());
    let invocation: { command: string; args: string[] };
    if (kind === 'python') {
      // Use this interpreter's standard user-site layout so startup processes
      // wheel .pth files (including DLL/bootstrap hooks) after atomic publication.
      const userBase = join(directory, 'python');
      const layout = await run({ executable: selected.executable, args: ['-I', '-S', '-c', 'import site; print(site.getusersitepackages())'],
        env: { ...env, PYTHONUSERBASE: userBase }, cwd: root, signal, timeoutMs: 15_000, maxOutputBytes: 4096 });
      const site = layout.stdout.trim();
      const subdirectory = relative(userBase, site);
      if (layout.exitCode !== 0 || !isAbsolute(site) || !subdirectory || isAbsolute(subdirectory) || subdirectory.startsWith('..')) {
        throw Error(`CardBush Python ${selected.version} could not determine the plugin's private site-packages directory.`);
      }
      invocation = { command: selected.executable, args: ['-I', '-m', 'pip', '--isolated', 'install', '--no-input', '--disable-pip-version-check', '--target', site, '.'] };
    } else {
      invocation = pluginRuntimeCommand('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], selected);
      if (invocation.command !== selected.executable) throw Error('The selected CardBush Node runtime has no npm CLI.');
    }
    const result = await run({ executable: invocation.command, args: invocation.args, env, cwd: root, signal,
      timeoutMs: 300_000, maxOutputBytes: 64 * 1024, outputLimit: 'truncate' });
    if (result.exitCode !== 0) throw Error(`Installing plugin dependencies with CardBush ${kind} ${selected.version} failed (${result.exitCode}): ${result.stderr.slice(-1800)}`);
    versions[kind] = selected.version;
  }
  await writeFile(join(directory, receiptName), JSON.stringify(versions), { flag: 'wx' });
}

export function installedPluginDependencyRuntime(root: string, command: string, runtimeRoot?: string) {
  const kind = runtimeAlias(command);
  if (!kind) return;
  const directory = join(root, pluginDependencyDirectory), receipt = join(directory, receiptName);
  if (!existsSync(receipt)) return;
  const version: unknown = JSON.parse(readFileSync(receipt, 'utf8'))[kind];
  if (version === undefined) return;
  if (typeof version !== 'string' || !runtimeVersionPattern.test(version)) throw Error('Invalid plugin dependency runtime receipt. Reinstall this package.');
  const executable = pluginRuntimeExecutable(kind, version, runtimeRoot);
  if (!existsSync(executable)) throw Object.assign(new Error(`This plugin requires CardBush ${kind} ${version}. Restore that runtime or reinstall the package.`),
    { code: 'plugin_dependency_runtime_unavailable' });
  return { executable, env: kind === 'python' ? { PYTHONUSERBASE: join(directory, 'python'), PYTHONPATH: '', PYTHONNOUSERSITE: '' } : {} };
}
