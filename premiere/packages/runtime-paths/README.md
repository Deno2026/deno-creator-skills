# Runtime Paths

source repo와 계정·대용량 runtime 경로를 한 곳에서 해석한다.

| 환경변수 | 용도 |
| --- | --- |
| `DENO_PRODUCTION_ROOT` | `AGENTS.md`, `productions`, `packages`가 있는 monorepo root |
| `DENO_UPLOAD_HELPER_RUNTIME_ROOT` | OAuth, settings, READY request, staging media, 실행 기록을 저장하는 repo 밖 절대경로 |
| `DENO_MFA_RUNTIME_ROOT` | Korean MFA environment, model, work directory |
| `DENO_SOCIAL_PUBLISHING_RUNTIME_ROOT` | 숏폼 다중 게시 설정·Instagram OAuth·R2 설정·run·로그. 기본 `<social runtime root>` |

`DENO_PRODUCTION_ROOT`는 현재 작업경로에서 자동 탐색할 수 있다. Upload Helper runtime은 `<runtime root>`, MFA runtime은 설정값 또는 `%LOCALAPPDATA%\DENO\PremiereCaptionMFA`를 사용한다. MFA runtime root는 공백 없는 절대경로로 둔다.

production handoff는 다음 세 파일이 소유한다.

- `productions/<slug>/captions/final-ko.srt`
- `productions/<slug>/delivery/master-manifest.json`
- `productions/<slug>/publishing/handoff.json`

`master-manifest.json`은 exact master와 final KO hash·timeline·revision을 묶는다.

`getUploadRuntimePaths({ channel })`은 YouTube 채널별 경로를 준다. 채널 목록 `UPLOAD_CHANNELS`(id·제목·핸들·channel ID·설명 고정 블록 정책)와 `resolveUploadChannel()`도 이 패키지가 소유한다. 기본 채널 `denoise`는 기존 runtime 루트의 `youtube-oauth-token.json`·`upload-presets.json`·`channel-profile.json`을 그대로 쓰고, 다른 채널은 `channels/<id>/` 아래에 같은 이름으로 둔다. OAuth 앱 설정·READY·staging·실행 기록은 채널 공용이다.

`getSocialPublishingRuntimePaths()`는 `runtimeRoot`, `settingsPath`, `instagramSettingsPath`, `instagramTokenPath`, `threadsSettingsPath`, `threadsTokenPath`, `xSettingsPath`, `xTokenPath`, `r2SettingsPath`, `runsRoot`, `logsRoot`를 반환한다. YouTube 연결은 기존 `getUploadRuntimePaths()`를 함께 사용한다.
