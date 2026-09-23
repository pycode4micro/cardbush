import { isAbsolute } from 'node:path';
import type { ToolHandlerContext } from './toolRegistry.js';
import { workspaceRoot } from './workspaceAccessPolicy.js';
import { sandboxError, type ExecutionSandboxPolicy } from './executionSandbox.js';

/** Supplied by the host at startup, never by a turn or a model tool call. */
export interface CommandSandboxConfiguration {
  mode: 'off' | 'required';
  network: 'disabled' | 'enabled';
  readableRoots: readonly string[];
  writableRoots: readonly string[];
}

export function commandSandboxConfiguration(env: NodeJS.ProcessEnv): CommandSandboxConfiguration {
  const mode = env.CARDBUSH_EXECUTION_SANDBOX?.trim() || 'off';
  const network = env.CARDBUSH_SANDBOX_NETWORK?.trim() || 'disabled';
  if (mode !== 'off' && mode !== 'required') throw sandboxError('sandbox_policy_invalid', 'CARDBUSH_EXECUTION_SANDBOX must be off or required.');
  if (network !== 'disabled' && network !== 'enabled') throw sandboxError('sandbox_policy_invalid', 'CARDBUSH_SANDBOX_NETWORK must be disabled or enabled.');
  function directories(key: string): readonly string[] {
    let value: unknown;
    try { value = JSON.parse(env[key] || '[]'); } catch { throw sandboxError('sandbox_policy_invalid', `${key} must be a JSON array of absolute directories.`); }
    if (!Array.isArray(value) || value.length > 64 || value.some(path => typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))) {
      throw sandboxError('sandbox_policy_invalid', `${key} must be a JSON array of absolute directories.`);
    }
    return Object.freeze([...new Set(value as string[])]);
  }
  return Object.freeze({ mode, network, readableRoots: directories('CARDBUSH_SANDBOX_READ_ROOTS'), writableRoots: directories('CARDBUSH_SANDBOX_WRITE_ROOTS') });
}

export function snapshotCommandSandbox(configuration?: CommandSandboxConfiguration): CommandSandboxConfiguration {
  return commandSandboxConfiguration(configuration ? {
    CARDBUSH_EXECUTION_SANDBOX: configuration.mode,
    CARDBUSH_SANDBOX_NETWORK: configuration.network,
    CARDBUSH_SANDBOX_READ_ROOTS: JSON.stringify(configuration.readableRoots),
    CARDBUSH_SANDBOX_WRITE_ROOTS: JSON.stringify(configuration.writableRoots),
  } : {});
}

export function commandSandboxPolicy(configuration: CommandSandboxConfiguration, context: ToolHandlerContext<unknown>): ExecutionSandboxPolicy | undefined {
  if (configuration.mode === 'off') return;
  const workspace = workspaceRoot(context);
  // Approving a cwd, choosing all_free, or supplying taskRoots does not expand
  // the host sandbox. Additional directories need host configuration.
  return {
    network: configuration.network,
    writableRoots: [...new Set([...(workspace ? [workspace] : []), ...configuration.writableRoots])],
    readableRoots: [...configuration.readableRoots],
  };
}
