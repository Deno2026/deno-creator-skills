[CmdletBinding()]
param(
    [string]$PackagePath,
    [switch]$Install
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot "extensions\deno-premiere-uxp\manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$distRoot = Join-Path $repoRoot "dist\premiere-uxp"

if ([string]::IsNullOrWhiteSpace($PackagePath)) {
    $packageName = "{0}-{1}_{2}.ccx" -f $manifest.id, $manifest.version, $manifest.host.app
    $PackagePath = Join-Path $distRoot $packageName
}

$resolvedPackage = (Resolve-Path -LiteralPath $PackagePath).Path
if ([System.IO.Path]::GetExtension($resolvedPackage) -ne ".ccx") {
    throw "Package must be a .ccx file: $resolvedPackage"
}

$upiaPath = "C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
if (-not (Test-Path -LiteralPath $upiaPath -PathType Leaf)) {
    throw "Adobe Unified Plugin Installer Agent was not found: $upiaPath"
}

Write-Output "Package: $resolvedPackage"
Write-Output "Installer: $upiaPath"
Write-Output "Plugin: $($manifest.id) $($manifest.version)"

if (-not $Install) {
    Write-Output "Dry run only. Re-run with -Install after Premiere Pro and UXP Developer Tools are closed."
    exit 0
}

$runningHosts = Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -in @("Adobe Premiere Pro", "UXP Developer Tool", "UXP Developer Tools")
}
if ($runningHosts) {
    $names = ($runningHosts | Select-Object -ExpandProperty ProcessName -Unique) -join ", "
    throw "Close Premiere Pro and UXP Developer Tools before installing the persistent package. Running: $names"
}

$installProcess = Start-Process `
    -FilePath $upiaPath `
    -ArgumentList @("/install", "`"$resolvedPackage`"") `
    -Wait `
    -PassThru `
    -WindowStyle Hidden

if ($installProcess.ExitCode -ne 0) {
    throw "UPIA install failed with exit code $($installProcess.ExitCode)."
}

$listOutput = & $upiaPath /list all 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "UPIA list verification failed with exit code $LASTEXITCODE."
}
$listText = $listOutput -join "`n"
$installedPattern = "(?m)^\s*Enabled\s+" +
    [regex]::Escape([string]$manifest.name) +
    "\s+" +
    [regex]::Escape([string]$manifest.version) +
    "\s*$"
if ($listText -notmatch $installedPattern) {
    throw "UPIA completed but the installed plugin list does not contain enabled $($manifest.name) $($manifest.version)."
}

Write-Output "Installed and verified: $($manifest.id) $($manifest.version)"
Write-Output "The package will become active the next time Premiere Pro starts."
