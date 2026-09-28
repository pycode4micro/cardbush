[CmdletBinding(SupportsShouldProcess)]
param([Parameter(Mandatory)][string]$ManifestPath)
$ErrorActionPreference = 'Stop'

# Run from the user's ordinary PowerShell, never a process carrying the package
# identity: registry virtualization would otherwise hide, rather than delete, it.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CardBushCleanupIdentity {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
  public static extern int GetCurrentPackageFamilyName(ref uint length, IntPtr name);
}
'@
[uint32]$identityLength = 0
if ([CardBushCleanupIdentity]::GetCurrentPackageFamilyName([ref]$identityLength, [IntPtr]::Zero) -ne 15700) {
  throw 'Run this script in Windows Terminal PowerShell outside CardBush.'
}

$manifestFile = [IO.Path]::GetFullPath($ManifestPath)
$directory = [IO.Path]::GetDirectoryName($manifestFile)
$dataRoot = [IO.Path]::GetDirectoryName($directory)
$profileRoot = [Environment]::GetFolderPath('UserProfile')
$roamingRoot = [IO.Path]::Combine($profileRoot, 'AppData', 'Roaming', 'cardbush')
$packagesRoot = [IO.Path]::Combine($profileRoot, 'AppData', 'Local', 'Packages')
$packagePattern = '^' + [Regex]::Escape($packagesRoot) + '\\[^\\]+\\LocalCache\\Roaming\\cardbush$'
if ([IO.Path]::GetFileName($manifestFile) -cne 'com.cardbush.browser_connector.json' -or
    [IO.Path]::GetFileName($directory) -cne 'browser-connector' -or
    ($dataRoot -ine $roamingRoot -and $dataRoot -inotmatch $packagePattern)) {
  throw 'The manifest is not in this user''s legacy CardBush data directory.'
}
if (!(Test-Path -LiteralPath $manifestFile)) { Write-Output 'No legacy manifest remains.'; return }
for ($target = $manifestFile; $target -and $target -ine $profileRoot; $target = [IO.Path]::GetDirectoryName($target)) {
  if ((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Refusing redirected connector paths.'
  }
  if ($target.Length -lt $profileRoot.Length) { throw 'Connector path left the current user profile.' }
}
$manifestText = [IO.File]::ReadAllText($manifestFile)
$manifest = $manifestText | ConvertFrom-Json
$sha = [Security.Cryptography.SHA256]::Create()
try { $owner = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($dataRoot.ToLowerInvariant()))).Replace('-', '').ToLowerInvariant() }
finally { $sha.Dispose() }
if ($manifest.name -cne 'com.cardbush.browser_connector' -or $manifest.type -cne 'stdio' -or
    @($manifest.allowed_origins).Count -ne 1 -or $manifest.allowed_origins[0] -cne 'chrome-extension://iibaamkfgackofhhpadgnmgcjkhckeln/' -or
    [IO.Path]::GetFileName([string]$manifest.path) -ine 'CardBushBrowserHost.exe' -or
    ($null -ne $manifest.cardbush_owner -and $manifest.cardbush_owner -cne $owner)) {
  throw 'Legacy manifest ownership cannot be verified. Nothing was removed.'
}
$leaseHash = [Security.Cryptography.SHA256]::Create()
try { $leaseId = [BitConverter]::ToString($leaseHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($profileRoot.ToLowerInvariant()))).Replace('-', '').ToLowerInvariant().Substring(0, 24) }
finally { $leaseHash.Dispose() }
$lease = $null
try {
  $lease = [IO.Pipes.NamedPipeServerStream]::new("cardbush-connector-owner-$leaseId", [IO.Pipes.PipeDirection]::InOut, 1)
  $bridgeFile = Join-Path $directory 'bridge.json'
  if (Test-Path -LiteralPath $bridgeFile) {
    if ((Get-Item -LiteralPath $bridgeFile -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected bridge file.' }
    $bridge = [IO.File]::ReadAllText($bridgeFile) | ConvertFrom-Json
    if ($bridge.pid -and (Get-Process -Id $bridge.pid -ErrorAction SilentlyContinue)) { throw 'Exit CardBush before cleaning the legacy connector.' }
  }
  $keyName = 'Software\Google\Chrome\NativeMessagingHosts\com.cardbush.browser_connector'
  # Inspect both views before changing either. Only our exact default value may
  # be removed; unrelated values and subkeys are always preserved.
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
    $userKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
    try {
      $key = $userKey.OpenSubKey($keyName)
      try {
        if ($null -ne $key -and $null -ne $key.GetValue('') -and [string]$key.GetValue('') -ine $manifestFile) { throw 'Another installation owns the registry value. Nothing was removed.' }
      } finally { if ($key) { $key.Dispose() } }
    } finally { $userKey.Dispose() }
  }
  if (!$PSCmdlet.ShouldProcess($manifestFile, 'Remove verified legacy Chrome connector registration and configuration')) { return }
  if ([IO.File]::ReadAllText($manifestFile) -cne $manifestText) { throw 'Manifest changed; cleanup stopped.' }
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
    $userKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
    try {
      $key = $userKey.OpenSubKey($keyName, $true)
      $empty = $false
      try {
        if ($null -ne $key) {
          $value = $key.GetValue('')
          if ($null -ne $value -and [string]$value -ine $manifestFile) { throw 'Registry ownership changed; cleanup stopped.' }
          if ($null -ne $value) { $key.DeleteValue('', $false) }
          $empty = $key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0
        }
      } finally { if ($key) { $key.Dispose() } }
      if ($empty) { $userKey.DeleteSubKey($keyName, $false) }
      $verify = $userKey.OpenSubKey($keyName)
      try { if ($verify -and $null -ne $verify.GetValue('')) { throw 'Registry cleanup verification failed.' } }
      finally { if ($verify) { $verify.Dispose() } }
    } finally { $userKey.Dispose() }
  }
  # Recheck files after registry work; never follow a replaced path during cleanup.
  foreach ($target in @($directory, $manifestFile, $bridgeFile)) {
    if ((Test-Path -LiteralPath $target) -and ((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Connector paths changed; cleanup stopped.' }
  }
  if ([IO.File]::ReadAllText($manifestFile) -cne $manifestText) { throw 'Manifest changed; cleanup stopped.' }
  Remove-Item -LiteralPath $manifestFile
  if (Test-Path -LiteralPath $bridgeFile) { Remove-Item -LiteralPath $bridgeFile }
  $preferenceFile = Join-Path $directory 'preference.json'
  if ((Test-Path -LiteralPath $preferenceFile) -and !((Get-Item -LiteralPath $preferenceFile -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    $preference = [IO.File]::ReadAllText($preferenceFile) | ConvertFrom-Json
    if ($preference.version -eq 1) { Remove-Item -LiteralPath $preferenceFile }
  }
  Write-Output 'Legacy connector registration removed. User files and the Chrome extension were preserved.'
} finally { if ($lease) { $lease.Dispose() } }
