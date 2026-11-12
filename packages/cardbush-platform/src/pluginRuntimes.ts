import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import type { PluginRuntime } from './contracts.js';
export const runtimeVersionPattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
export const pluginRuntimeRoot = () => join(homedir(), '.cardbush', 'runtimes', process.platform + '-' + process.arch);

export function pluginRuntimeExecutable(kind: PluginRuntime, version: string, root = pluginRuntimeRoot()) {
  if (!runtimeVersionPattern.test(version)) throw Error('Invalid runtime version.');
  const directory = join(root, kind, version);
  return process.platform === 'win32' ? join(directory, kind + '.exe') : join(directory, 'bin', kind === 'python' ? 'python3' : 'node');
}

export function activePluginRuntime(kind: PluginRuntime, root = pluginRuntimeRoot()) {
  try {
    const version = readFileSync(join(root, kind, 'active'), 'utf8').trim();
    if (!runtimeVersionPattern.test(version)) return;
    const executable = pluginRuntimeExecutable(kind, version, root);
    if (statSync(executable).isFile()) return {version, executable};
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

/** Resolve for each new child. Explicit executable paths and the host's own Node remain independent. */
export function pluginRuntimeCommand(command: string, args: string[]) {
  const alias = process.platform === 'win32' ? command.toLowerCase().replace(/\.(exe|cmd)$/, '') : command;
  if (alias === 'python' || alias === 'python3') {
    return {command: activePluginRuntime('python')?.executable ?? command, args};
  }
  if (alias === 'node' || alias === 'npm' || alias === 'npx') {
    const runtime = activePluginRuntime('node');
    if (runtime) {
      if (alias === 'node') return {command: runtime.executable, args};
      const bin = dirname(runtime.executable);
      const modules = process.platform === 'win32' ? bin : join(bin, '..', 'lib');
      const cli = join(modules, 'node_modules', 'npm', 'bin', alias + '-cli.js');
      if (existsSync(cli)) return {command: runtime.executable, args: [cli, ...args]};
    }
  }
  return {command, args};
}

/** Extend only the child environment already admitted by its caller. */
export function pluginRuntimeEnvironment<T extends NodeJS.ProcessEnv>(env: T): T {
  const bins = (['node', 'python'] as const).flatMap(kind => {
    const runtime = activePluginRuntime(kind);
    if (!runtime) return [];
    const bin = dirname(runtime.executable);
    return kind === 'python' && process.platform === 'win32' ? [bin, join(bin, 'Scripts')] : [bin];
  });
  if (!bins.length) return env;
  const key = process.platform === 'win32' ? Object.keys(env).find(name => name.toLowerCase() === 'path') ?? 'PATH' : 'PATH';
  return {...env, [key]: [...bins, ...(env[key] ? [env[key]] : [])].join(delimiter)};
}
