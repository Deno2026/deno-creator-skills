<#
.SYNOPSIS
  설치 확인. Premiere 없이 되는 오프라인 검사와, Premiere가 열려 있을 때의 연결 검사를 나눠 돌린다.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install\verify.ps1            # 오프라인 검사
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install\verify.ps1 -Live      # + Premiere 연결 검사(프로젝트를 열어 둔 상태)
#>
[CmdletBinding()]
param([switch]$Live)
$ErrorActionPreference = "Continue"
$kit = Split-Path -Parent $PSScriptRoot
Set-Location $kit
$results = @()
function Run($name, $command) {
    Write-Host "== $name" -ForegroundColor Cyan
    $out = & cmd /c "$command 2>&1"; $code = $LASTEXITCODE
    $status = if ($code -eq 0) { "PASS" } else { "FAIL($code)" }
    if ($code -ne 0) { $out | Select-Object -Last 15 | ForEach-Object { Write-Host "   $_" } }
    $script:results += "$status  $name"
}
Run "환경 점검(설치 파일·패널·경로)" "npm run -s premiere:mcp:env"
Run "런타임 경로·채널 설정" "npm run -s runtime-paths:self-test"
Run "Premiere 제어 오프라인 게이트" "npm run -s premiere:quality:self-test"
Run "요청 라우터" "node scripts/self-test-production-request-router.mjs"
Run "게시 도구·숏폼 게시" "npm run -s publishing-core:self-test"
Run "업로드 헬퍼 작업공간·타입" "npm run -s upload-helper:guard && npm run -s upload-helper:typecheck"
if (Test-Path ".venv\Scripts\python.exe") { Run "Whisper 백엔드 import" ".venv\Scripts\python.exe -c ""import faster_whisper, ctranslate2; print('faster-whisper ok')""" } else { $results += "SKIP  Whisper 가상환경 없음(.venv)" }
if (Test-Path ".venv-caption-qwen\Scripts\python.exe") { Run "Qwen ASR 백엔드 import" ".venv-caption-qwen\Scripts\python.exe -c ""import qwen_asr, torch; print('qwen-asr ok, cuda', torch.cuda.is_available())""" } else { $results += "SKIP  Qwen 가상환경 없음(.venv-caption-qwen)" }
if ($Live) {
    Run "Premiere 연결 스모크(읽기 전용)" "npm run -s premiere:mcp:smoke"
    Run "Premiere 생명주기 진단" "npm run -s premiere:lifecycle:doctor"
} else { $results += "SKIP  Premiere 연결 검사는 -Live 로(프로젝트를 열어 둔 상태)" }
Write-Host ""; Write-Host "== 결과 =="; $results | ForEach-Object { Write-Host "  $_" }
if ($results -match "^FAIL") { exit 1 }
