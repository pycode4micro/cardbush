param([string]$NativeHostPath = (Join-Path $PSScriptRoot '../dist-native/chrome-connector-validation/CardBushBrowserHost.exe'))
$ErrorActionPreference = 'Stop'
$nativeExecutable = (Resolve-Path -LiteralPath $NativeHostPath).Path
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CardBushApprovalDialogTest {
    public delegate bool Callback(IntPtr window, IntPtr state);
    [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr state);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    public static IntPtr Find(int process) {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr state) {
            uint pid; GetWindowThreadProcessId(window, out pid);
            if (pid == process && IsWindowVisible(window)) { found = window; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@
function New-ApprovalProcess {
    $child = New-Object System.Diagnostics.Process
    $child.StartInfo.FileName = $nativeExecutable
    $child.StartInfo.Arguments = '--approve-browser-connection chrome'
    $child.StartInfo.UseShellExecute = $false
    $child.StartInfo.CreateNoWindow = $true
    $child.StartInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $child.StartInfo.RedirectStandardOutput = $true
    [void]$child.Start()
    return $child
}
$first = $null
$second = $null
try {
    $first = New-ApprovalProcess
    $dialog = [IntPtr]::Zero
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        $dialog = [CardBushApprovalDialogTest]::Find($first.Id)
        if ($dialog -ne [IntPtr]::Zero) { break }
        if ($first.HasExited) { throw "Dialog host exited early: $($first.ExitCode)" }
        Start-Sleep -Milliseconds 50
    }
    if ($dialog -eq [IntPtr]::Zero) { throw 'Native dialog was not displayed.' }
    $defaultButton = [CardBushApprovalDialogTest]::SendMessage($dialog, 0x0400, [IntPtr]::Zero, [IntPtr]::Zero).ToInt64() -band 65535
    if ($defaultButton -ne 7) { throw "No must be selected by default, got $defaultButton" }
    $second = New-ApprovalProcess
    if (-not $second.WaitForExit(3000) -or $second.ExitCode -ne 3) { throw 'A concurrent dialog was not suppressed.' }
    # Reject only this test process's dialog; never click Allow or touch user windows.
    [void][CardBushApprovalDialogTest]::SendMessage($dialog, 0x0111, [IntPtr]7, [IntPtr]::Zero)
    if (-not $first.WaitForExit(3000)) { throw 'Reject did not close the dialog.' }
    if ($first.ExitCode -ne 0 -or $first.StandardOutput.ReadToEnd() -ne 'denied') { throw 'Reject must return denied.' }
    Write-Output 'Native Windows dialog displayed; default No, concurrent suppression and explicit rejection passed.'
} finally {
    foreach ($child in @($first, $second)) {
        if ($null -ne $child) { if (-not $child.HasExited) { $child.Kill(); [void]$child.WaitForExit(3000) }; $child.Dispose() }
    }
}
