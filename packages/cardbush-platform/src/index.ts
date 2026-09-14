import fs from 'node:fs';
import path from 'node:path';
import { defaultTerminalRuntime, normalizeTerminalRuntime, type TerminalRuntime, type CommandShell } from './contracts.js';
export * from './contracts.js';

export interface PlatformContext {
  platform: NodeJS.Platform; arch: string; env: NodeJS.ProcessEnv;
  isExecutable: (file: string) => boolean;
}
export function createPlatformContext(overrides: Partial<PlatformContext> = {}): PlatformContext {
  const platform = overrides.platform ?? process.platform;
  return { platform, arch: overrides.arch ?? process.arch, env: overrides.env ?? process.env,
    isExecutable: overrides.isExecutable ?? (file => {
      try { return fs.statSync(file).isFile() && (fs.accessSync(file, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK), true); }
      catch { return false; }
    }) };
}
function environment(context: PlatformContext, name: string) {
  return context.env[name] ?? (context.platform === 'win32'
    ? Object.entries(context.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] : undefined);
}
export function findExecutable(command: string, context = createPlatformContext()): string | undefined {
  if (!command.trim() || command.includes('\0')) return undefined;
  const windows = context.platform === 'win32', paths = windows ? path.win32 : path.posix;
  const extensions = windows && !paths.extname(command) ? (environment(context,'PATHEXT') ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  const directories = paths.isAbsolute(command) || /[/\\]/.test(command)
    ? [''] : (environment(context,'PATH') ?? '').split(windows ? ';' : ':').map(value => value.replace(/^"|"$/g, '')).filter(Boolean);
  for (const directory of directories) for (const extension of extensions) {
    const file = directory ? paths.join(directory, command + extension) : command + extension;
    if (context.isExecutable(file)) return file;
  }
  return undefined;
}
export function gitBashExecutable(context = createPlatformContext()): string | undefined {
  if (context.platform !== 'win32') return findExecutable('bash',context) ?? (context.isExecutable('/bin/bash') ? '/bin/bash' : undefined);
  const paths = path.win32;
  const git = findExecutable('git.exe',context);
  const base = git ? paths.dirname(git) : undefined;
  const candidates = base ? [paths.join(base,'bash.exe'),paths.resolve(base,'../bin/bash.exe'),paths.resolve(base,'../../usr/bin/bash.exe')] : [];
  for (const directory of [environment(context,'ProgramFiles'),environment(context,'ProgramFiles(x86)'),
    environment(context,'LOCALAPPDATA') && paths.join(environment(context,'LOCALAPPDATA')!,'Programs')]) {
    if (directory) candidates.push(paths.join(directory,'Git/bin/bash.exe'));
  }
  // Do not resolve the legacy Windows bash.exe WSL shim as Git Bash.
  return candidates.find(context.isExecutable);
}
function powershell(context: PlatformContext): string | undefined {
  if (context.platform !== 'win32') return findExecutable('pwsh',context);
  return findExecutable('pwsh.exe',context) ?? findExecutable('powershell.exe',context) ?? 'powershell.exe';
}
function nativeShell(context: PlatformContext): string {
  const preferred = environment(context,'SHELL')?.trim();
  if (preferred && path.posix.isAbsolute(preferred) && context.isExecutable(preferred)) return preferred;
  return ['/bin/bash','/bin/sh'].find(context.isExecutable) ?? '/bin/sh';
}
export function terminalRuntimes(context = createPlatformContext()): TerminalRuntime[] {
  if (context.platform !== 'win32') return ['bash', ...(powershell(context) ? ['powershell' as const] : [])];
  return ['powershell', ...(findExecutable('wsl.exe',context) ? ['wsl' as const] : []), ...(gitBashExecutable(context) ? ['git_bash' as const] : [])];
}
export function terminalInvocation(runtime?: TerminalRuntime, cwd?: string, command?: string, context = createPlatformContext()): {command: string; args: string[]} {
  let selected = normalizeTerminalRuntime(runtime,context.platform);
  if (selected === 'powershell' && !powershell(context)) {
    if (command !== undefined) throw new Error('PowerShell is unavailable. Install pwsh or select the native shell.');
    selected = defaultTerminalRuntime(context.platform);
  }
  const override = environment(context,'CARDBUSH_TERMINAL_SHELL')?.trim();
  if (override && selected === defaultTerminalRuntime(context.platform)) {
    const executable = findExecutable(override,context);
    if (!executable) throw new Error('CARDBUSH_TERMINAL_SHELL must name an available executable, without command arguments.');
    return {command:executable,args:command === undefined ? [] : selected === 'powershell'
      ? ['-NoLogo','-NoProfile','-NonInteractive','-Command',powerShellCommand(command)] : ['-lc',command]};
  }
  if (selected === 'wsl') return { command:findExecutable('wsl.exe',context) ?? 'wsl.exe',
    args:[...(cwd ? ['--cd',cwd] : []), ...(command === undefined ? [] : ['--','sh','-lc',command])] };
  if (selected === 'powershell') return {command:powershell(context)!,args:command === undefined ? ['-NoExit']
    : ['-NoLogo','-NoProfile','-NonInteractive','-Command',powerShellCommand(command)]};
  const executable = context.platform === 'win32' ? gitBashExecutable(context) : nativeShell(context);
  if (!executable) throw new Error('Git Bash is unavailable. Install Git for Windows or select PowerShell.');
  return {command:executable,args:command === undefined ? (context.platform === 'win32' ? ['--login','-i'] : []) : ['-lc',command]};
}
export function powerShellCommand(command: string) {
  // Inspect status in the user's scope, including trailing comments and cmdlet errors.
  return ['[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)',
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)', '$OutputEncoding = [Console]::OutputEncoding',
    '& {',command,'$cardbushCommandSucceeded = $?','$cardbushNativeExitCode = $LASTEXITCODE',
    'if ($null -ne $cardbushNativeExitCode -and $cardbushNativeExitCode -ne 0) { exit $cardbushNativeExitCode }',
    'if (-not $cardbushCommandSucceeded) { exit 1 }','}'].join('\n');
}
export function commandInvocation(shell: CommandShell, command: string, context = createPlatformContext()): {executable:string;args:string[]} {
  if (shell === 'powershell') {
    const executable = powershell(context);
    if (!executable) throw new Error('PowerShell is unavailable on this host.');
    return {executable,args:['-NoLogo','-NoProfile','-NonInteractive','-Command',powerShellCommand(command)]};
  }
  if (shell === 'cmd') {
    if (context.platform !== 'win32') throw new Error('cmd is unavailable on this host.');
    return {executable:environment(context,'ComSpec')?.trim() || 'cmd.exe',args:['/d','/s','/c',command]};
  }
  if (context.platform === 'win32') throw new Error('POSIX shell is unavailable in the native Windows runtime.');
  return {executable:'/bin/sh',args:['-c',command]};
}
export function bundledToolPath(root: string, tool: 'ripgrep', platform = process.platform, arch: string = process.arch): string | undefined {
  if (arch !== 'x64' || !['win32','linux'].includes(platform)) return undefined;
  return (platform === 'win32' ? path.win32 : path.posix).join(root,'runtime-tools',tool,`${platform}-${arch}`,platform === 'win32' ? 'rg.exe' : 'rg');
}
