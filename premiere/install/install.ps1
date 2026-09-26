<#
.SYNOPSIS
  Deno Creator Skills — 프리미어 후반 키트 설치(Windows). 이 폴더(premiere/)에서 실행한다.

.DESCRIPTION
  1) 준비물 점검(Node 22+, npm, Python 3.11+, ffmpeg/ffprobe, Premiere Pro, Creative Cloud 플러그인 설치기)
  2) Node 의존성 설치(키트 루트·업로드 헬퍼 앱·게시 패키지 둘)
  3) Python 가상환경 둘(.venv = Whisper 받아쓰기, .venv-caption-qwen = Qwen3 ASR/정렬 — 무겁다, -SkipQwen으로 건너뛸 수 있다)
  4) 런타임 폴더와 설정 파일 틀(local.config.json, channels.json)
  5) CEP 브리지 패널(-InstallCep) · UXP 플러그인 패키지(-PackageUxp)
  6) 다음에 사용자가 직접 할 일 안내

  이 스크립트는 레지스트리를 -InstallCep 때만(CEP PlayerDebugMode, 현재 사용자) 바꾸고, 그 밖의 시스템 설정은 건드리지 않는다.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install\install.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install\install.ps1 -InstallCep -PackageUxp
#>
[CmdletBinding()]
param(
    [switch]$SkipNode,
    [switch]$SkipWhisper,
    [switch]$SkipQwen,
    [switch]$InstallCep,
    [switch]$PackageUxp,
    [string]$RuntimeBase = (Join-Path $env:LOCALAPPDATA "DenoCreatorSkills")
)

