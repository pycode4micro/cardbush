param([Parameter(Mandatory)][uint32]$ProcessId, [switch]$Dpi)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ValidationPackageIdentity {
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name);
    [DllImport("shcore.dll")] static extern int GetProcessDpiAwareness(IntPtr process, out int awareness);
    public static int ReadDpi(uint pid) {
        IntPtr handle = OpenProcess(0x1000, false, pid);
        if (handle == IntPtr.Zero) throw new InvalidOperationException("OpenProcess failed");
        try {
            int value; int code = GetProcessDpiAwareness(handle, out value);
            if (code != 0) throw new InvalidOperationException("GetProcessDpiAwareness failed: " + code);
            return value;
        } finally { CloseHandle(handle); }
    }
    public static string Read(uint pid) {
        IntPtr handle = OpenProcess(0x1000, false, pid);
        if (handle == IntPtr.Zero) throw new InvalidOperationException("OpenProcess failed: " + Marshal.GetLastWin32Error());
        try {
            uint length = 0; int code = GetPackageFullName(handle, ref length, null);
            if (code != 122) throw new InvalidOperationException("No package identity: " + code);
            var name = new StringBuilder((int)length);
            code = GetPackageFullName(handle, ref length, name);
            if (code != 0) throw new InvalidOperationException("GetPackageFullName failed: " + code);
            return name.ToString();
        } finally { CloseHandle(handle); }
    }
}
'@
if($Dpi){[ValidationPackageIdentity]::ReadDpi($ProcessId)}else{[ValidationPackageIdentity]::Read($ProcessId)}
