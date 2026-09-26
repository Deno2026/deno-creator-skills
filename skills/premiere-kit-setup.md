---
slug: premiere-kit-setup
title: 프리미어 후반 키트 설치 — 내 PC에 에이전트용 Premiere 도구 한 벌을 스스로 세우는 순서와 사용자가 직접 할 일
kind: technique
tags: 프리미어, premiere, 설치, 셋업, 키트, uxp, cep, mcp, node, python, ffmpeg, whisper, qwen, oauth, 유튜브 api, google cloud, 업로드 헬퍼, deno creator skills
models: Whisper large-v3, Qwen3-ASR
execution: local
version: 1
summary: 공개 키트 deno-creator-skills/premiere를 내 PC에 설치해 에이전트가 Premiere Pro를 조종하고 유튜브에 올리게 하는 순서. 준비물(Windows·Premiere 26.3+·Creative Cloud·Node 22·Python 3.11·ffmpeg·GPU 권장), 설치 스크립트가 하는 일과 하지 않는 일, 사용자가 직접 해야 하는 일(Google Cloud OAuth 클라이언트·채널 설정·플러그인 설치 승인), 확인 방법, 설정 파일 셋, 자주 막히는 곳.
---

# 프리미어 후반 키트 설치

에이전트가 Premiere Pro를 조종하고 유튜브에 올리려면 **플러그인·서버·도구·설정**이 내 PC에 있어야 한다. 키트 `deno-creator-skills/premiere`의 `install/install.ps1`이 대부분을 하고, 몇 가지는 사용자가 직접 한다. 에이전트에게 "키트 설치해 줘"라고 하면 이 순서로 안내·실행한다.

## 준비물

| 항목 | 요구 | 왜 |
| --- | --- | --- |
| Windows 10/11 | | 경로·레지스트리·PowerShell 기준 |
| Adobe Premiere Pro 26.3 이상 + Media Encoder | Creative Cloud 데스크톱 앱 포함 | UXP 플러그인, 4K 프리셋, 플러그인 설치기 |
| Node.js 22 이상 | | 도구·서버·업로드 헬퍼 |
| Python 3.11 이상 | 없어도 나머지는 됨 | Whisper 받아쓰기, Qwen3 문장 단위 컷 |
| ffmpeg / ffprobe | PATH | 오디오 측정·파생 클립·프리뷰 합성 |
| NVIDIA GPU | 권장 | 받아쓰기·정렬 가속(없으면 CPU, 느림) |
| Google 계정 + Google Cloud 프로젝트 | 업로드에 필요 | YouTube Data API v3 OAuth |
| Chrome | | 헬퍼 화면, Studio 확인 |

## 진행 순서

1. **키트 받기.** 저장소를 받아 `premiere/` 폴더로 간다.
2. **설치 스크립트.** `powershell -NoProfile -ExecutionPolicy Bypass -File .\install\install.ps1` — 준비물 점검 → Node 의존성(루트·헬퍼 앱·게시 패키지 둘) → Python 가상환경 둘(`.venv` Whisper, `.venv-caption-qwen` Qwen3 — torch 포함 수 GB, `-SkipQwen`으로 미룰 수 있다) → 런타임 폴더(`%LOCALAPPDATA%\DenoCreatorSkills\…`)와 설정 틀(`local.config.json`, `channels.json`) 생성. 시스템 설정은 바꾸지 않는다.
3. **Premiere 연결(플래그).** `-InstallCep`: CEP 브리지 패널을 사용자 CEP 확장 폴더에 복사하고 서명 없는 패널 허용(PlayerDebugMode, 현재 사용자)을 켠다 — 되돌리기 스크립트 있음. `-PackageUxp`: UXP 플러그인을 `.ccx`로 묶는다. 설치는 Premiere를 닫고 `scripts\install-premiere-uxp-package.ps1 -Install` — Creative Cloud 설치기가 확인 창을 띄우고 **사용자가 누른다**. 그 뒤 Premiere를 켜고 창 > 확장 > MCP Bridge를 한 번 연다.
4. **확인.** Premiere에 아무 프로젝트나 열어 두고 `install\verify.ps1 -Live` — 환경 점검·경로·오프라인 게이트·라우터·게시 도구·헬퍼 타입·가상환경 import·Premiere 읽기 전용 스모크를 표로 낸다.
5. **채널 설정.** 런타임의 `channels.json`에 내 채널(id·이름·핸들·채널 ID)과 설명에 항상 붙일 블록(원하면)을 적는다. 비워 두면 아무 링크도 붙지 않는다. 채널이 둘 이상이면 `defaultChannel`을 정하고 다른 채널은 별칭을 둔다.
6. **유튜브 연결(사용자 직접).** Google Cloud 콘솔에서 프로젝트 → YouTube Data API v3 사용 설정 → OAuth 동의 화면(테스트 모드면 내 계정을 테스트 사용자로) → OAuth 클라이언트 ID(웹, 리디렉션 `http://localhost:3000/api/oauth/callback`). 헬퍼를 띄워(`tools\start_upload_helper.ps1 -ProductionSlug <slug> -PrepareOnly`) `/settings`에 클라이언트 ID·시크릿을 넣고 채널마다 `Google 승인 시작` — 계정 선택·허용은 사용자가 누른다. 토큰의 채널 ID가 `channels.json`과 다르면 저장되지 않는다.
7. **에이전트 열기.** 키트 폴더에서 에이전트를 열면 `AGENTS.md`를 읽고 시작한다.

