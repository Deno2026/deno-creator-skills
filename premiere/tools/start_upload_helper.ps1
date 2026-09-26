[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9]+(?:-[a-z0-9]+)*$')]
    [string]$ProductionSlug,
    [string]$Url = "http://127.0.0.1:3000/",
    # Runtime root: -RuntimeRoot > DENO_UPLOAD_HELPER_RUNTIME_ROOT > local.config.json uploadRuntimeRoot > %LOCALAPPDATA%\DenoCreatorSkills\youtube-upload-helper
    [string]$RuntimeRoot = "",
    # Upload channel id (channels.json). Empty = the profile's default channel; another channel only when the user named it for this upload.
    [ValidatePattern('^[a-z0-9]*$')]
    [string]$YouTubeChannel = "",
    [int]$StartupTimeoutSeconds = 45,
    [switch]$NoBrowser,
    [switch]$PrepareOnly
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $RuntimeRoot) {
    if ($env:DENO_UPLOAD_HELPER_RUNTIME_ROOT) { $RuntimeRoot = $env:DENO_UPLOAD_HELPER_RUNTIME_ROOT }
    else {
        $localConfigPath = Join-Path $repoRoot "local.config.json"
        if (Test-Path -LiteralPath $localConfigPath) {
            $localConfig = Get-Content -LiteralPath $localConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($localConfig.uploadRuntimeRoot) { $RuntimeRoot = [string]$localConfig.uploadRuntimeRoot }
        }
        if (-not $RuntimeRoot) { $RuntimeRoot = Join-Path $env:LOCALAPPDATA "DenoCreatorSkills\youtube-upload-helper" }
    }
}
$channelsPath = Join-Path $RuntimeRoot "channels.json"
$defaultChannelId = "default"
if (Test-Path -LiteralPath $channelsPath) {
    $channelsProfile = Get-Content -LiteralPath $channelsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($channelsProfile.defaultChannel) { $defaultChannelId = [string]$channelsProfile.defaultChannel }
    elseif ($channelsProfile.channels -and $channelsProfile.channels.Count -gt 0) { $defaultChannelId = [string]$channelsProfile.channels[0].id }
}
if (-not $YouTubeChannel) { $YouTubeChannel = $defaultChannelId }
$appRoot = Join-Path $repoRoot "apps\youtube-upload-helper"
$handoffPath = Join-Path $repoRoot "productions\$ProductionSlug\publishing\handoff.json"
$serverRuntimeRoot = Join-Path $RuntimeRoot "runtime"
$stdoutLog = Join-Path $serverRuntimeRoot "upload-helper-server.out.log"
$stderrLog = Join-Path $serverRuntimeRoot "upload-helper-server.err.log"
$statePath = Join-Path $serverRuntimeRoot "upload-helper-launch-state.json"

if (-not (Test-Path -LiteralPath (Join-Path $appRoot "package.json"))) {
    throw "Upload Helper app was not found: $appRoot"
}
$handoffPresent = Test-Path -LiteralPath $handoffPath
if (-not $handoffPresent -and -not $PrepareOnly) {
    throw "Production publishing handoff was not found: $handoffPath"
}
if ($handoffPresent) {
    $handoffChannel = (Get-Content -LiteralPath $handoffPath -Raw -Encoding UTF8 | ConvertFrom-Json).youtubeChannel
    if (-not $handoffChannel) {
        $handoffChannel = $defaultChannelId
    }
    if ($handoffChannel -ne $YouTubeChannel) {
        throw "Upload channel mismatch: handoff youtubeChannel is '$handoffChannel' but -YouTubeChannel is '$YouTubeChannel'. Name the channel in both the handoff (--youtube-channel) and this launcher (-YouTubeChannel)."
    }
}
foreach ($requiredRuntimeFile in @("youtube-settings.json", "youtube-oauth-token.json")) {
    $requiredPath = Join-Path $RuntimeRoot $requiredRuntimeFile
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Existing Upload Helper runtime file is missing: $requiredPath"
    }
}

New-Item -ItemType Directory -Path $serverRuntimeRoot -Force | Out-Null

function Test-UploadHelperReady {
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
        return (
            $response.StatusCode -eq 200 -and
            $response.Content -match "Deno YouTube Upload Helper"
        )
    } catch {
        return $false
    }
}

function Wait-UploadHelperReady {
    param([int]$TimeoutSeconds)

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (Test-UploadHelperReady) {
            return $true
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)

    return $false
}

function Get-UploadHelperWorkspace {
    $headers = @{
        Origin = $Url.TrimEnd('/')
        "Sec-Fetch-Site" = "same-origin"
    }
    return Invoke-RestMethod -Uri ($Url.TrimEnd('/') + "/api/agent-workspace/projects") -Headers $headers -Method Get -TimeoutSec 10
}

