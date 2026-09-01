import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

import type { Artifact } from '@cardbush/bush-protocol';
import type { ComputerUsePluginConfig } from '../config.js';

const execFileAsync = promisify(execFile);

export interface ComputerUseResult {
  output: unknown;
  paths: string[];
  artifacts: Artifact[];
}

export async function executeComputerUse(
  input: Record<string, unknown>,
  config: ComputerUsePluginConfig,
  signal?: AbortSignal,
): Promise<ComputerUseResult> {
  throwIfAborted(signal);
  ensureWindows();
  const action = String(input.action ?? '').trim();
  if (action === 'observe' || action === 'screenshot') {
    const capture = await captureDesktop(config.screenshotDirectory, signal);
    const windows = action === 'observe' ? await listWindows(signal) : undefined;
    return {
      output: { ...capture.output, ...(windows ? { windows } : {}) },
      paths: [capture.path],
      artifacts: [capture.artifact],
    };
  }
  if (action === 'open_app') {
    if (!config.allowOpenApp) throw new Error('Opening applications is disabled in Computer Use settings.');
    const app = requiredString(input.app, 'app');
    const launch = record(json(await powershell(openApplicationScript, {
      CARDBUSH_APP_TARGET: app,
    }, signal)));
    return plain({ action, app, launch });
  }
  if (action === 'window') {
    if (String(input.operation ?? '').trim().toLowerCase() === 'close' && !config.allowWindowClose) {
      throw new Error('Closing windows is disabled in Computer Use settings.');
    }
    return plain(await controlWindow(input, signal));
  }
  if (['click', 'type', 'key', 'scroll', 'drag'].includes(action)) {
    return plain(await runInput(action, input, signal));
  }
  throw new Error(`Unsupported computer_use action: ${action}`);
}

const openApplicationScript = String.raw`
$requested = $env:CARDBUSH_APP_TARGET.Trim()
if (-not $requested) { throw 'Application target is empty.' }

function Launch-CardBushApplication([string]$target, [string]$resolution) {
  $process = Start-Process -FilePath $target -PassThru
  [PSCustomObject]@{
    requested = $requested
    target = $target
    resolution = $resolution
    process_id = if ($null -ne $process) { $process.Id } else { $null }
  } | ConvertTo-Json -Compress
  exit 0
}

if (Test-Path -LiteralPath $requested -PathType Leaf) {
  Launch-CardBushApplication (Resolve-Path -LiteralPath $requested).Path 'path'
}

$commandNames = @($requested)
if (-not [IO.Path]::GetExtension($requested)) { $commandNames += "$requested.exe" }
foreach ($name in $commandNames) {
  $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $command) { Launch-CardBushApplication $command.Source 'command' }
}

$requestedBase = [IO.Path]::GetFileNameWithoutExtension($requested)
$appPathRoots = @(
  'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\App Paths',
  'Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\App Paths',
  'Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths'
)
foreach ($root in $appPathRoots) {
  $entry = Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | Where-Object {
    [string]::Equals([IO.Path]::GetFileNameWithoutExtension($_.PSChildName), $requestedBase, [StringComparison]::OrdinalIgnoreCase)
  } | Select-Object -First 1
  if ($null -ne $entry) {
    $target = $entry.GetValue('')
    if ($target -and (Test-Path -LiteralPath $target -PathType Leaf)) {
      Launch-CardBushApplication $target 'app_path'
    }
  }
}

$startAppMatches = @(Get-StartApps -ErrorAction SilentlyContinue | Where-Object {
  [string]::Equals($_.Name, $requested, [StringComparison]::OrdinalIgnoreCase) -or
  [string]::Equals($_.Name, $requestedBase, [StringComparison]::OrdinalIgnoreCase)
})
if ($startAppMatches.Count -eq 1) {
  $appId = $startAppMatches[0].AppID
  Start-Process -FilePath 'explorer.exe' -ArgumentList "shell:AppsFolder\$appId"
  [PSCustomObject]@{ requested=$requested; target=$appId; resolution='start_app'; process_id=$null } | ConvertTo-Json -Compress
  exit 0
}

$startMenuRoots = @(
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonStartMenu')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) }
$shortcuts = @($startMenuRoots | ForEach-Object {
  Get-ChildItem -LiteralPath $_ -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue
})
$exactShortcuts = @($shortcuts | Where-Object {
  [string]::Equals($_.BaseName, $requested, [StringComparison]::OrdinalIgnoreCase) -or
  [string]::Equals($_.BaseName, $requestedBase, [StringComparison]::OrdinalIgnoreCase)
})
if ($exactShortcuts.Count -eq 1) {
  Launch-CardBushApplication $exactShortcuts[0].FullName 'start_menu'
}

throw "Application '$requested' was not found as a path, executable, registered app, or Start menu shortcut."
`;

