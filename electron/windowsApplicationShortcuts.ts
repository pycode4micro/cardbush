import { execFile } from 'node:child_process';
import path from 'node:path';

// Read each file through the Windows Shell. Electron's extension-based icon
// cache can return the same generic icon for every .lnk or .url file.
// Input is JSON on stdin, never interpolated into PowerShell source.
const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -ReferencedAssemblies System.Drawing,System.Windows.Forms -TypeDefinition @'
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
public sealed class CardBushShortcutOwner : IWin32Window {
  public IntPtr Handle { get; private set; }
  public CardBushShortcutOwner(long handle) { Handle = new IntPtr(handle); }
}
public static class CardBushShortcutIcon {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct FileInfo {
    public IntPtr Icon;
    public int IconIndex;
    public uint Attributes;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string DisplayName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string TypeName;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  private static extern IntPtr SHGetFileInfo(string file, uint attributes, out FileInfo info, uint size, uint flags);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  private static extern uint ExtractIconEx(string file, int index, out IntPtr large, out IntPtr small, uint count);
  [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr icon);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  private static extern uint GetPrivateProfileString(string section, string key, string fallback, StringBuilder value, uint size, string file);
  public static string Read(string file) {
    FileInfo info;
    IntPtr large = IntPtr.Zero, small = IntPtr.Zero;
    string resource = "";
    int resourceIndex = 0;
    if (String.Equals(Path.GetExtension(file), ".url", StringComparison.OrdinalIgnoreCase)) {
      StringBuilder value = new StringBuilder(4096);
      GetPrivateProfileString("InternetShortcut", "IconFile", "", value, 4096, file);
      resource = Environment.ExpandEnvironmentVariables(value.ToString().Trim('"'));
      value.Clear();
      GetPrivateProfileString("InternetShortcut", "IconIndex", "0", value, 4096, file);
      Int32.TryParse(value.ToString(), out resourceIndex);
    }
    // Resolve the actual icon resource and index first, without the Shell's
    // shortcut-arrow badge. Fall back for Shell-managed and packaged apps.
    if (!File.Exists(resource) && SHGetFileInfo(file, 0, out info, (uint)Marshal.SizeOf(typeof(FileInfo)), 0x1000) != IntPtr.Zero) {
      resource = Environment.ExpandEnvironmentVariables(info.DisplayName ?? "");
      resourceIndex = info.IconIndex;
    }
    if (File.Exists(resource)) ExtractIconEx(resource, resourceIndex, out large, out small, 1);
    if (small != IntPtr.Zero) DestroyIcon(small);
    if (large == IntPtr.Zero) {
      if (SHGetFileInfo(file, 0, out info, (uint)Marshal.SizeOf(typeof(FileInfo)), 0x100) == IntPtr.Zero) return "";
      large = info.Icon;
    }
    if (large == IntPtr.Zero) return "";
    try {
      using (Icon icon = Icon.FromHandle(large))
      using (Bitmap bitmap = icon.ToBitmap())
      using (MemoryStream stream = new MemoryStream()) {
        bitmap.Save(stream, System.Drawing.Imaging.ImageFormat.Png);
        return "data:image/png;base64," + Convert.ToBase64String(stream.ToArray());
      }
    } finally { DestroyIcon(large); }
  }
}
'@
if ($request.action -eq 'pick') {
  $chooser = New-Object System.Windows.Forms.OpenFileDialog
  try {
    $chooser.Title = [string]$request.title
    # The Shell desktop merges the user's desktop (including redirected folders)
    # and the public desktop. A physical desktop path hides shared app shortcuts.
    $chooser.InitialDirectory = 'shell:Desktop'
    $chooser.Filter = [string]$request.filter
    $chooser.DereferenceLinks = $false
    $chooser.CheckFileExists = $true
    $chooser.Multiselect = $false
    $owner = [CardBushShortcutOwner]::new([long]$request.owner)
    $answer = if ($owner.Handle -ne [IntPtr]::Zero) { $chooser.ShowDialog($owner) } else { $chooser.ShowDialog() }
    if ($answer -ne [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write('null'); exit 0 }
    [Console]::Out.Write((@{ path = $chooser.FileName; icon = '' } | ConvertTo-Json -Compress))
    exit 0
  } finally { $chooser.Dispose() }
}
$icons = @{}
foreach ($file in $request.paths) {
  try { $icons[[string]$file] = [CardBushShortcutIcon]::Read([string]$file) } catch { $icons[[string]$file] = '' }
}
[Console]::Out.Write(($icons | ConvertTo-Json -Compress))
`;

type IconResult = { path: string; icon: string };
function runShell(request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024,
      ...(request.action === 'pick' ? {} : { timeout: 10_000 }), signal,
    }, (error, stdout) => {
      if (error) { reject(Error('无法读取系统快捷方式。 / Could not read Windows shortcuts.', { cause: error })); return; }
      try { resolve(JSON.parse(stdout.trim())); } catch (error) { reject(error); }
    });
    child.stdin?.on('error', () => {}); // The exit callback reports a failed helper.
    child.stdin?.end(JSON.stringify(request));
  });
}

export async function readWindowsApplicationIcon(target: string): Promise<string> {
  return (await readWindowsApplicationIcons([target]))[target] ?? '';
}

export async function readWindowsApplicationIcons(targets: string[]): Promise<Record<string, string>> {
  if (!targets.length) return {};
  if (targets.length > 100) throw Error('Too many shortcut icons');
  const result = await runShell({ action: 'icons', paths: targets });
  if (!result || typeof result !== 'object') throw Error('Invalid shortcut icons');
  return Object.fromEntries(targets.flatMap(target => {
    const icon = (result as Record<string, unknown>)[target];
    return typeof icon === 'string' && icon.length <= 131072 && /^data:image\/png;base64,[a-z0-9+/]+=*$/i.test(icon) ? [[target, icon]] : [];
  }));
}

export async function pickWindowsApplication(language: string, owner: Buffer | undefined, signal?: AbortSignal): Promise<IconResult | null> {
  const zh = language === 'zh';
  const handle = owner ? (owner.length >= 8 ? owner.readBigUInt64LE().toString() : String(owner.readUInt32LE())) : '0';
  const result = await runShell({ action: 'pick', owner: handle,
    title: zh ? '添加桌面快捷方式或本地应用' : 'Add a desktop shortcut or local app',
    filter: zh ? '桌面快捷方式 (*.lnk;*.url)|*.lnk;*.url|应用程序 (*.exe)|*.exe' : 'Desktop shortcuts (*.lnk;*.url)|*.lnk;*.url|Applications (*.exe)|*.exe',
  }, signal);
  if (result === null) return null;
  if (!result || typeof result !== 'object' || !('path' in result) || typeof result.path !== 'string') throw Error('Invalid shortcut selection');
  return { path: result.path, icon: '' };
}
