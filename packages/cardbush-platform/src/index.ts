import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultTerminalRuntime, normalizeTerminalRuntime, type TerminalRuntime, type CommandShell } from './contracts.js';
export * from './contracts.js';

/** Decode file URLs using the target host's path rules, preserving plain paths. */
export function localPath(value: string, platform: string = process.platform): string {
  const trimmed = String(value ?? '').trim();
  if (!/^file:/i.test(trimmed)) return trimmed;
  try { return fileURLToPath(trimmed, { windows: platform === 'win32' }); }
  catch { return trimmed; }
}

/** Bind a storage path once, including non-existent children of an existing parent. */
export function canonicalStoragePath(value: string): string {
  const pending: string[] = [];
  let parent = path.resolve(value);
  while (true) {
    try { return path.join(fs.realpathSync.native(parent), ...pending); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const next = path.dirname(parent);
      if (next === parent) throw error;
      pending.unshift(path.basename(parent));
      parent = next;
    }
  }
}

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
  const selected = findExecutable('pwsh.exe',context);
  if (selected && path.win32.isAbsolute(selected)) return selected;
  const root = environment(context,'ProgramFiles');
  const installed = root && path.win32.isAbsolute(root) && path.win32.join(root,'PowerShell','7','pwsh.exe');
  return installed && context.isExecutable(installed) ? installed : undefined;
}
export function powerShellExecutable(context = createPlatformContext()): string {
  const executable = powershell(context);
  if (!executable) throw Error('PowerShell 7 (pwsh) is required. Ask the user to install PowerShell 7 on this host and make pwsh available. Windows PowerShell 5 is unsupported.');
  return executable;
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
  const override = environment(context,'CARDBUSH_TERMINAL_SHELL')?.trim();
  let selected = normalizeTerminalRuntime(runtime,context.platform);
  if (selected === 'powershell' && !powershell(context) && !(override && selected === defaultTerminalRuntime(context.platform))) {
    if (context.platform === 'win32' || command !== undefined) powerShellExecutable(context);
    selected = defaultTerminalRuntime(context.platform);
  }
  if (override && selected === defaultTerminalRuntime(context.platform)) {
    const executable = findExecutable(override,context);
    if (!executable) throw new Error('CARDBUSH_TERMINAL_SHELL must name an available executable, without command arguments.');
    if (context.platform === 'win32' && selected === 'powershell' && path.win32.basename(executable).toLowerCase() !== 'pwsh.exe') throw Error('Windows terminal overrides must select PowerShell 7 (pwsh.exe); Windows PowerShell 5 is unsupported.');
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
export function powerShellCommand(command: string, diagnosticToken?: string) {
  if (diagnosticToken && !/^[a-f0-9]{32}$/.test(diagnosticToken)) throw new Error('Invalid terminal diagnostic token.');
  // Inspect status in the user's scope, including trailing comments and cmdlet errors.
  return ['if ($PSVersionTable.PSVersion.Major -lt 7) { [Console]::Error.WriteLine("PowerShell 7 (pwsh) is required; ask the user to install it. Windows PowerShell 5 is unsupported."); exit 2 }', '[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)',
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)', '$OutputEncoding = [Console]::OutputEncoding',
    '$cardbushPhase = "working_directory"', '$Error.Clear()',
    'try {',
    // The sandbox may already use a provider drive rooted at the admitted cwd.
    // Re-entering the absolute path would probe parents it cannot access.
    '$cardbushPathComparison = if ([IO.Path]::DirectorySeparatorChar -eq [char]92) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }',
    'if (-not [string]::Equals((Get-Location).ProviderPath.TrimEnd([IO.Path]::DirectorySeparatorChar), ([Environment]::CurrentDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar), $cardbushPathComparison)) { Set-Location -LiteralPath ([Environment]::CurrentDirectory) -ErrorAction Stop }',
    '$cardbushPhase = "command"', '& {',command,'$cardbushCommandSucceeded = $?','$cardbushNativeExitCode = $LASTEXITCODE',
    'if ($null -ne $cardbushNativeExitCode -and $cardbushNativeExitCode -ne 0) { exit $cardbushNativeExitCode }',
    'if (-not $cardbushCommandSucceeded) { exit 1 }','}',
    '} catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }',
    ...(diagnosticToken ? ['finally {',
      // ErrorRecord types survive -ErrorAction SilentlyContinue and localization.
      // This is interpreter telemetry, not proof that no side effects occurred.
      '$cardbushDiagnostic = $null',
      'foreach ($cardbushError in @($Error)) {',
      '$cardbushException = $cardbushError.Exception; $cardbushPermission = $false',
      'while ($null -ne $cardbushException) {',
      'if ($cardbushException -is [UnauthorizedAccessException] -or $cardbushException.HResult -eq -2147024891 -or ($cardbushException -is [ComponentModel.Win32Exception] -and $cardbushException.NativeErrorCode -eq 5)) { $cardbushPermission = $true; break }',
      '$cardbushException = $cardbushException.InnerException', '}',
      '$cardbushPermission = $cardbushPermission -or $cardbushError.CategoryInfo.Category -eq [System.Management.Automation.ErrorCategory]::PermissionDenied',
      'if ($null -eq $cardbushDiagnostic -or $cardbushPermission) {',
      '$cardbushDiagnostic = @{source="powershell"; phase=$cardbushPhase; permissionDenied=$cardbushPermission; category=[string]$cardbushError.CategoryInfo.Category; exceptionType=$cardbushError.Exception.GetType().FullName}',
      'if ($cardbushError.Exception -is [System.Management.Automation.CommandNotFoundException]) { $cardbushDiagnostic.commandName = [string]$cardbushError.Exception.CommandName }',
      '}', 'if ($cardbushPermission) { break }', '}',
      `if ($null -ne $cardbushDiagnostic) { [Console]::Error.Write(([char]30 + '${diagnosticToken}:' + (ConvertTo-Json -InputObject $cardbushDiagnostic -Compress) + [char]31)) }`,
      '}'] : []),
  ].join('\n');
}
export function commandInvocation(shell: CommandShell, command: string, context = createPlatformContext(), diagnosticToken?: string): {executable:string;args:string[]} {
  if (shell === 'powershell') {
    const executable = powerShellExecutable(context);
    return {executable,args:['-NoLogo','-NoProfile','-NonInteractive','-Command',powerShellCommand(command, diagnosticToken)]};
  }
  if (shell === 'cmd') {
    if (context.platform !== 'win32') throw new Error('cmd is unavailable on this host.');
    // /u affects only cmd built-ins. Mixing their UTF-16 with a native tool's
    // byte output in the same pipe corrupts decoding (and even model JSON).
    // Keep cmd's normal code-page output; PowerShell explicitly uses UTF-8.
    return {executable:environment(context,'ComSpec')?.trim() || 'cmd.exe',args:['/d','/a','/s','/c',command]};
  }
  if (context.platform === 'win32') throw new Error('POSIX shell is unavailable in the native Windows runtime.');
  return {executable:'/bin/sh',args:['-c',command]};
}

/** Shell built-ins may use UTF-16; native child programs still emit their own encoding. */
export function decodeCommandOutput(bytes: Buffer, platform: string = process.platform): string {
  if (!bytes.length) return '';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (platform === 'win32' && bytes.length % 2 === 0) {
    let evenNulls = 0, oddNulls = 0;
    for (let index = 0; index < bytes.length; index += 2) {
      if (bytes[index] === 0) evenNulls++;
      if (bytes[index + 1] === 0) oddNulls++;
    }
    if (oddNulls > evenNulls && oddNulls * 4 >= bytes.length) return new TextDecoder('utf-16le').decode(bytes);
    // A Chinese-only cmd line can have no ASCII except its final CR/LF.
    if (bytes.length >= 4 && bytes.subarray(-4).equals(Buffer.from([13, 0, 10, 0]))) return new TextDecoder('utf-16le').decode(bytes);
  }
  try { return new TextDecoder('utf-8', {fatal:true}).decode(bytes); }
  catch {
    if (platform === 'win32') {
      try { return new TextDecoder('gbk', {fatal:true}).decode(bytes); } catch { /* Keep undecodable output visible. */ }
    }
    return bytes.toString('utf8');
  }
}
export function bundledToolPath(root: string, tool: 'ripgrep', platform = process.platform, arch: string = process.arch): string | undefined {
  if (arch !== 'x64' || !['win32','linux'].includes(platform)) return undefined;
  return (platform === 'win32' ? path.win32 : path.posix).join(root,'runtime-tools',tool,`${platform}-${arch}`,platform === 'win32' ? 'rg.exe' : 'rg');
}