async function captureDesktop(configuredDirectory: string, signal?: AbortSignal) {
  const directory = configuredDirectory || join(tmpdir(), 'cardbush-apps', 'captures');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `capture-${Date.now()}-${randomUUID()}.png`);
  const script = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
  $bitmap.Save($env:CARDBUSH_CAPTURE_PATH, [System.Drawing.Imaging.ImageFormat]::Png)
  [PSCustomObject]@{ path=$env:CARDBUSH_CAPTURE_PATH; x=$bounds.Left; y=$bounds.Top; width=$bounds.Width; height=$bounds.Height } | ConvertTo-Json -Compress
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}`;
  const output = record(json(await powershell(
    script,
    { CARDBUSH_CAPTURE_PATH: path },
    signal,
  )));
  const artifact: Artifact = {
    artifact_id: `artifact_${randomUUID()}`,
    type: 'image',
    path,
    media_type: 'image/png',
    display: 'inline',
    metadata: { model_input: true, read_only: true, source: 'cardbush_apps' },
  };
  return { path, output, artifact };
}

async function listWindows(signal?: AbortSignal): Promise<unknown[]> {
  const output = await powershell(String.raw`
$items = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and $_.MainWindowTitle -ne 'Program Manager'
} | ForEach-Object {
  [PSCustomObject]@{ process_id=$_.Id; hwnd=$_.MainWindowHandle.ToInt64(); title=$_.MainWindowTitle; process_name=$_.ProcessName }
}
@($items) | ConvertTo-Json -Compress`, {}, signal);
  if (!output.trim()) return [];
  const value = json(output);
  return Array.isArray(value) ? value : [value];
}

async function controlWindow(input: Record<string, unknown>, signal?: AbortSignal) {
  const operation = String(input.operation ?? 'activate').trim().toLowerCase();
  const normalized = operation === 'activate' ? 'focus' : operation;
  if (!['focus', 'minimize', 'maximize', 'restore', 'close', 'move', 'resize'].includes(normalized)) {
    throw new Error(`Unsupported window operation: ${operation}`);
  }
  const windows = await listWindows(signal) as Array<Record<string, unknown>>;
  const target = selectWindowTarget(windows, input);
  const bounds = {
    x: optionalInteger(input.x),
    y: optionalInteger(input.y),
    width: optionalInteger(input.width),
    height: optionalInteger(input.height),
  };
  if (normalized === 'move' && (bounds.x == null || bounds.y == null)) throw new Error('move requires x and y.');
  if (normalized === 'resize' && (bounds.width == null || bounds.height == null)) throw new Error('resize requires width and height.');
  await powershell(windowControlScript, {
    CARDBUSH_WINDOW_HWND: String(target.hwnd),
    CARDBUSH_WINDOW_OPERATION: normalized,
    CARDBUSH_WINDOW_X: String(bounds.x ?? 0),
    CARDBUSH_WINDOW_Y: String(bounds.y ?? 0),
    CARDBUSH_WINDOW_WIDTH: String(bounds.width ?? 0),
    CARDBUSH_WINDOW_HEIGHT: String(bounds.height ?? 0),
  }, signal);
  return { action: 'window', operation: normalized, target };
}

export function selectWindowTarget(
  windows: Array<Record<string, unknown>>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const hwnd = optionalInteger(input.hwnd);
  const titlePattern = optionalString(input.title_pattern).toLowerCase();
  const app = normalizeProcessName(optionalString(input.app));
  if (hwnd == null && !titlePattern && !app) {
    throw new Error('Window action requires app, title_pattern, or hwnd.');
  }

  const matches = windows.filter((window) => {
    if (hwnd != null && Number(window.hwnd) !== hwnd) return false;
    if (
      app &&
      normalizeProcessName(String(window.process_name ?? '')) !== app
    ) {
      return false;
    }
    if (
      titlePattern &&
      !String(window.title ?? '').toLowerCase().includes(titlePattern)
    ) {
      return false;
    }
    return true;
  });
  if (matches.length === 1) return matches[0];

  const selector = [
    hwnd != null ? `hwnd=${hwnd}` : '',
    app ? `app="${app}"` : '',
    titlePattern ? `title_pattern="${titlePattern}"` : '',
  ].filter(Boolean).join(', ');
  if (matches.length === 0) {
    throw new Error(`Window was not found for ${selector}. Call action="observe" to list available windows.`);
  }
  const candidates = matches
    .slice(0, 6)
    .map(windowDescription)
    .join('; ');
  throw new Error(
    `Window selector ${selector} matched ${matches.length} windows: ${candidates}. Retry with hwnd.`,
  );
}

function normalizeProcessName(value: string) {
  const executable = value
    .replace(/^['"]|['"]$/g, '')
    .split(/[\\/]/)
    .at(-1)
    ?.trim()
    .toLowerCase() ?? '';
  const name = executable.replace(/\.exe$/i, '');
  const aliases: Record<string, string> = {
    'google chrome': 'chrome',
    'microsoft edge': 'msedge',
    'visual studio code': 'code',
  };
  return aliases[name] ?? name;
}

function windowDescription(window: Record<string, unknown>) {
  const title = String(window.title ?? '').replace(/\s+/g, ' ').trim();
  return `hwnd=${Number(window.hwnd) || 0} process=${String(window.process_name ?? '')} title="${title}"`;
}

async function runInput(
  action: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const payload = Buffer.from(JSON.stringify({ action, ...input }), 'utf8').toString('base64');
  const output = await powershell(
    computerInputScript,
    { CARDBUSH_INPUT_BASE64: payload },
    signal,
  );
  return output.trim() ? json(output) : { action };
}

const windowControlScript = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CardBushWindowControl {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int h2, uint f);
}
'@
$h = [IntPtr]([Int64]$env:CARDBUSH_WINDOW_HWND)
$op = $env:CARDBUSH_WINDOW_OPERATION
$rect = New-Object CardBushWindowControl+RECT
[void][CardBushWindowControl]::GetWindowRect($h, [ref]$rect)
switch ($op) {
  'focus' { [void][CardBushWindowControl]::ShowWindow($h,9); [void][CardBushWindowControl]::SetForegroundWindow($h) }
  'minimize' { [void][CardBushWindowControl]::ShowWindow($h,6) }
  'maximize' { [void][CardBushWindowControl]::ShowWindow($h,3) }
  'restore' { [void][CardBushWindowControl]::ShowWindow($h,9) }
  'close' { [void][CardBushWindowControl]::PostMessage($h,0x0010,[IntPtr]::Zero,[IntPtr]::Zero) }
  'move' { [void][CardBushWindowControl]::SetWindowPos($h,[IntPtr]::Zero,[int]$env:CARDBUSH_WINDOW_X,[int]$env:CARDBUSH_WINDOW_Y,$rect.Right-$rect.Left,$rect.Bottom-$rect.Top,0x0014) }
  'resize' { [void][CardBushWindowControl]::SetWindowPos($h,[IntPtr]::Zero,$rect.Left,$rect.Top,[int]$env:CARDBUSH_WINDOW_WIDTH,[int]$env:CARDBUSH_WINDOW_HEIGHT,0x0014) }
}`;