## 갈림길

- Python이 없다 → 받아쓰기·문장 단위 컷만 못 쓴다. 나머지(오디오·자막 반영·업로드)는 된다.
- GPU가 없다 → Whisper·Qwen은 CPU로(수 배 느림). Qwen 환경은 `-SkipQwen`으로 미루고 필요할 때 설치.
- Premiere가 다른 드라이브에 있다 → 환경변수 `PREMIERE_APP_ROOT`.
- 런타임 폴더를 다른 곳에 두고 싶다 → `local.config.json`의 `uploadRuntimeRoot`·`socialRuntimeRoot`(환경변수가 있으면 그것이 우선).

## 설정 파일 셋

| 파일 | 어디 | 무엇 |
| --- | --- | --- |
| `local.config.json` | 키트 폴더(추적 안 함) | 이 PC의 런타임 폴더, 창작 상류 리포, 썸네일 작업공간 경로 |
| `channels.json` | 업로드 런타임 폴더 | 채널 목록·기본 채널·채널별 업로드 기본값·설명 고정 블록 |
| `youtube-settings.json` | 업로드 런타임 폴더 | Google OAuth 클라이언트(헬퍼 `/settings`에서 저장) |

## 자주 막히는 곳

- 환경 점검이 패널 미설치·Node 플래그 누락을 말한다 → `-InstallCep`를 다시, Premiere 재시작.
- 브리지가 침묵한다 → Premiere에서 MCP Bridge 패널을 한 번 열어 둔다(패널이 명령 파일을 감시한다).
- UXP 플러그인이 안 보인다 → Creative Cloud 앱 > 플러그인에서 상태 확인, Premiere 완전 종료 후 `.ccx` 재설치.
- `channels.json` 오류로 멈춘다 → 오류 문구가 어느 채널의 어느 칸인지 말한다.
- 상시 MCP 서버를 등록해 두면 Premiere 종료·재시작과 엉킨다 → 키트는 필요할 때만 CLI로 부르는 방식이 기본이다.

## 디노는 이렇게 한다 — 예시

- 메인 PC(RTX PRO 6000 96GB)에서 Whisper·Qwen 모두 GPU. 통파일 35분의 문장 단위 컷 계획은 몇 분 안에 나온다.
- 채널은 둘(강의·드라마)이고 같은 OAuth 앱을 쓴다. 드라마 채널에는 강의용 설명 블록을 넣지 않는다.
- 할당량은 하루 110,000 units로 늘려 받았다(승인은 기한이 있어 재신청). 기본 10,000으로도 롱폼 한 편의 업로드·자막 둘·현지화는 들어간다.

## 포함되지 않은 것

- macOS, 다른 NLE, Premiere 26.3 미만, 회사 규모에 따른 Remotion 라이선스 판단, Google 앱 검증(테스트 모드로 시작하면 된다).

## 바뀐 점

- v1 (2026-09-27): 첫 판. 키트 첫 내보내기와 처음 설치 시뮬레이션(오프라인 검사 전부·프리미어 읽기 전용 스모크 통과) 기준.
