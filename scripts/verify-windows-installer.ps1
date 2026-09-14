$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true') { throw 'Installer round-trip tests run only in an isolated CI user profile.' }
$installer = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '../release') -Filter 'CardBush-*-windows-x64.exe' | Select-Object -First 1
if (-not $installer) { throw 'Installer is missing.' }
$installRoot = Join-Path $env:RUNNER_TEMP 'CardBush installer test'
$process = Start-Process -FilePath $installer.FullName -ArgumentList @('/S', '/CURRENTUSER', "/D=$installRoot") -WindowStyle Hidden -PassThru -Wait
if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
$executable = Join-Path $installRoot 'CardBush.exe'
if (-not (Test-Path -LiteralPath $executable)) { throw 'Installed application is missing.' }
node (Join-Path $PSScriptRoot 'run-packaged-smoke.mjs') $executable
if ($LASTEXITCODE -ne 0) { throw 'Installed application smoke failed.' }
$uninstaller = Join-Path $installRoot 'Uninstall CardBush.exe'
$process = Start-Process -FilePath $uninstaller -ArgumentList @('/S', "_?=$installRoot") -WindowStyle Hidden -PassThru -Wait
if ($process.ExitCode -ne 0) { throw "Uninstaller failed: $($process.ExitCode)" }
if (Test-Path -LiteralPath $executable) { throw 'Uninstaller left the application executable behind.' }
Write-Output 'Windows install, application startup and uninstall passed.'
