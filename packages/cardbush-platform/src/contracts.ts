/** Browser-safe contracts. Native discovery belongs in the Node entry point. */
export type TerminalRuntime = 'powershell' | 'wsl' | 'git_bash' | 'bash';
export type CommandShell = 'powershell' | 'cmd' | 'posix';
export function defaultTerminalRuntime(platform: string): TerminalRuntime {
  return platform === 'win32' ? 'powershell' : 'bash';
}
export function normalizeTerminalRuntime(value: unknown, platform: string): TerminalRuntime {
  if (value === 'powershell' || value === 'bash') return value;
  if (platform === 'win32' && (value === 'wsl' || value === 'git_bash')) return value;
  return defaultTerminalRuntime(platform);
}
export function platformFeatures(platform: string, arch: string) {
  return { computerUse: platform === 'win32', chromeNativeConnector: platform === 'win32',
    nativeProcessLimits: platform === 'win32' && arch === 'x64' };
}
