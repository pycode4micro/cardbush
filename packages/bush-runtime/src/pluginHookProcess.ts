import { runResourceManagedCommand } from './managedProcessCommand.js';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PluginHook } from './pluginExtensions.js';

/** Shared bounded process execution; event parsing remains in the Hook/Command caller. */
export async function executePluginProcess(hook: Pick<PluginHook, 'command' | 'args' | 'shell' | 'timeout'>, input: string, cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, maxOutputBytes = 256 * 1024) {
  signal?.throwIfAborted();
  const expand = (value: string) => value.replace(/\$\{(PLUGIN_ROOT|PLUGIN_DATA|CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT|CARDBUSH_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_DATA)\}/g, (_, key) => env[key] ?? '');
  let command: string, args: string[];
  if (hook.args) { command = expand(hook.command); args = hook.args.map(expand); }
  else if (hook.shell === 'powershell') {
    command = 'powershell.exe'; args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', hook.command.replace(/\$\{(PLUGIN_ROOT|PLUGIN_DATA|CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT|CARDBUSH_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_DATA)\}/g, '$env:$1')];
  } else if (hook.shell === 'cmd') { command = 'cmd.exe'; args = ['/d', '/s', '/c', hook.command.replace(/\$\{(PLUGIN_ROOT|PLUGIN_DATA|CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT|CARDBUSH_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_DATA)\}/g, '%$1%')]; }
  else { command = await bashExecutable(); args = ['-c', hook.command]; }
  const result = await runResourceManagedCommand({ executable: command, args, cwd, env, input, signal,
    timeoutMs: hook.timeout * 1000, maxOutputBytes });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1 };
}
export async function bashExecutable() {
  if (process.platform !== 'win32') return '/bin/bash';
  // Git may be installed outside Program Files; derive Bash from the active Git installation.
  for (const raw of (process.env.PATH ?? '').split(';')) {
    const directory = raw.replace(/^"|"$/g, '');
    if (!directory || !await access(join(directory, 'git.exe')).then(() => true, () => false)) continue;
    for (const candidate of [join(directory, 'bash.exe'), resolve(directory, '..', 'bin', 'bash.exe'), resolve(directory, '..', '..', 'usr', 'bin', 'bash.exe')]) {
      if (await access(candidate).then(() => true, () => false)) return candidate;
    }
  }
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]) {
    if (!base) continue;
    const candidate = join(base, 'Git', 'bin', 'bash.exe');
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  throw new Error('This hook requires Git Bash. Install Git for Windows or use a PowerShell/exec-form hook.');
}
