/** Browser-safe contracts. Native discovery belongs in the Node entry point. */
export type TerminalRuntime = 'auto' | 'powershell' | 'cmd' | 'wsl' | 'git_bash' | 'bash';
const windowsCommandShells = ['powershell', 'cmd', 'powershell5'] as const;
const posixCommandShells = ['posix'] as const;
export type CommandShell = typeof windowsCommandShells[number] | typeof posixCommandShells[number];
export function commandShells(platform: string): readonly CommandShell[] {
  return platform === 'win32' ? windowsCommandShells : posixCommandShells;
}
export function isPowerShellExecutable(executableName: string): boolean {
  return /^(?:pwsh|powershell)\.exe$/i.test(executableName);
}
export function defaultTerminalRuntime(platform: string): TerminalRuntime {
  return platform === 'win32' ? 'auto' : 'bash';
}
export function normalizeTerminalRuntime(value: unknown, platform: string): TerminalRuntime {
  if (value === 'powershell' || value === 'bash') return value;
  if (platform === 'win32' && (value === 'cmd' || value === 'wsl' || value === 'git_bash')) return value;
  return defaultTerminalRuntime(platform);
}
export function platformFeatures(platform: string, arch: string) {
  return { computerUse: platform === 'win32', browserNativeConnector: platform === 'win32',
    chromeNativeConnector: platform === 'win32', // Compatibility with older desktop clients.
    nativeProcessLimits: platform === 'win32' && arch === 'x64' };
}
export type PluginRuntime = 'node' | 'python';
export type PluginRuntimeStatus = {kind: PluginRuntime; active?: string; versions: string[]};
export type PluginRuntimeAction = 'list' | 'install' | 'update' | 'use';