$ErrorActionPreference = "Stop"
$kit = Split-Path -Parent $PSScriptRoot
Set-Location $kit
$report = [System.Collections.Generic.List[string]]::new()
function Say($text) { Write-Host $text }
function Ok($text) { $report.Add("OK   $text"); Write-Host "  [OK]   $text" -ForegroundColor Green }
function Warn($text) { $report.Add("WARN $text"); Write-Host "  [WARN] $text" -ForegroundColor Yellow }
function Fail($text) { $report.Add("FAIL $text"); Write-Host "  [FAIL] $text" -ForegroundColor Red }
function Have($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

Say "== 1) 준비물 점검 =="
$blocking = $false
if (Have node) {
    $nodeVersion = (& node -v).TrimStart("v")
    if ([version]$nodeVersion -ge [version]"22.0.0") { Ok "Node $nodeVersion" } else { Fail "Node 22 이상이 필요합니다(현재 $nodeVersion): https://nodejs.org"; $blocking = $true }
} else { Fail "Node가 없습니다: https://nodejs.org (LTS 22 이상)"; $blocking = $true }
if (Have npm) { Ok "npm $(& npm -v)" } else { Fail "npm이 없습니다(Node와 함께 설치됩니다)"; $blocking = $true }

$python = $null
foreach ($candidate in @(@("py", "-3.12"), @("py", "-3.11"), @("python", $null))) {
    $exe = $candidate[0]; $arg = $candidate[1]
    if (-not (Have $exe)) { continue }
    try {
        $v = if ($arg) { & $exe $arg -c "import sys;print('%d.%d.%d'%sys.version_info[:3])" 2>$null } else { & $exe -c "import sys;print('%d.%d.%d'%sys.version_info[:3])" 2>$null }
        if ($v -and ([version]$v -ge [version]"3.11.0")) { $python = @{ exe = $exe; arg = $arg; version = $v }; break }
    } catch {}
}
if ($python) { Ok "Python $($python.version) ($($python.exe) $($python.arg))" } else { Warn "Python 3.11 이상이 없습니다 — 받아쓰기·문장 단위 컷은 못 씁니다: https://www.python.org/downloads/windows/ (설치 때 'Add python.exe to PATH' 체크)" }

foreach ($tool in @("ffmpeg", "ffprobe")) { if (Have $tool) { Ok "$tool" } else { Fail "$tool 이(가) PATH에 없습니다: https://www.gyan.dev/ffmpeg/builds/ (release-full) 압축을 풀고 bin 폴더를 PATH에 추가"; $blocking = $true } }

$adobe = "C:\Program Files\Adobe"
$premiere = if (Test-Path $adobe) { Get-ChildItem $adobe -Directory | Where-Object { $_.Name -like "Adobe Premiere Pro*" } | Sort-Object Name -Descending | Select-Object -First 1 } else { $null }
if ($premiere) { Ok "Premiere Pro: $($premiere.FullName) (26.3 이상 권장)" } else { Warn "Premiere Pro 설치 폴더를 못 찾았습니다($adobe). 다른 위치면 환경변수 PREMIERE_APP_ROOT로 알려 주세요." }
$upia = "C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
if (Test-Path $upia) { Ok "Creative Cloud 플러그인 설치기(UXP 설치에 필요)" } else { Warn "Creative Cloud 플러그인 설치기가 없습니다 — UXP 플러그인(.ccx) 설치는 Creative Cloud 데스크톱 앱이 필요합니다." }
if (Have nvidia-smi) { Ok "NVIDIA GPU 드라이버(Whisper·Qwen CUDA 가속)" } else { Warn "nvidia-smi가 없습니다 — 받아쓰기는 CPU로도 되지만 느립니다." }
if ($blocking) { Say ""; Say "필수 도구가 빠져 있어 여기서 멈춥니다. 위 [FAIL] 항목을 설치한 뒤 다시 실행하세요."; exit 1 }

if (-not $SkipNode) {
    Say ""; Say "== 2) Node 의존성 =="
    & npm install --no-audit --no-fund --loglevel=error; if ($LASTEXITCODE -ne 0) { throw "npm install(루트) 실패" }; Ok "키트 루트"
    & npm --prefix apps/youtube-upload-helper install --no-audit --no-fund --loglevel=error; if ($LASTEXITCODE -ne 0) { throw "npm install(업로드 헬퍼) 실패" }; Ok "업로드 헬퍼 앱"
    & npm --prefix packages/publishing-core install --no-audit --no-fund --loglevel=error; if ($LASTEXITCODE -ne 0) { throw "npm install(publishing-core) 실패" }; Ok "publishing-core"
    & npm --prefix packages/social-publishing install --no-audit --no-fund --loglevel=error; if ($LASTEXITCODE -ne 0) { throw "npm install(social-publishing) 실패" }; Ok "social-publishing"
}

function New-Venv($dir, $requirements, $label) {
    if (-not $python) { Warn "$label — Python이 없어 건너뜀"; return }
    $py = Join-Path $dir "Scripts\python.exe"
    if (-not (Test-Path $py)) {
        if ($python.arg) { & $python.exe $python.arg -m venv $dir } else { & $python.exe -m venv $dir }
        if ($LASTEXITCODE -ne 0) { throw "가상환경 생성 실패: $dir" }
    }
    & $py -m pip install --upgrade pip --quiet
    & $py -m pip install --quiet -r $requirements
    if ($LASTEXITCODE -ne 0) { throw "pip install 실패: $requirements" }
    Ok "$label ($dir)"
}
Say ""; Say "== 3) Python 가상환경 =="
if ($SkipWhisper) { Warn "Whisper 가상환경 건너뜀(-SkipWhisper)" } else { New-Venv (Join-Path $kit ".venv") (Join-Path $kit "scripts\requirements-premiere-transcription.txt") "Whisper large-v3 받아쓰기(.venv)" }
if ($SkipQwen) { Warn "Qwen 가상환경 건너뜀(-SkipQwen) — 통파일 문장 단위 컷(premiere:editorial)은 이 환경이 필요합니다" } else { New-Venv (Join-Path $kit ".venv-caption-qwen") (Join-Path $kit "scripts\requirements-caption-qwen.txt") "Qwen3 ASR·정렬(.venv-caption-qwen, torch 포함 — 수 GB)" }

Say ""; Say "== 4) 런타임 폴더와 설정 틀 =="
$uploadRuntime = Join-Path $RuntimeBase "youtube-upload-helper"
$socialRuntime = Join-Path $RuntimeBase "social-publishing"
New-Item -ItemType Directory -Force $uploadRuntime | Out-Null
New-Item -ItemType Directory -Force $socialRuntime | Out-Null
$localConfig = Join-Path $kit "local.config.json"
if (-not (Test-Path $localConfig)) {
    @{ uploadRuntimeRoot = $uploadRuntime; socialRuntimeRoot = $socialRuntime; creativeUpstreamRoot = ""; thumbnailWorkspaceRoot = "" } | ConvertTo-Json | Set-Content -LiteralPath $localConfig -Encoding UTF8
    Ok "local.config.json 생성($localConfig)"
} else { Ok "local.config.json 있음(그대로 둠)" }
$channels = Join-Path $uploadRuntime "channels.json"
if (-not (Test-Path $channels)) {
    Copy-Item (Join-Path $kit "packages\runtime-paths\templates\channels.example.json") $channels
    Ok "channels.json 틀 복사($channels) — 채널 ID·핸들·설명 블록을 채우세요"
} else { Ok "channels.json 있음(그대로 둠)" }
foreach ($template in Get-ChildItem (Join-Path $kit "packages\social-publishing\templates") -Filter "*.example.json") {
    $target = Join-Path $socialRuntime ($template.Name -replace "\.example\.json$", ".json")
    if ($template.Name -eq "publish.example.json") { continue }
    if (-not (Test-Path $target)) { Copy-Item $template.FullName $target }
}
Ok "숏폼 게시 설정 틀($socialRuntime) — 쓸 플랫폼의 값만 채우면 됩니다"

Say ""; Say "== 5) Premiere 연결 =="
if ($InstallCep) { & (Join-Path $PSScriptRoot "install-cep-panel.ps1"); if ($LASTEXITCODE -ne 0) { throw "CEP 패널 설치 실패" }; Ok "CEP 브리지 패널 설치(MCPBridgeCEP) — Premiere를 껐다 켜고 창 > 확장 > MCP Bridge를 한 번 연다" } else { Warn "CEP 브리지 패널은 -InstallCep로 설치합니다(리미터 수치 등 UXP가 못 쓰는 값에 필요)" }
if ($PackageUxp) {
    & npm run -s premiere:uxp:package; if ($LASTEXITCODE -ne 0) { throw "UXP 패키지 생성 실패" }
    $ccx = Get-ChildItem (Join-Path $kit "dist\premiere-uxp") -Filter "*.ccx" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    Ok "UXP 플러그인 패키지: $($ccx.FullName) — Premiere를 닫고 `scripts\install-premiere-uxp-package.ps1 -Install`로 설치(Creative Cloud 설치기가 확인 창을 띄웁니다)"
} else { Warn "UXP 플러그인은 -PackageUxp로 패키지를 만든 뒤 scripts\install-premiere-uxp-package.ps1 -Install 로 설치합니다" }

Say ""; Say "== 6) 사용자가 직접 할 일 =="
Say "  1. Premiere를 열고 아무 프로젝트나 연 뒤 이 폴더에서  npm run premiere:mcp:env  →  npm run premiere:mcp:smoke  로 연결을 확인합니다."
Say "  2. YouTube 업로드: Google Cloud 콘솔에서 프로젝트를 만들고 YouTube Data API v3를 켠 뒤 OAuth 클라이언트(데스크톱/웹, 리디렉션 http://localhost:3000/api/oauth/callback)를 만들어"
Say "     헬퍼 화면의 /settings 에 클라이언트 ID·시크릿을 붙여 넣고 채널마다 'Google 승인 시작'을 누릅니다(README 「유튜브 연결」)."
Say "  3. $channels 에 내 채널(ID·핸들)과 설명에 항상 붙일 블록(원하면)을 적습니다."
Say "  4. 에이전트를 이 폴더에서 열고 AGENTS.md를 읽게 합니다."
Say ""; Say "== 요약 =="; $report | ForEach-Object { Say "  $_" }