function Set-UploadHelperChannel {
    param([string]$ChannelId)

    $headers = @{
        Origin = $Url.TrimEnd('/')
        "Sec-Fetch-Site" = "same-origin"
    }
    $body = @{ channel = $ChannelId } | ConvertTo-Json -Compress
    try {
        return Invoke-RestMethod -Uri ($Url.TrimEnd('/') + "/api/channels") -Headers $headers -Method Post -ContentType "application/json" -Body $body -TimeoutSec 10
    } catch {
        throw "Upload channel '$ChannelId' could not be selected: $($_.Exception.Message)"
    }
}

$env:DENO_PRODUCTION_ROOT = $repoRoot
$env:DENO_UPLOAD_HELPER_RUNTIME_ROOT = $RuntimeRoot
$env:DENO_ACTIVE_PRODUCTION_SLUG = $ProductionSlug

$serverAction = "reused"
$serverProcess = $null

if (-not (Test-UploadHelperReady)) {
    $portInUse = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1

    if ($portInUse) {
        if (-not (Wait-UploadHelperReady -TimeoutSeconds 10)) {
            throw "Port 3000 is occupied, but it is not the Deno YouTube Upload Helper."
        }
    } else {
        $npm = Get-Command npm.cmd -ErrorAction Stop
        $startParams = @{
            FilePath = $npm.Source
            ArgumentList = @("run", "dev")
            WorkingDirectory = $appRoot
            WindowStyle = "Hidden"
            RedirectStandardOutput = $stdoutLog
            RedirectStandardError = $stderrLog
            PassThru = $true
        }
        $serverProcess = Start-Process @startParams
        $serverAction = "started"

        if (-not (Wait-UploadHelperReady -TimeoutSeconds $StartupTimeoutSeconds)) {
            throw "Upload Helper did not become ready. Check: $stderrLog"
        }
    }
}

$workspace = Get-UploadHelperWorkspace
if ($workspace.activeSlug -ne $ProductionSlug) {
    throw "Upload Helper active production mismatch. Expected '$ProductionSlug', got '$($workspace.activeSlug)'. Stop the task-owned server and relaunch with the exact production."
}

# Reset the screen's selected channel on every launch so a previous task's choice never carries over.
$channelState = Set-UploadHelperChannel -ChannelId $YouTubeChannel
if ($channelState.activeChannelId -ne $YouTubeChannel) {
    throw "Upload Helper channel was not applied. Expected '$YouTubeChannel', got '$($channelState.activeChannelId)'."
}
$selectedChannel = @($channelState.channels | Where-Object { $_.id -eq $YouTubeChannel })[0]
$channelTokenPresent = [bool]$selectedChannel.tokenPersistence.hasRefreshToken

$browserAction = "skipped"
$chromePath = $null

if (-not $NoBrowser) {
    $chromeCandidates = @(
        (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
        (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
    )
    $chromePath = $chromeCandidates |
        Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
        Select-Object -First 1

    if (-not $chromePath) {
        throw "Google Chrome was not found. Upload Helper is running at $Url"
    }

    Start-Process -FilePath $chromePath -ArgumentList @("--new-window", $Url) | Out-Null
    $browserAction = "chrome-opened"
}

$state = [ordered]@{
    ready = $true
    url = $Url
    checkedAt = [DateTimeOffset]::Now.ToString("o")
    productionSlug = $ProductionSlug
    productionHandoff = if ($handoffPresent) { $handoffPath } else { $null }
    handoffPresent = $handoffPresent
    launchMode = if ($handoffPresent) { "production-handoff" } else { "prepare-only" }
    runtimeRoot = $RuntimeRoot
    youtubeChannel = $YouTubeChannel
    youtubeChannelTitle = $selectedChannel.title
    youtubeChannelTokenPresent = $channelTokenPresent
    serverAction = $serverAction
    serverPid = if ($serverProcess) { $serverProcess.Id } else { $null }
    browserAction = $browserAction
    browserPath = $chromePath
    oauthSettingsPresent = Test-Path -LiteralPath (Join-Path $RuntimeRoot "youtube-settings.json")
    oauthTokenPresent = Test-Path -LiteralPath (Join-Path $RuntimeRoot "youtube-oauth-token.json")
}

$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8

Write-Output "UPLOAD_HELPER_READY"
Write-Output "url=$Url"
Write-Output "production=$ProductionSlug"
Write-Output "channel=$YouTubeChannel ($($selectedChannel.title))"
Write-Output "channelToken=$(if ($channelTokenPresent) { 'present' } else { 'missing-connect-in-settings' })"
Write-Output "server=$serverAction"
Write-Output "browser=$browserAction"
Write-Output "handoff=$(if ($handoffPresent) { 'present' } else { 'prepare-only-pending' })"
Write-Output "oauth=existing-persistent-runtime"
Write-Output "state=$statePath"
