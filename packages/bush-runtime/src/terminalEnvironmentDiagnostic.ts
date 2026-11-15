import { createPlatformContext, findExecutable, type PlatformContext } from '@cardbush/platform';
import { posix, win32 } from 'node:path';

export interface HostCommandLookup {
  command: string;
  status: 'found' | 'not_found_in_host_path' | 'unavailable';
  path?: string;
}

/** Metadata only: never execute, install, grant access or search model-supplied paths. */
export function inspectHostCommand(command: string, host: PlatformContext = createPlatformContext()): HostCommandLookup | undefined {
  if (!/^[a-zA-Z0-9_+.-]{1,128}$/.test(command) || command === '.' || command === '..') return;
  const windows = host.platform === 'win32', paths = windows ? win32 : posix;
  const source = Object.entries(host.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const directories = source.split(windows ? ';' : ':').map(value => value.replace(/^"|"$/g, ''))
    .filter(value => paths.isAbsolute(value) && (!windows || /^[a-z]:[\\/]/i.test(value))).slice(0, 64);
  try {
    const path = findExecutable(command, { ...host, env: { PATH: directories.join(windows ? ';' : ':'), PATHEXT: '.EXE;.CMD;.BAT;.COM' } });
    return { command, status: path ? 'found' : 'not_found_in_host_path', ...(path ? { path } : {}) };
  } catch { return { command, status: 'unavailable' }; }
}

export function terminalEnvironmentDiagnostic(value: Record<string, unknown>, lookup?: HostCommandLookup) {
  const shell = value.shellDiagnostic as Record<string, unknown> | undefined;
  const sandbox = value.sandbox as Record<string, unknown> | undefined;
  const isolated = sandbox && ['windows-appcontainer', 'linux-bubblewrap'].includes(String(sandbox.backend));
  const missing = shell?.exceptionType === 'System.Management.Automation.CommandNotFoundException';
  const denied = shell?.permissionDenied === true;
  const failed = value.state === 'failed' || typeof value.exitCode === 'number' && value.exitCode !== 0;
  const executable = typeof value.shellExecutable === 'string' ? value.shellExecutable : '';
  const shellLaunchFailed = failed && value.commandStarted === false && win32.isAbsolute(executable) && /^pwsh\.exe$/i.test(win32.basename(executable));
  if (shellLaunchFailed) {
    return {
      execution_boundary: isolated ? 'sandbox' : 'host', availability: 'shell_launch_failed',
      host_command: { command: 'pwsh', status: 'found', path: executable }, installation: 'executable_found_on_host',
      command_started: false, access_granted: false,
      ...(typeof value.nativeErrorCode === 'number' ? { native_error_code: value.nativeErrorCode } : {}),
    };
  }
  if (!missing && !denied && !(isolated && failed)) return;
  return {
    execution_boundary: isolated ? 'sandbox' : 'host',
    availability: missing ? 'not_resolved_by_shell' : denied ? 'access_denied' : 'unverified',
    host_command: lookup ?? { status: 'not_checked' },
    installation: lookup?.status === 'found' ? 'executable_found_on_host' : 'unknown',
    access_granted: false,
  };
}
