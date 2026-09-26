# Deno YouTube Upload Helper

exact master·final KO·게시 metadata를 사용자에게 보여주고, 사용자가 확정한 화면을 READY upload request로 고정하는 로컬 앱이다.

운영은 [문서 라우터](../../docs/agent/README.md)에서 시작한다. 제목·설명·챕터·오타/표기 변형 태그는 [게시 문구 정본](../../docs/agent/workflows/publishing-handoff.md#metadata-authoring), 저장한 READY 이후 작업은 [YouTube 실행](../../docs/agent/workflows/youtube-upload-execution.md)을 따른다.

## 실행

repo 루트에서 launcher를 실행한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\start_upload_helper.ps1" -ProductionSlug <slug>
```

launcher는 local server를 hidden process로 실행하고 `http://127.0.0.1:3000/`을 사용자의 Google Chrome 새 창으로 연다. 앱은 repo 밖 `<runtime root>`에서 OAuth settings, refresh token과 Helper preset을 읽는다.

## 화면 계약

- production source: `productions/<slug>/`
- final KO: `captions/final-ko.srt`
- master authority: `delivery/master-manifest.json`
- publisher handoff: `publishing/handoff.json`
- helper project pointer: `publishing/video-project.json`
- account/runtime state: `DENO_UPLOAD_HELPER_RUNTIME_ROOT`

metadata wrapper는 `schemaVersion/slug/authority/metadata/notes`와 제목 3안·설명 3안·챕터 3종·표기 변형 태그를 포함한다. Deno 채널의 선택 설명에는 Deno AI HUB, ComfyUI 추천, Discord, PC Spec 고정 블록을 포함한다. DENO PICTURES 채널은 이 블록들을 넣지 않는다.

에이전트는 추천 설명과 선택 챕터를 실제 입력란에 적용하고, Chrome에서 연결 채널·exact 파일·세부 옵션·본문을 read-back한다. playlist는 사용자의 현재 선택 또는 저장된 선택을 사용한다.

사용자가 `완료 · 업로드 시작`을 누르면 현재 화면의 영상·자막·metadata fingerprint와 hash가 최신 READY에 고정된다. 롱폼 READY는 `unlisted+KO → read-back → reviewed EN+전체 metadata localization` 순서를 승인한다. Shorts READY는 `private` 최초 업로드를 승인한다. 입력을 수정한 뒤에는 현재 화면으로 새 READY를 만든다.

`public` 전환, 수익창출 설정, 유료 프로모션 설정과 영상 삭제는 각각 사용자의 해당 요청과 실행 workflow를 따른다.

## 채널

화면 위 채널 선택(Deno / DENO PICTURES)이 연결 상태·프리셋·채널 정보·재생목록·설명 고정 블록의 기준이다. 채널 연결은 설정 화면의 채널별 `Google 승인 시작`이며, 받은 토큰의 채널 ID가 채널 목록과 다르면 저장하지 않는다. READY는 완료 시점의 채널을 `youtubeChannel`로 고정한다. 채널 목록은 `packages/runtime-paths`의 `UPLOAD_CHANNELS`, 실행 규칙은 [YouTube 실행 「업로드 채널」](../../docs/agent/workflows/youtube-upload-execution.md#업로드-채널-2026-09-24-디노--deno-pictures-추가).

## runtime

```powershell
$env:DENO_PRODUCTION_ROOT = '<kit folder>'
$env:DENO_UPLOAD_HELPER_RUNTIME_ROOT = '<runtime root>'
```

## 개발 검증

```powershell
npm --prefix .\apps\youtube-upload-helper install
npm --prefix .\apps\youtube-upload-helper run guard
npm --prefix .\apps\youtube-upload-helper run lint
npm --prefix .\apps\youtube-upload-helper run test:artifact-safety
npm --prefix .\apps\youtube-upload-helper run build:web
```

desktop package는 `desktop-bundle` allowlist와 `asar`를 사용한다. artifact safety 검사는 OAuth/token/secret, 사용자 SRT·영상·음향, 로컬 절대경로의 package 유입과 package size budget을 검사한다.
