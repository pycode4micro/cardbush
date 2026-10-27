#requires -Version 7.0
param(
  [Parameter(Mandatory=$true)][string]$ReleaseRoot,
  [Parameter(Mandatory=$true)][string]$DataRoot,
  [Parameter(Mandatory=$true)][string]$User,
  [Parameter(Mandatory=$true)][string]$ServiceAccount,
  [string]$NodePath,
  [int]$Port = 4782
)
$ErrorActionPreference = 'Stop'
$powershell = Join-Path $PSHOME 'pwsh.exe'
if (!(Test-Path -LiteralPath $powershell -PathType Leaf)) { throw 'PowerShell 7 (pwsh) is required. Install it before running this optional desktop helper setup.' }
$ReleaseRoot = (Resolve-Path -LiteralPath $ReleaseRoot).Path
$DataRoot = (Resolve-Path -LiteralPath $DataRoot).Path
$node = if ($NodePath) { (Resolve-Path -LiteralPath $NodePath).Path } else { (Get-Command node.exe -ErrorAction Stop).Source }
if (!(Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Node executable was not found. Pass -NodePath when Node is not on PATH.' }
$entry = Join-Path $ReleaseRoot 'dist-electron\agentInteractiveDesktopCli.mjs'
if (!(Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'Install the complete updated Agent release first.' }
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Invalid loopback port.' }
$agent = Get-Content -LiteralPath (Join-Path $DataRoot 'agent.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (!$agent.id -or $agent.id -notmatch '^[a-zA-Z0-9-]+$') { throw 'Invalid Agent identity.' }
$userSid = ([Security.Principal.NTAccount]::new($User)).Translate([Security.Principal.SecurityIdentifier])
$serviceSid = ([Security.Principal.NTAccount]::new($ServiceAccount)).Translate([Security.Principal.SecurityIdentifier])
if ($userSid.Value -eq $serviceSid.Value -or $userSid.Value -in @('S-1-5-18','S-1-5-19','S-1-5-20')) {
  throw 'Select a separate interactive user; do not elevate or replace the Agent service account.'
}
$taskName = "CardBush Desktop $($agent.id)"
$bridgeRoot = Join-Path $DataRoot 'desktop-bridge'
$configPath = Join-Path $bridgeRoot 'connection.json'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw "Task already exists: $taskName. Preserve its configuration when upgrading." }
if (Test-Path -LiteralPath $configPath) { throw 'Desktop bridge configuration already exists; do not replace its token during an upgrade.' }
if (Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw 'Desktop bridge port is occupied.' }

function Grant-ExactPath([string]$Path, [Security.Principal.SecurityIdentifier]$Sid, [Security.AccessControl.FileSystemRights]$Rights) {
  $acl = Get-Acl -LiteralPath $Path
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($Sid,$Rights,'Allow'))
  Set-Acl -LiteralPath $Path -AclObject $acl
}
# Only traverse the data root. Computer Use policy is projected separately;
# the interactive helper never reads model keys or the Agent's access token.
Grant-ExactPath $DataRoot $userSid 'ReadAndExecute'
New-Item -ItemType Directory -Path $bridgeRoot -Force | Out-Null
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true,$false)
foreach ($sid in @('S-1-5-18','S-1-5-32-544')) {
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
}
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($userSid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($serviceSid,'Modify','ContainerInherit,ObjectInherit','None','Allow'))
Set-Acl -LiteralPath $bridgeRoot -AclObject $acl
$captures = Join-Path $bridgeRoot 'captures'
New-Item -ItemType Directory -Path $captures | Out-Null
$captureAcl = Get-Acl -LiteralPath $captures
$captureAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($userSid,'Modify','ContainerInherit,ObjectInherit','None','Allow'))
Set-Acl -LiteralPath $captures -AclObject $captureAcl
$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$token = ([BitConverter]::ToString($bytes)).Replace('-','').ToLowerInvariant()
$json = @{ protocol='cardbush.agent.desktop-bridge.v1'; agentId=$agent.id; port=$Port; token=$token } | ConvertTo-Json -Compress
[IO.File]::WriteAllText($configPath,$json,[Text.UTF8Encoding]::new($false))
& $node $entry --data-dir $DataRoot --sync-policy
if ($LASTEXITCODE -ne 0) { throw 'Failed to prepare Computer Use policy.' }
# Avoid exposing a console window and avoid storing a user's password. Task
# Scheduler supplies the selected user's existing interactive logon token.
$log = Join-Path $captures 'helper.log'
$command = "& '$($node.Replace("'","''"))' '$($entry.Replace("'","''"))' --data-dir '$($DataRoot.Replace("'","''"))' 2>> '$($log.Replace("'","''"))'; exit `$LASTEXITCODE"
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
$action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encoded" -WorkingDirectory $ReleaseRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'CardBush Computer Use MCP in the selected interactive session; main service remains isolated.' | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "Installed $taskName. Loopback port $Port. Restart the idle Agent service to load its desktop MCP transport."