const computerInputScript = String.raw`
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CARDBUSH_INPUT_BASE64))
$p = $json | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class CardBushInput {
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion data; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public KEYBDINPUT keyboard; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort virtualKey; public ushort scanCode; public uint flags; public uint time; public UIntPtr extraInfo; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,int d,UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k,byte s,uint f,UIntPtr e);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  public static void Key(byte k,bool d){keybd_event(k,0,d?0u:2u,UIntPtr.Zero);}
  public static void Text(string text){
    foreach(char character in text){
      INPUT down=new INPUT{type=1,data=new InputUnion{keyboard=new KEYBDINPUT{scanCode=character,flags=4}}};
      INPUT up=new INPUT{type=1,data=new InputUnion{keyboard=new KEYBDINPUT{scanCode=character,flags=6}}};
      INPUT[] inputs=new INPUT[]{down,up};
      if(SendInput(2,inputs,Marshal.SizeOf(typeof(INPUT)))!=2) throw new InvalidOperationException("Unicode keyboard input failed.");
    }
  }
  public static void Drag(int x,int y,int tx,int ty,int steps,int duration){SetCursorPos(x,y);mouse_event(2,0,0,0,UIntPtr.Zero);for(int i=1;i<=steps;i++){SetCursorPos(x+(tx-x)*i/steps,y+(ty-y)*i/steps);if(duration>0)Thread.Sleep(duration/steps);}mouse_event(4,0,0,0,UIntPtr.Zero);}
}
'@
function KeyCode([string]$key) {
  $named = @{backspace=8;tab=9;enter=13;shift=16;ctrl=17;control=17;alt=18;escape=27;esc=27;space=32;pageup=33;pagedown=34;end=35;home=36;left=37;up=38;right=39;down=40;delete=46;win=91}
  $lower = $key.ToLowerInvariant()
  if ($named.ContainsKey($lower)) { return [byte]$named[$lower] }
  if ($lower -match '^[a-z0-9]$') { return [byte][char]$lower.ToUpperInvariant() }
  if ($lower -match '^f([1-9]|1[0-2])$') { return [byte](111 + [int]$Matches[1]) }
  throw "Unsupported key: $key"
}
switch ($p.action) {
  'click' { $b=if($p.button -eq 'right'){@(8,16)}elseif($p.button -eq 'middle'){@(32,64)}else{@(2,4)};$clicks=if($null -ne $p.clicks){[int]$p.clicks}else{1};[void][CardBushInput]::SetCursorPos([int]$p.x,[int]$p.y);1..$clicks|%{[CardBushInput]::mouse_event($b[0],0,0,0,[UIntPtr]::Zero);[CardBushInput]::mouse_event($b[1],0,0,0,[UIntPtr]::Zero)} }
  'scroll' { [CardBushInput]::mouse_event(2048,0,0,([int]$p.delta)*120,[UIntPtr]::Zero) }
  'drag' { $steps=if($null -ne $p.steps){[int]$p.steps}else{20};$duration=if($null -ne $p.duration_ms){[int]$p.duration_ms}else{400};[CardBushInput]::Drag([int]$p.x,[int]$p.y,[int]$p.to_x,[int]$p.to_y,$steps,$duration) }
  'type' { [CardBushInput]::Text([string]$p.text) }
  'key' { $keys=@($p.keys);if($keys.Count -eq 0 -or $null -eq $keys[0]){$keys=@($p.key)};$codes=@($keys|%{KeyCode ([string]$_)});$codes|%{[CardBushInput]::Key($_,$true)};[array]::Reverse($codes);$codes|%{[CardBushInput]::Key($_,$false)} }
}
[PSCustomObject]@{action=$p.action} | ConvertTo-Json -Compress`;

async function powershell(
  script: string,
  extraEnv: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const utf8Script = [
    '$cardbushUtf8 = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::InputEncoding = $cardbushUtf8',
    '[Console]::OutputEncoding = $cardbushUtf8',
    '$OutputEncoding = $cardbushUtf8',
    script,
  ].join('\n');
  const encodedCommand = Buffer.from(utf8Script, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodedCommand,
  ], {
    windowsHide: true,
    timeout: 15_000,
    signal,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  return stdout;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Computer Use was cancelled.');
  error.name = 'AbortError';
  throw error;
}

function plain(output: unknown): ComputerUseResult {
  return { output, paths: [], artifacts: [] };
}

function json(value: string): unknown {
  return JSON.parse(value.trim());
}

function requiredString(value: unknown, label: string): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result) throw new Error(`${label} is required.`);
  return result;
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalInteger(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('Expected a safe integer.');
  return result;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a structured desktop result.');
  }
  return value as Record<string, unknown>;
}

function ensureWindows(): void {
  if (process.platform !== 'win32') throw new Error('computer_use currently requires Windows.');
}
