import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PluginHook } from './pluginExtensions.js';

/** Shared bounded process execution; event parsing remains in the Hook/Command caller. */
export async function executePluginProcess(hook: Pick<PluginHook, 'command' | 'args' | 'shell' | 'timeout'>, input: string, cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, maxOutputBytes = 256 * 1024) {
  const expand = (value: string) => value.replace(/\$\{(PLUGIN_ROOT|PLUGIN_DATA|CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT|CARDBUSH_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_DATA)\}/g, (_, key) => env[key] ?? '');
  let command: string, args: string[];
  if (hook.args) { command = expand(hook.command); args = hook.args.map(expand); }
  else if (hook.shell === 'powershell') {
    command = 'powershell.exe'; args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', hook.command.replace(/\$\{(PLUGIN_ROOT|PLUGIN_DATA|CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT|CARDBUSH_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_DATA)\}/g, '$env:$1')];
  } else if (hook.shell === 'cmd') { command = 'cmd.exe'; args = ['/d', '/s', '/c', hook.command.replace(/\$\{(PLUGIN_ROOT|PLUGIN_DATA|CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT|CARDBUSH_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_DATA)\}/g, '%$1%')]; }
  else { command = await bashExecutable(); args = ['-c', hook.command]; }
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((fulfill, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0, ended = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const fail = (error: Error) => { if (ended) return; ended = true; cleanup(); void killTree(child.pid).finally(() => reject(error)); };
    const abort = () => fail(new DOMException('Plugin hook cancelled.', 'AbortError'));
    const timer = setTimeout(() => fail(new Error(`Plugin hook timed out after ${hook.timeout}s.`)), hook.timeout * 1000);
    signal?.addEventListener('abort', abort, { once: true });
    for (const [stream, channel] of [[child.stdout, 'out'], [child.stderr, 'err']] as const) stream.on('data', chunk => {
      size += chunk.length;
      if (ended) return;
      if (size > maxOutputBytes) { fail(new Error(`Plugin process output exceeded ${maxOutputBytes} bytes.`)); return; }
      (channel === 'out' ? stdout : stderr).push(chunk);
    });
    child.on('error', fail);
    child.on('close', code => { if (ended) return; ended = true; cleanup(); fulfill({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: code ?? 1 }); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
    if (signal?.aborted) abort();
  });
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
async function killTree(pid?: number) {
  if (!pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>(fulfill => {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(fulfill, 2000);
      const done = () => { clearTimeout(timer); fulfill(); };
      killer.on('error', done); killer.on('close', done);
    });
  } else { try { process.kill(-pid, 'SIGKILL'); } catch { /* Already exited. */ } }
}
