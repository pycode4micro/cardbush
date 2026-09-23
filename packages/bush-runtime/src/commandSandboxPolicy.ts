import { isAbsolute } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ToolAdmissionContext } from './toolRegistry.js';
import { workspaceRoot } from './workspaceAccessPolicy.js';
import { sandboxError, type ExecutionSandboxPolicy } from './executionSandbox.js';

/** Supplied by the host at startup, never by a turn or a model tool call. */
export interface CommandSandboxConfiguration {
  mode: 'off' | 'auto' | 'required';
  network: 'disabled' | 'enabled';
  readableRoots: readonly string[];
  writableRoots: readonly string[];
  linuxExecutable?: string;
}

export function commandSandboxConfiguration(env: NodeJS.ProcessEnv): CommandSandboxConfiguration {
  const mode = env.CARDBUSH_EXECUTION_SANDBOX?.trim() || 'off';
  const network = env.CARDBUSH_SANDBOX_NETWORK?.trim() || 'disabled';
  if (mode !== 'off' && mode !== 'auto' && mode !== 'required') throw sandboxError('sandbox_policy_invalid', 'CARDBUSH_EXECUTION_SANDBOX must be off, auto or required.');
  if (network !== 'disabled' && network !== 'enabled') throw sandboxError('sandbox_policy_invalid', 'CARDBUSH_SANDBOX_NETWORK must be disabled or enabled.');
  const linuxExecutable = env.CARDBUSH_BWRAP_PATH?.trim();
  if (linuxExecutable && (!isAbsolute(linuxExecutable) || linuxExecutable.includes('\0'))) throw sandboxError('sandbox_policy_invalid', 'CARDBUSH_BWRAP_PATH must be an absolute executable path.');
  function directories(key: string): readonly string[] {
    let value: unknown;
    try { value = JSON.parse(env[key] || '[]'); } catch { throw sandboxError('sandbox_policy_invalid', `${key} must be a JSON array of absolute directories.`); }
    if (!Array.isArray(value) || value.length > 64 || value.some(path => typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))) {
      throw sandboxError('sandbox_policy_invalid', `${key} must be a JSON array of absolute directories.`);
    }
    return Object.freeze([...new Set(value as string[])]);
  }
  return Object.freeze({ mode, network, readableRoots: directories('CARDBUSH_SANDBOX_READ_ROOTS'), writableRoots: directories('CARDBUSH_SANDBOX_WRITE_ROOTS'), ...(linuxExecutable ? { linuxExecutable } : {}) });
}

export function snapshotCommandSandbox(configuration?: CommandSandboxConfiguration): CommandSandboxConfiguration {
  return commandSandboxConfiguration(configuration ? {
    CARDBUSH_EXECUTION_SANDBOX: configuration.mode,
    CARDBUSH_SANDBOX_NETWORK: configuration.network,
    CARDBUSH_SANDBOX_READ_ROOTS: JSON.stringify(configuration.readableRoots),
    CARDBUSH_SANDBOX_WRITE_ROOTS: JSON.stringify(configuration.writableRoots),
    CARDBUSH_BWRAP_PATH: configuration.linuxExecutable,
  } : {});
}

/** Settings belong to the host, not model metadata. Invalid saved policy fails closed. */
export async function loadCommandSandboxConfiguration(env: NodeJS.ProcessEnv, settingsPath?: string): Promise<CommandSandboxConfiguration> {
  const base = commandSandboxConfiguration(env);
  if (!settingsPath || base.mode === 'required' || env.CARDBUSH_EXECUTION_SANDBOX?.trim() === 'off') return base;
  let saved: { version?: unknown; enabled?: unknown };
  try { saved = JSON.parse(await readFile(settingsPath, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return base; throw sandboxError('sandbox_policy_invalid', 'Cannot read the saved sandbox setting. Check Runtime settings.'); }
  if (saved?.version !== 1 || typeof saved.enabled !== 'boolean') throw sandboxError('sandbox_policy_invalid', 'Invalid saved sandbox setting. Check Runtime settings.');
  return snapshotCommandSandbox({ ...base, mode: saved.enabled ? 'auto' : 'off' });
}

export function commandSandboxPolicy(configuration: CommandSandboxConfiguration, context: ToolAdmissionContext<unknown>): ExecutionSandboxPolicy | undefined {
  if (configuration.mode === 'off' || (configuration.mode === 'auto' && context.turn?.request.permissionMode === 'all_free')) return;
  const workspace = workspaceRoot(context);
  // Approving a cwd, choosing all_free, or supplying taskRoots does not expand
  // the host sandbox. Additional directories need host configuration.
  return {
    network: configuration.network,
    writableRoots: [...new Set([...(workspace ? [workspace] : []), ...configuration.writableRoots])],
    readableRoots: [...configuration.readableRoots],
    ...(configuration.linuxExecutable ? { linuxExecutable: configuration.linuxExecutable } : {}),
  };
}
