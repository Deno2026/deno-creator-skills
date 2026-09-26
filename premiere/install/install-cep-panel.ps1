<#
.SYNOPSIS
  CEP 브리지 패널(MCPBridgeCEP)을 현재 사용자의 Premiere CEP 확장 폴더에 복사하고, 서명 없는 패널을 허용하는 PlayerDebugMode를 켠다.

.DESCRIPTION
  원본: vendor\premiere-pro-mcp\cep-plugin (MIT 패키지 premiere-pro-mcp 1.1.1에 이 키트의 패치를 더한 사본).
  복사 위치: %APPDATA%\Adobe\CEP\extensions\MCPBridgeCEP
  레지스트리: HKCU:\Software\Adobe\CSXS.9 ~ CSXS.14 의 PlayerDebugMode = "1" (현재 사용자만, Adobe CEP 개발 패널의 표준 절차)
  되돌리기: 폴더를 지우고 위 키의 PlayerDebugMode 값을 삭제한다.
#>
[CmdletBinding()]
param([switch]$Uninstall)
$ErrorActionPreference = "Stop"
$kit = Split-Path -Parent $PSScriptRoot
$source = Join-Path $kit "vendor\premiere-pro-mcp\cep-plugin"
$target = Join-Path $env:APPDATA "Adobe\CEP\extensions\MCPBridgeCEP"

if ($Uninstall) {
    if (Test-Path $target) { Remove-Item -Recurse -Force $target; Write-Host "removed $target" }
    foreach ($v in 9..14) { $key = "HKCU:\Software\Adobe\CSXS.$v"; if (Test-Path $key) { Remove-ItemProperty -Path $key -Name PlayerDebugMode -ErrorAction SilentlyContinue } }
    Write-Host "PlayerDebugMode removed (CSXS.9-14)"; exit 0
}

if (-not (Test-Path (Join-Path $source "CSXS\manifest.xml"))) { throw "CEP 패널 원본이 없습니다: $source" }
New-Item -ItemType Directory -Force (Split-Path -Parent $target) | Out-Null
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
Copy-Item -Recurse $source $target
foreach ($v in 9..14) {
    $key = "HKCU:\Software\Adobe\CSXS.$v"
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    New-ItemProperty -Path $key -Name PlayerDebugMode -Value "1" -PropertyType String -Force | Out-Null
}
$manifest = Get-Content (Join-Path $target "CSXS\manifest.xml") -Raw
$flags = @("--enable-nodejs", "--mixed-context") | Where-Object { $manifest -notmatch [regex]::Escape($_) }
if ($flags) { throw "설치된 manifest에 Node 플래그가 없습니다: $($flags -join ', ')" }
Write-Host "installed: $target"
Write-Host "PlayerDebugMode=1 (HKCU CSXS.9-14). Premiere를 다시 시작한 뒤 창 > 확장(Extensions) > MCP Bridge 를 한 번 엽니다."
