param(
    [Parameter(Mandatory)][string]$OwnershipPath,
    [Parameter(Mandatory)][string]$ResultPath
)
$ErrorActionPreference='Stop'
# A PowerShell 7 caller can pass its module path to Windows PowerShell 5.1.
# Resolve this inbox module from the running shell before querying its ACLs.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security') -ErrorAction Stop
$ownership=Get-Content -LiteralPath $OwnershipPath -Raw | ConvertFrom-Json
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if($ownership.sid -ne $identity.User.Value -or !$ownership.previousPackageAbsent -or !$ownership.previousDataAbsent){throw 'Only a newly created validation installation may be removed.'}
$package=Get-AppxPackage -Name cardbush.cardbush
if(!$package -or $package.PackageFullName -ne $ownership.fullName){throw 'Installed package ownership mismatch.'}
$root=Join-Path $env:LOCALAPPDATA ('Packages\'+$package.PackageFamilyName)
if([IO.Path]::GetFullPath($root) -ine [IO.Path]::GetFullPath($ownership.root)){throw 'Unexpected package data root.'}
$connector=Join-Path $root 'LocalState\browser-connector'
if(!(Test-Path -LiteralPath $connector)){throw 'No connector state exists to test.'}
$result=[ordered]@{
    startedAt=(Get-Date -Format o)
    packageFullName=$package.PackageFullName
    success=$false
    elevated=([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    connectorFilesBefore=@(Get-ChildItem -LiteralPath $connector -File | Select-Object Name,Length)
    connectorAclBefore=(Get-Acl -LiteralPath $connector).Sddl
}
try {
    Remove-AppxPackage -Package $package.PackageFullName
    $deadline=(Get-Date).AddSeconds(15)
    while((Test-Path -LiteralPath $connector) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 250}
    $result.packageRegisteredAfter=[bool](Get-AppxPackage -Name cardbush.cardbush)
    $result.connectorRemains=Test-Path -LiteralPath $connector
    $result.packageRootRemains=Test-Path -LiteralPath $root
    $result.nativeMessagingRegistrationRemains=Test-Path -LiteralPath 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.cardbush.browser_connector'
    $result.success=!$result.packageRegisteredAfter -and !$result.connectorRemains -and !$result.nativeMessagingRegistrationRemains
} catch { $result.error=$_.Exception.Message }
$result.completedAt=Get-Date -Format o
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ResultPath -Encoding UTF8
if(!$result.success){exit 1}
