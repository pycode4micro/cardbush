# Probe only the HWND owned by the isolated Electron test process.
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeTitlebarProbe {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x; public int y; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetSystemMenu(IntPtr hwnd, bool revert);
  [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr menu);
  [DllImport("user32.dll")] public static extern int GetMenuItemID(IntPtr menu, int index);
}
'@
[void][NativeTitlebarProbe]::SetThreadDpiAwarenessContext([IntPtr](-4))
$targetHandle = [IntPtr]([long]$request.handle)
$ownerPid = [uint32]0
[void][NativeTitlebarProbe]::GetWindowThreadProcessId($targetHandle, [ref]$ownerPid)
if ($ownerPid -ne [uint32]$request.ownerPid) { throw 'Test window ownership mismatch' }
$scale = [NativeTitlebarProbe]::GetDpiForWindow($targetHandle) / 96.0 * $request.zoom
$hits = @($request.points | ForEach-Object {
  $point = New-Object NativeTitlebarProbe+Point
  $point.x = [int]($_.x * $scale)
  $point.y = [int]($_.y * $scale)
  if (-not [NativeTitlebarProbe]::ClientToScreen($targetHandle, [ref]$point)) { throw 'Test window unavailable' }
  $position = [IntPtr]((($point.y -band 65535) -shl 16) -bor ($point.x -band 65535))
  $hit = [IntPtr]::Zero
  $success = [NativeTitlebarProbe]::SendMessageTimeout($targetHandle, 0x84, [IntPtr]::Zero, $position, 2, 3000, [ref]$hit)
  if ($success -eq [IntPtr]::Zero) { throw 'Native hit-test timed out' }
  @{name=$_.name; hit=$hit.ToInt64()}
})
$menu = [NativeTitlebarProbe]::GetSystemMenu($targetHandle, $false)
$commands = @(for ($index=0; $index -lt [NativeTitlebarProbe]::GetMenuItemCount($menu); $index++) {
  [NativeTitlebarProbe]::GetMenuItemID($menu, $index)
})
# Exercise the native system-menu entry point without showing a popup; the
# fixture's system-context-menu listener prevents its display.
if ($request.menu) {
  if (-not [NativeTitlebarProbe]::PostMessage($targetHandle, 0x106, [IntPtr]32, [IntPtr]0)) { throw 'Menu event failed' }
}
@{hits=$hits; commands=$commands} | ConvertTo-Json -Depth 4 -Compress
