import { runResourceManagedCommand } from './managedProcessCommand.js';
import { commandInvocation, createPlatformContext, gitBashExecutable } from '@cardbush/platform';
import type { PluginHook } from './pluginExtensions.js';

/** Shared bounded process execution; event parsing remains in the Hook/Command caller. */
export async function executePluginProcess(hook: Pick<PluginHook, 'command' | 'args' | 'shell' | 'timeout'>, input: string, cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, maxOutputBytes = 256 * 1024) {
  signal?.throwIfAborted();
  const expand = (value: string) => value.replace(/\$\{(PLUGIN_ROOT|PLUGIN_DATA|CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT|CARDBUSH_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_DATA)\}/g, (_, key) => env[key] ?? '');
  let command: string, args: string[];
  if (hook.args) { command = expand(hook.command); args = hook.args.map(expand); }
  else if (hook.shell === 'powershell') {
    const invocation = commandInvocation('powershell', hook.command.replace(/\$\{(PLUGIN_ROOT|PLUGIN_DATA|CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT|CARDBUSH_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_DATA)\}/g, '$env:$1'), createPlatformContext({ env }));
    command = invocation.executable; args = invocation.args;
  } else if (hook.shell === 'cmd') { const invocation = commandInvocation('cmd', hook.command.replace(/\$\{(PLUGIN_ROOT|PLUGIN_DATA|CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT|CARDBUSH_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_DATA)\}/g, '%$1%'), createPlatformContext({ env })); command = invocation.executable; args = invocation.args; }
  else { command = await bashExecutable(); args = ['-c', hook.command]; }
  const result = await runResourceManagedCommand({ executable: command, args, cwd, env, input, signal,
    timeoutMs: hook.timeout * 1000, maxOutputBytes });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1 };
}
export async function bashExecutable() {
  const executable = gitBashExecutable();
  if (!executable) throw new Error('This hook requires Bash. Install Bash or select an available shell.');
  return executable;
}
