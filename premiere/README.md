# 프리미어 프로 후반 키트 (Deno Creator Skills)

컷편집이 끝난 Premiere Pro 시퀀스를 에이전트(Claude Code·Codex 등)가 이어받아 **오디오 정돈 → 자막 교정 → 모션 오버레이 → 4K 마스터 → 유튜브 업로드 → 자막·82개 언어 현지화 → 숏폼 예약 게시**까지 해 주는 도구와 절차 묶음이다. 통파일을 주면 무음 컷과 문장 단위 다듬기부터 한다.

이 키트는 **장비와 절차**만 준다. 어떻게 연출할지(색·서체·리듬)는 사용자가 에이전트와 대화하며 정하고, 정한 것은 `docs/agent/workflows/channel-motion-profile.md`에 쌓인다. 채널 정보·링크·경로 같은 개인 값은 전부 설정 파일에 있고 코드에는 없다.

## 무엇이 들어 있나

| 폴더 | 무엇 |
| --- | --- |
| `AGENTS.md`, `docs/agent/` | 에이전트가 읽는 정본과 작업별 절차(오디오·자막·모션·게시·업로드·숏폼·긴 원본·썸네일) |
| `servers/`, `extensions/deno-premiere-uxp/`, `vendor/` | Premiere를 조종하는 UXP 플러그인 + MCP 서버 둘 + CEP 브리지 패키지(MIT `premiere-pro-mcp` 1.1.1 패치본, [무엇을 고쳤나](vendor/PATCHES.md)) |
| `scripts/` | 컷·오디오·자막·오버레이·마스터·검사 도구(`package.json` scripts로 부른다) |
| `packages/` | 자막 도구(`caption-core`), YouTube 게시(`publishing-core`), 숏폼 4플랫폼 게시(`social-publishing`), 경로·채널 설정(`runtime-paths`), 스키마(`production-contract`) |
| `apps/youtube-upload-helper/` | 업로드 헬퍼 — 제목·설명·챕터를 확정하고 업로드를 승인하는 로컬 웹 화면 |
| `src/`, `remotion.config.ts` | Remotion 오버레이 런타임(알파 ProRes 4444) |
| `install/` | 설치·확인 스크립트 |
| `docs/premiere/` | 브리지 프로토콜·도구 표·capability 명세 |

## 준비물

| 항목 | 요구 | 비고 |
| --- | --- | --- |
| Windows 10/11 | | 경로·레지스트리·PowerShell 기준으로 만들어졌다 |
| Adobe Premiere Pro | 26.3 이상(2026) + Media Encoder | UXP 플러그인·`YouTube 2160p 4K.epr` 프리셋 |
| Creative Cloud 데스크톱 앱 | | UXP 플러그인(.ccx) 설치기 |
| Node.js | 22 이상 | https://nodejs.org |
| Python | 3.11 이상 | 받아쓰기(Whisper)·문장 단위 컷(Qwen3) — 없어도 나머지는 된다 |
| ffmpeg / ffprobe | PATH | https://www.gyan.dev/ffmpeg/builds/ |
| NVIDIA GPU | 권장 | Whisper·Qwen CUDA 가속. 없으면 CPU(느림) |
| Google 계정 + Google Cloud 프로젝트 | 업로드에 필요 | YouTube Data API v3 OAuth 클라이언트(아래 「유튜브 연결」) |
| Chrome | | 업로드 헬퍼 화면, YouTube Studio 확인 |

## 설치

이 폴더(`premiere/`)에서:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install\install.ps1
```

준비물을 점검하고 Node 의존성, Python 가상환경 둘(`.venv` Whisper, `.venv-caption-qwen` Qwen3 — torch 포함 수 GB, `-SkipQwen`으로 미룰 수 있다), 런타임 폴더(`%LOCALAPPDATA%\DenoCreatorSkills\…`)와 설정 틀(`local.config.json`, `channels.json`)을 만든다. 시스템 설정은 바꾸지 않는다.

Premiere 연결 두 가지는 플래그로 켠다(각각 무엇을 하는지 스크립트 머리에 적혀 있다):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install\install.ps1 -InstallCep -PackageUxp
```

