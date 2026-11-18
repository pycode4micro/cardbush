import { win32 } from 'node:path';

export const cardbushTargetBlocked = 'CardBush windows are protected from Computer Use. Consult cardbush-docs and use the available CardBush management tools for product operations.';
const cardbushProductNameSource = String.raw`^(?:cardbush|cardbush-dev-[a-f0-9]+|com\.cardbush\.desktop(?:\.development\..+)?)$`;
const cardbushProductName = new RegExp(cardbushProductNameSource, 'i');

export function isCardbushApplicationName(value: string): boolean {
  const name = win32.basename(value.trim().replace(/^['"]+|['"]+$/g, '')).replace(/\.(?:exe|lnk)$/i, '');
  return cardbushProductName.test(name);
}

// Window identity comes from Win32 and the desktop host, never from a title or
// a model-supplied process ID. Owned dialogs inherit their owner's protection.
export const computerUseTargetPolicyScript = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
public static class CardBushComputerUseTargets {
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd,uint command);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
  public static bool IsProductName(string value) {
    string name=Path.GetFileName(value.Trim().Trim('"','\''));
    if(name.EndsWith(".exe",StringComparison.OrdinalIgnoreCase) || name.EndsWith(".lnk",StringComparison.OrdinalIgnoreCase))
      name=Path.GetFileNameWithoutExtension(name);
    return Regex.IsMatch(name,@"${cardbushProductNameSource}",RegexOptions.IgnoreCase|RegexOptions.CultureInvariant);
  }
  public static bool IsProtectedWindow(IntPtr hwnd) {
    uint desktopPid; UInt32.TryParse(Environment.GetEnvironmentVariable("CARDBUSH_DESKTOP_PROCESS_ID"),out desktopPid);
    if(IsProtectedProcess(hwnd,desktopPid))return true;
    hwnd=GetAncestor(hwnd,2);
    for(int depth=0; hwnd!=IntPtr.Zero && depth<32; depth++, hwnd=GetWindow(hwnd,4))
      if(IsProtectedProcess(hwnd,desktopPid))return true;
    return false;
  }
  static bool IsProtectedProcess(IntPtr hwnd,uint desktopPid) {
    uint pid; GetWindowThreadProcessId(hwnd,out pid);
    if(pid==0)return false;
    if(pid==desktopPid)return true;
    try { using(var process=Process.GetProcessById((int)pid)) return IsProductName(process.ProcessName); }
    catch(ArgumentException) { return false; }
    catch(InvalidOperationException) { return false; }
  }
  public static void AssertWindow(IntPtr hwnd) {
    if(IsProtectedWindow(hwnd))throw new InvalidOperationException("CARDBUSH_PROTECTED_TARGET");
  }
  public static void AssertLaunch(string name) {
    if(IsProductName(name))throw new InvalidOperationException("CARDBUSH_PROTECTED_TARGET");
  }
}
'@
`;