- `-InstallCep`: CEP 브리지 패널을 `%APPDATA%\Adobe\CEP\extensions\MCPBridgeCEP`에 복사하고 현재 사용자의 `PlayerDebugMode`(서명 없는 패널 허용, CSXS 9~14)를 켠다. 되돌리기는 `install\install-cep-panel.ps1 -Uninstall`.
- `-PackageUxp`: UXP 플러그인을 `.ccx`로 묶는다. 설치는 Premiere를 닫고 `scripts\install-premiere-uxp-package.ps1 -Install` — Creative Cloud 설치기가 확인 창을 띄운다(사용자가 누른다).

설치가 끝나면 Premiere를 켜고 아무 프로젝트나 연 뒤:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install\verify.ps1 -Live
```

오프라인 검사(환경 점검·경로·오프라인 게이트·라우터·게시 도구·헬퍼 타입)와 Premiere 연결 스모크(읽기 전용)를 돌리고 결과 표를 낸다.

## 설정 파일 셋

| 파일 | 어디 | 무엇 |
| --- | --- | --- |
| `local.config.json` | 이 폴더(추적 안 함) | 이 PC의 런타임 폴더 둘, 창작 상류 리포(`creativeUpstreamRoot`), 썸네일 작업공간. 환경변수 `DENO_UPLOAD_HELPER_RUNTIME_ROOT`·`DENO_SOCIAL_PUBLISHING_RUNTIME_ROOT`가 있으면 그것이 우선 |
| `channels.json` | 업로드 런타임 폴더 | 유튜브 채널 목록(id·이름·핸들·채널 ID·별칭), 기본 채널, 채널별 업로드 기본값(설명 틀·태그·카테고리), 설명에 항상 붙일 블록(추천 링크·커뮤니티 링크·허브·PC 사양). 틀: `packages/runtime-paths/templates/channels.example.json`. 비워 두면 아무 링크도 붙지 않는다 |
| `youtube-settings.json` | 업로드 런타임 폴더 | Google OAuth 클라이언트. 헬퍼 화면 `/settings`에서 입력하면 저장된다 |

파일을 고치면 헬퍼 서버와 도구를 다시 시작한다(적재 때 한 번 읽는다).

### 유튜브 연결(사용자가 직접)

1. Google Cloud 콘솔에서 프로젝트를 만들고 **YouTube Data API v3**를 사용 설정한다.
2. OAuth 동의 화면을 만들고(외부·테스트 모드면 내 계정을 테스트 사용자로 추가), OAuth 클라이언트 ID(웹 애플리케이션)를 만든다. 승인된 리디렉션 URI: `http://localhost:3000/api/oauth/callback`.
3. 헬퍼를 띄우고(`tools\start_upload_helper.ps1 -ProductionSlug <slug> -PrepareOnly`) `/settings`에 클라이언트 ID·시크릿을 붙여 넣는다. 채널마다 `Google 승인 시작`을 눌러 연결한다 — 계정 선택·허용은 사용자가 누른다. 받은 토큰의 채널 ID가 `channels.json`과 다르면 저장되지 않는다.
4. 새 프로젝트의 기본 할당량은 하루 10,000 units다(롱폼 한 편 + 자막 둘 + 현지화는 들어간다). 더 필요하면 Google 할당량 증가 신청.

## 쓰는 법

에이전트를 이 폴더에서 열고 `AGENTS.md`를 읽게 한다(Claude Code·Codex는 자동으로 읽는다). 그다음은 평소 말로:

| 말 | 에이전트가 하는 일 |
| --- | --- |
| "이 통파일 컷편집해 줘" | 무음 컷 + 문장 단위 다듬기(반복·재시작·실패 테이크)를 복제 시퀀스에 한 번에 |
| "오디오 맞춰 줘" | 구간별 음량을 맞추고 순간 피크만 리미터로, 실제 출력 오디오로 검증 |
| "자막 만들어 줘" + Premiere에서 내보낸 SRT | 타임코드 고정 교정본 → 문맥 병합본(최대 2줄) → 캡션 트랙 반영 |
| "모션 넣어 줘" | 블록별 연출 메모 → Remotion 렌더 → 알파 배치. 연출은 채널 기준 문서를 따르고 없으면 2~3안 비교 |
| "렌더해 줘" | 4K 마스터 렌더와 파일 확인, `delivery/master-manifest.json` 고정 |
| "업로드 준비해 줘" | 제목 3안·설명 3안·챕터 3종을 헬퍼에 채운다. 사용자가 `완료 · 업로드 시작`을 누르면 unlisted 업로드 + 한국어 자막 → 영어 자막 → 전체 언어 현지화 |
| "숏츠 예약 게시" | `publish.json` 검수·preflight → 사용자 승인 → YouTube·Instagram(·Threads·X) 같은 시각 예약 |

공개(`public`) 전환, 결제, 로그인, 삭제는 항상 사용자가 한다.

## 도구 한 장

`npm run <이름>`으로 부른다. 전체 목록은 `package.json` scripts.

| 갈래 | 이름 |
| --- | --- |
| 연결 점검 | `premiere:mcp:env`, `premiere:mcp:smoke`, `premiere:lifecycle:doctor`, `premiere:uxp:call`, `premiere:mcp:call` |
| 컷 | `premiere:duplicate-sequence`, `premiere:capture-direct-cut-inputs`, `premiere:propose-waveform-only-cuts`, `premiere:editorial`(Qwen 문장 단위), `premiere:build-direct-cut-manifest`, `premiere:apply-direct-razor-cuts`, `premiere:apply-lift-compact`, `premiere:repair-av-links` |
| 오디오 | `premiere:export-audio-map`, `premiere:propose-audio-balance`, `premiere:apply-audio-balance`, `premiere:export-audio-check`, `premiere:verify-program-loudness` |
| 자막 | `premiere:transcribe-timeline`(Whisper large-v3), `premiere:validate-srt`, `premiere:apply-caption-track`, `premiere:align-captions-to-waveform`, `caption-core:self-test` |
| 긴 원본 | `premiere:render-active-clips`, `premiere:import-active-clips` |
| 모션 | `studio`, `render`, `production:new`, `production:render-overlays`, `production:build-overlay-placement`, `premiere:place-overlays`, `overlay:build-review-sheet` |
| 마스터·게시 | `production:build-delivery`, `production:build-publishing-handoff`, `tools\start_upload_helper.ps1`, `packages/publishing-core/tools/*.cjs`(업로드·현지화·공개·썸네일) |
| 숏폼 | `social:publish`, `social:instagram:connect` |
| 검사 | `install\verify.ps1`, `premiere:quality:self-test`, `unified:offline:self-test -- --scope all` |

## 문제 해결

- `premiere:mcp:env`가 FAIL: 항목 이름이 무엇이 없는지 말한다(패널 미설치·Node 플래그·패치 파일). `-InstallCep`를 다시 돌리거나 Premiere를 재시작한다.
- 브리지가 응답하지 않음: Premiere에서 창 > 확장 > MCP Bridge를 한 번 열어 둔다(패널이 명령 파일을 감시한다). 임시 폴더는 `%LOCALAPPDATA%\Temp\premiere-mcp-bridge`(`PREMIERE_TEMP_DIR`로 바꿀 수 있다).
- UXP 플러그인이 목록에 없음: Creative Cloud 앱 > 플러그인에서 설치 상태를 본다. Premiere를 완전히 닫은 뒤 `.ccx`를 다시 설치한다.
- 헬퍼가 `channels.json` 오류로 멈춤: 오류 문구가 어느 채널의 어느 칸인지 말한다(`PUBLISHING_PROFILE_INVALID: …`).
- 받아쓰기가 CPU로 돌아 느림: `nvidia-smi`와 `.venv\Scripts\python.exe -c "import ctranslate2; print(ctranslate2.get_cuda_device_count())"`로 CUDA를 확인한다.

## 갱신

이 폴더는 원본(제작자의 작업 리포)에서 내보낸 산출물이다. `MANIFEST.json`에 원본 커밋과 파일 해시가 있다. 새 판을 받으면 `install\install.ps1`(의존성 갱신)과 `verify.ps1`를 다시 돌린다. 설정 파일(`local.config.json`, 런타임 폴더)은 그대로 쓴다.

## 라이선스

코드는 GPL-3.0-only(저장소 루트 `LICENSE`). `vendor/premiere-pro-mcp`는 MIT(원 라이선스 동봉). Remotion은 회사 규모에 따라 별도 라이선스가 필요할 수 있다(remotion.dev/license). Adobe Fonts·Google Fonts 사용 조건은 [서체 문서](docs/agent/workflows/motion-typography.md).
