# Social publishing

완성된 세로 숏폼과 `publish.json` 하나로 YouTube Shorts·Instagram Reels·Threads·X의 같은 시각 예약을 준비하고 실행한다. 기본 대상은 YouTube와 Instagram이다. TikTok 브라우저 전달은 명시적으로 선택했을 때만 유지한다. DenoVerse는 이 패키지의 CLI를 호출하며 게시 구현은 이 저장소가 소유한다.

현재 상태: 로컬 구현과 오프라인 검증 완료. Instagram 실전 결과는 [backlog 검증 기록](../../docs/agent/backlog/social-publishing-implementation.md)에 있다. Threads·X 실제 게시는 아직 검증하지 않았다. 브라우저 실행법은 [에이전트 workflow](../../docs/agent/workflows/social-publishing.md)가 소유한다.

## 설치와 runtime

Node.js 22 이상, PATH의 `ffmpeg`·`ffprobe`, Windows PowerShell 5.1 및 작업 스케줄러를 사용한다. 의존성은 패키지 로컬에 설치한다.

```powershell
Set-Location '<kit folder>'
npm --prefix packages/publishing-core ci --ignore-scripts
npm --prefix packages/social-publishing ci --ignore-scripts
```

`@aws-sdk/client-s3`·`@aws-sdk/s3-request-presigner`·`twitter-text`는 lockfile에 고정한다. `twitter-text`는 X의 한글·이모지·URL 가중 글자 수를 계산한다. 설치 스크립트와 전역 설치를 사용하지 않는다. 제거 시 `packages/social-publishing/node_modules`만 제거하면 된다. 외부 runtime은 별도로 보존한다. 현재 공식 `twitter-text@3.1.0`은 사용 중단된 core-js 2를 간접 의존하며 Node에서 punycode 사용 중단 경고를 stderr에 출력할 수 있다. 패키지 범위에만 설치하고 lockfile로 고정했다. 이 경고 자체는 게시 실패가 아니다.

| 환경변수 | 기본·용도 |
|---|---|
| `DENO_SOCIAL_PUBLISHING_RUNTIME_ROOT` | `<social runtime root>`; 설정·토큰·run·로그 |
| `DENO_UPLOAD_HELPER_RUNTIME_ROOT` | 기존 YouTube runtime. social CLI 기본 `<runtime root>` |
| `DENO_PRODUCTION_ROOT` | 자식 프로세스·예약 실행에서 이 저장소 절대경로로 설정 |

경로 해석은 `@deno/runtime-paths.getSocialPublishingRuntimePaths()`가 소유한다. YouTube는 기존 OAuth 연결과 `channels.json` 기본 채널을 사용한다.

```text
social-publishing/
  social-settings.json
  instagram-settings.json
  instagram-oauth-token.json
  threads-settings.json, threads-oauth-token.json
  x-settings.json, x-oauth-token.json
  r2-settings.json
  runs/pub-<source-sha256-first-16>/
    publish.json, publish_run.json, RUN.lock, publish_result.json
    youtube/metadata.json, link.json, studio_check.json
    instagram/scheduled-task.json, instagram-scheduled.cmd, result.json
    threads/scheduled-task.json, threads-scheduled.cmd, result.json
    x/scheduled-task.json, x-scheduled.cmd, result.json
    tiktok/handoff.json, result.json, evidence-<sha256>.png
    logs/instagram-scheduled.log
  logs/
```

설정 템플릿은 [templates](templates)에 있다. 비밀은 사용자가 runtime 파일에 직접 넣는다. 토큰·앱 시크릿·R2 키·서명 URL은 stdout·로그·run에 기록하지 않는다. 작업 기록에는 자격 증명이 아닌 파일 해시·플랫폼 ID·단계·오류 코드만 남긴다.

Instagram Graph API 기본 버전은 `v26.0`이다. 2026-09-07에 [Meta 공식 SDK changelog](https://github.com/facebook/facebook-ios-sdk/blob/main/CHANGELOG.md)의 v26.0 기본값을 확인했다. Meta 개발자 문서 직접 조회는 429 응답이었으며, Login 권한·게시 경로는 [Meta 공식 API 컬렉션](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api)과 구현 지시서의 계약을 함께 사용했다. 실제 앱 연결 가능 여부는 인증·게시 검증으로 확인한다.

## publish.json

[publish.example.json](templates/publish.example.json)을 복사하여 영상 경로·예약 시각·플랫폼 문구를 완성한다. 예시의 미래 시각과 검수 해시 표시는 실제 값으로 바꿔야 한다.

| 입력 | 검증 |
|---|---|
| `schemaVersion`, `slug` | 버전 1, 비어 있지 않은 식별용 이름. 한글 가능 |
| `video.path`, `video.sha256` | 존재하는 절대경로 파일. SHA-256을 주면 실제 바이트와 일치해야 함 |
| 공통 미디어 | 비디오 스트림 1개, 세로 또는 정사각. Instagram 단독 대상은 가로 영상도 허용한다. ffprobe와 파일 해시를 run에 보존 |
| `publishAt` | 초와 오프셋이 있는 ISO 8601. 내부는 UTC. `now + leadMinutes + 5분`보다 뒤 |
| `targets` | `youtube`, `instagram`, `threads`, `x`, `tiktok` 중 중복 없는 1개 이상. 생략하면 `["youtube","instagram"]`. 선택하지 않은 블록은 경고 후 무시 |
| YouTube | 180초 이하, 제목 1~100자·`<>` 금지, 설명 5,000 UTF-8 bytes 이하, 태그 500자 이하, 숫자 categoryId, `#Shorts`, 실제 검수 evidence |
| Instagram | 캡션 1~2,200자, 해시태그 30개·`@` 20개 이하. MP4/MOV·H264/HEVC·AAC ≤48kHz·23~60fps·3~900초·300,000,000 bytes 이하·가로 ≤1920·moov 앞. 9:16은 권장 비율이며 Instagram 단독 게시에서 16:9 원본 구도를 유지할 수 있다([Meta Reels 규격](https://www.postman.com/meta/instagram/folder/830j7my/reels-publishing)). 용량은 이 도구의 보수적인 300MB 제한을 유지한다. |
| Threads | `threads.text` 1~500자, Instagram과 같은 태그·멘션 한도. MP4/MOV, H.264/HEVC, 23~60fps, 가로 1920 이하, 300초·1GB 이하 |
| X | `x.text` 가중 280자. H.264 MP4, AAC 오디오, 60fps 이하, 140초·512MiB 이하. URL이 있으면 비용 경고를 보여 주며 원문은 보존 |
| TikTok | 캡션 1~2,200자, 공개 범위 `public`, `now+20분`부터 `now+10일`까지. 분은 5의 배수, 초·밀리초는 0 |

문구를 생성하거나 임의로 고치지 않는다. YouTube 제목·태그의 앞뒤 공백과 대소문자만 다른 중복 태그는 거부하여 기존 업로더의 정리로 문구가 달라지는 일을 막는다. Instagram/TikTok 캡션의 공백과 줄바꿈은 보존한다.

YouTube `privacy`는 `scheduled` 기본값 또는 `private`, `unlisted`, `public`이다. `public`은 실행 즉시 공개이므로 승인 표에 그렇게 표시한다. 다른 플랫폼은 `publishAt`을 사용한다. `descriptionBlocks=default`는 기존 ComfyUI 추천·Discord 블록을 적용하고, `none`은 원문을 그대로 사용한다. 업로더 preflight가 자동 블록을 포함한 최종 길이와 검사 증거의 실제 해시를 검증한다.

`youtube.analysis`는 `--inspect`의 contact sheet·오디오 파일을 실제로 검수하여 채운다. 최소 5개, 최대 9개의 서로 다른 샘플 번호와 sampleCount가 일치해야 하며, contact sheet·오디오 SHA-256 및 검수 근거가 필요하다. 오디오가 없으면 `no_audio`와 빈 오디오 해시를 사용한다. `--inspect`는 기존 Shorts 검사 도구를 그대로 호출하므로 180초 이하 파일에 사용한다. YouTube를 선택하지 않은 180초 초과 파일은 preflight에서 직접 미디어 규격을 검증할 수 있다.

## CLI와 승인

```powershell
node packages/social-publishing/tools/publish_short_multi.cjs --publish-file <publish.json> --inspect
node packages/social-publishing/tools/publish_short_multi.cjs --publish-file <publish.json> --preflight
node packages/social-publishing/tools/publish_short_multi.cjs --run-id <run-id> --execute
node packages/social-publishing/tools/publish_short_multi.cjs --run-id <run-id> --status --result-out <publish_result.json>
```

- `--inspect`: 기존 YouTube Shorts 검사 도구로 contact sheet와 오디오 증거를 만든다. 업로드 없음.
- `--preflight`: 로컬 입력, YouTube 채널·category·검수 해시, Instagram 계정·토큰, R2 버킷 HEAD를 확인하고 승인 표와 정규화된 입력을 저장한다. 콘텐츠 게시와 작업 등록은 없다. 토큰 갱신이 필요하면 기존 자격 증명으로 갱신한다.
- `--execute`: **사용자가 preflight의 정확한 publish.json을 승인한 뒤 호출한다.** 파일 해시를 다시 확인하고 승인 시각·manifest 해시를 저장한다. 선택한 YouTube 업로드 → Instagram·Threads·X 예약 작업 등록 → TikTok handoff 생성 순서다. 레인 하나가 실패해도 나머지는 진행한다.
- `--status`: YouTube는 자식 프로세스 `--verify-only`로 조회한다. 예약 전 `private + publishAt`, 예약 후 `public`을 기대한다. 나머지는 레인별 결과 기록을 읽으며 Instagram·Threads·X는 작업 스케줄러도 조회한다. 게시 성공 후 작업이 없어졌다면 `completed_task_absent`(실행 완료·작업 소멸), 실제 조회 실패는 별도 경고다.
- `--cancel`: run을 먼저 취소로 기록한 뒤 Instagram·Threads·X의 소유 작업을 각각 해제한다. 작업이 없는 preflight run도 취소할 수 있다. 대기 중인 worker는 취소를 확인한다. 이미 시작된 API 호출을 되돌리지는 못하며 YouTube·TikTok 예약은 각 사이트에서 취소한다.

`--execute --now`는 선택한 Instagram·Threads·X 레인을 즉시 게시하도록 별도로 요청받았을 때만 사용한다. 레인별 즉시 게시 의도를 승인 기록에 저장한다. 단독 worker의 `--now`도 해당 기록을 요구한다. 일반 예약 실행은 `--scheduled`를 사용하고 T까지 기다린다.

표의 첫 60자는 요약이다. 승인할 때는 `runs/<run-id>/publish.json`의 전체 제목·설명·캡션·시각·설정을 함께 보여준다. 이 승인은 선택된 플랫폼의 업로드·예약·공개를 포함한다. 롱폼 공개 규칙과 별개다.

stdout 프로토콜은 `<이벤트명> <JSON>` 한 줄 형식이다: `SOCIAL_INSPECTION_READY`, `SOCIAL_RUN_CREATED`, `SOCIAL_PREFLIGHT_OK`, `SOCIAL_LANE_STATE`, `SOCIAL_RUN_STATUS`, `SOCIAL_CANCELLED`, `SOCIAL_REPLANNED`. 승인·상태 표와 TikTok 전달 문구는 stderr에만 출력한다. stderr 오류는 `SOCIAL_PUBLISH_FAILED <CODE> <message>`이다. 종료 코드 0은 성공, 1은 명령 실패, 2는 일부 실패·게시/브라우저 작업 대기 또는 확인할 경고다. 예약 등록 후 코드 2는 새 업로드 요청 사유가 아니다.

## Instagram 연결

1. 사용자가 Instagram 프로페셔널 계정·Meta 앱·Instagram 제품·테스터 초대/수락·리다이렉트 URI를 준비한다. 앱 심사 없이 자신의 계정으로 사용 가능한지는 실제 앱 상태에서 확인한다.
2. `node packages/social-publishing/tools/connect_instagram.cjs --init`로 설정 파일을 준비하고 사용자가 `appId`·`appSecret`을 입력한다.
3. `--authorize`가 `127.0.0.1:3400`에 최대 5분의 일회용 callback을 연다. 출력된 인증 URL을 사용자의 Chrome에서 열어 승인한다. OAuth state를 검증하고 코드 → 단기 → 장기 토큰 교환 후 계정 ID를 확인한다.
4. 기본 redirect는 `http://localhost:3400/oauth/instagram/callback`. 앱 대시보드에서 HTTPS가 필요하면 해당 HTTPS URI를 등록하고 `--authorize --https`를 쓴다. runtime에 30일 자체 서명 PFX를 만들며 시스템 신뢰 저장소는 바꾸지 않는다. 브라우저에서 인증서를 확인해야 할 수 있다.
5. callback이 불가능하면 사용자가 임시 파일에 준비한 단기 토큰을 `--token-file <path>`로 교환할 수 있다. 교환 성공 후 그 입력 파일 하나를 소비하여 삭제한다. 기존 설정·장기 토큰 파일을 입력으로 줄 수 없다.

`--status`는 남은 일수만 출력한다. `--refresh`는 만료 전이면서 발급/갱신 후 24시간 이상일 때 갱신한다. preflight와 worker는 10일 미만이면 자동 갱신을 시도한다. 예약 시각 전에 토큰이 만료될 입력은 preflight가 거부한다. 인증 작업은 `INSTAGRAM_AUTH.lock`으로 직렬화한다. 토큰·키를 CLI 인수나 대화에 넣지 않는다.

## Instagram 게시와 Windows 예약

`publish_instagram_reel.cjs --run-id <id> --scheduled`는 승인된 run만 읽는다. 계정·토큰·게시 한도 조회 후 R2의 `social/<run-id>/<hash-prefix>.mp4`로 업로드하고 전송 바이트 해시·HEAD 크기를 확인한다. 임시 GET URL은 메모리에서만 Meta에 전달한다. 컨테이너 생성 → 10초 간격, 최대 15분 상태 조회 → T까지 대기 → `media_publish` 1회 → ID·캡션·미디어 유형·permalink read-back → R2 DELETE·HEAD 404 확인 순서다.

컨테이너 ID, 게시 호출 직전 시각, 반환된 미디어 ID를 단계마다 저장한다. 게시 응답을 모르면 최근 5개 중 시각과 캡션이 맞는 유일한 결과만 채택한다. 없거나 여러 개면 `INSTAGRAM_PUBLISH_UNKNOWN`으로 남기고 사람 확인을 요구한다. 이 상태의 재실행도 조회만 하며 게시 API를 다시 호출하지 않는다. 알려진 미디어 ID 이후 실패는 read-back·R2 정리만 재개한다. 정리 실패는 게시 성공과 별도로 기록하며 24시간 이상 된 소유 객체만 `r2_staging.sweep()` 대상으로 삼는다.

R2는 비공개 버킷과 최대 7일의 서명 GET만 사용한다. 기본 유효기간은 6시간이다. 버킷 생성·결제·공개 설정 변경은 이 도구가 수행하지 않는다. [Cloudflare R2 SDK 계약](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/), [서명 URL 한도](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)를 따른다.

예약 이름은 `DENO\social-publishing\<run-id>`. PowerShell `Register-ScheduledTask`가 T−leadMinutes에 한 번 실행하도록 등록하고 조회로 확인한다. 현재 사용자·로그온 상태, 절전 깨우기, 사용 가능해지면 실행, 배터리 실행, 최대 2시간 제한을 사용한다. 작업 동작은 `wscript.exe //B //NoLogo "<lane>-scheduled.vbs"`이고, 그 VBS가 `.cmd`를 처음부터 창 없이(`Run(…, 0, True)`) 실행해 종료 코드를 그대로 돌려주며 세 runtime 환경변수·절대 Node 경로·stdout/stderr 로그를 보존한다. 2026-09-16 이전의 숨김 PowerShell 동작은 콘솔을 만든 뒤 숨겨 게시 때마다 터미널 창이 두 번 깜빡였다(사용자 지적). 실행이 끝난 1회성 작업은 스케줄러에 남으므로, 쌓이면 `Get-ScheduledTask | Where-Object { $_.TaskName -like 'pub-*' -and -not ($_ | Get-ScheduledTaskInfo).NextRunTime } | Unregister-ScheduledTask -Confirm:$false`로 정리한다(2026-09-16에 9/8~9/16분 20개 정리).

**Instagram 예약에는 PC 전원과 해당 사용자의 로그인 상태가 필요하다.** 잠금 화면은 가능하다. PC가 꺼졌거나 로그아웃 상태면 제시한 시각의 게시를 보장할 수 없다. 다시 실행 가능한 상태가 되면 늦게 실행하고, T+30분까지 결과가 없으면 상태 조회가 `MISSED`로 표시한다. YouTube와 TikTok은 등록된 플랫폼 예약이 자체 실행된다.

## 중복 방지·복구

한 원본 SHA-256의 첫 run은 `pub-<앞 16자>`이며 전체 해시도 확인한다. 실행 전에는 preflight로 입력을 갱신할 수 있다. 실행 후에는 manifest를 교체하거나 전체 execute를 반복할 수 없다. 승인 뒤 변경된 입력·영상 바이트는 거부한다. 취소 후 재계획은 아래의 `--replan` 경로로 별도 이력을 만든다.

```powershell
node packages/social-publishing/tools/publish_short_multi.cjs --run-id <id> --execute --lane instagram
node packages/social-publishing/tools/publish_short_multi.cjs --run-id <id> --cancel
```

`--lane`은 실패·missed 레인 또는 시작 기록을 남긴 뒤 중단된 pending 레인에만 사용한다. 성공한 다른 레인을 건드리지 않는다. YouTube `UPLOAD_OUTCOME_UNKNOWN`과 Instagram `INSTAGRAM_PUBLISH_UNKNOWN`은 조회·사람 확인이 필요하며 잠금 파일 삭제로 중복 방지를 우회하지 않는다. run 수정은 짧은 `RUN.lock`, 전체 실행은 `EXECUTE.lock`, Instagram 장기 실행은 `INSTAGRAM.lock`을 사용하므로 상태 조회·취소가 대기 중에도 가능하다. 살아 있는 PID 잠금을 회수하지 않는다.

주요 오류 코드: `PUBLISH_FILE_INVALID`, `VIDEO_MISSING`, `VIDEO_SHA_MISMATCH`, `INSTAGRAM_SPEC`, `TIKTOK_SCHEDULE_WINDOW`, `PUBLISH_AT_TOO_SOON`, `YOUTUBE_CHANNEL_MISMATCH`, `INSTAGRAM_TOKEN_MISSING`, `INSTAGRAM_TOKEN_EXPIRED`, `R2_UNREACHABLE`, `RUN_ALREADY_EXECUTED`, `RUN_LOCKED`, `LANE_FAILED`. 추가 진단에는 `PUBLISH_NOT_APPROVED`, `INSTAGRAM_ACCOUNT_MISMATCH`, `INSTAGRAM_PUBLISHING_LIMIT`, `INSTAGRAM_PROCESSING_TIMEOUT`, `INSTAGRAM_READBACK_MISMATCH`, `INSTAGRAM_PUBLISH_UNKNOWN`, `SCHEDULER_FAILED`, `MISSED` 등이 있다. 공급자 오류 원문은 보존하지 않는다.

## 브라우저 확인 기록

TikTok은 사용자의 Chrome에서 파일·캡션·설정·예약을 입력하고 예약 목록을 확인한다. 브라우저 자동화 코드나 TikTok API는 포함하지 않는다. 웹 예약의 제공 여부·계정 유형은 실제 계정에서 확인한다. [TikTok 공식 예약 안내](https://ads.tiktok.com/business/en-US/blog/introducing-video-scheduler-now-you-can-plan-tiktoks-in-advance).

```powershell
node packages/social-publishing/tools/record_external_post.cjs --run-id <id> --platform tiktok --state scheduled_by_browser --scheduled-at <offset-ISO> --evidence <absolute-screenshot.png>
node packages/social-publishing/tools/record_external_post.cjs --run-id <id> --platform tiktok --state published --url <TikTok-video-URL> --evidence <absolute-screenshot.png>
node packages/social-publishing/tools/record_youtube_studio_check.cjs --run-id <id> --checks copyright=passed,ad_suitability=passed --monetization on --scheduled-visible --observed-at <offset-ISO>
```

TikTok 증거 파일은 run 안에 해시와 함께 복사한다. 기록 예약 시각은 승인된 시각과 일치해야 한다. Studio 장부의 `copyright=claimed`, `ad_suitability=limited`는 상태에 경고를 표시하며 게시를 막지는 않는다. YouTube 예약 공개는 [공식 publishAt 계약](https://developers.google.com/youtube/v3/docs/videos#status.publishAt)에 따라 플랫폼이 실행한다.

## 검증

```powershell
npm run social-publishing:self-test
npm run unified:offline:self-test -- --scope publishing
```

오프라인 테스트는 임시 runtime·가짜 API 응답·실제 ffmpeg/ffprobe 로컬 미디어를 사용한다. 실제 인증·업로드·작업 스케줄러 등록·외부 삭제는 하지 않는다. publishing 통합 검사는 기존 `publishing-core:self-test`에서 이 패키지 smoke까지 실행한다.

실전 검증은 사용자 승인 후 선택한 플랫폼의 예약·실제 공개·permalink·Windows 실행 로그를 확인한다. Threads·X는 아직 실제 게시를 검증하지 않았다. 오프라인 통과만으로 실전 완료로 보고하지 않는다.

## Threads 연결과 게시

`connect_threads.cjs --status`는 기존 `access_token/token_type/obtained_at/expires_at/refreshed_at/user_id` 형식을 그대로 읽는다. username·scope·source·note도 갱신할 때 보존한다. 발급·갱신 후 24시간 전에는 `--refresh`를 거부하며, 만료까지 10일 미만이면 preflight와 worker가 자동 갱신한다.

```powershell
node packages/social-publishing/tools/connect_threads.cjs --init
node packages/social-publishing/tools/connect_threads.cjs --token-file <runtime의-장기토큰-파일>
node packages/social-publishing/tools/connect_threads.cjs --status
node packages/social-publishing/tools/connect_threads.cjs --refresh
```

사용자 토큰 생성기의 **장기 토큰**을 가져오는 경로가 기본이다. JSON은 기존 토큰 키와 만료일을 넣는다. 토큰 문자열만 넣으면 선언한 발급 시각 또는 가져온 시각부터 60일로 추정하므로, 이미 발급해 둔 토큰은 `obtained_at`과 `expires_at`을 함께 제공한다. 먼저 `/v1.0/me`로 계정을 확인한 뒤 runtime에 저장한다. 입력 토큰 파일은 자동 삭제하지 않는다.

OAuth 보조 경로는 `--authorize`로 인증 주소를 출력한 후 `--paste-redirect`에 리다이렉트된 전체 주소를 표준 입력으로 붙여 넣는다. `--authorize --paste-redirect`로 이어서 실행할 수도 있다. 주소를 CLI 인수나 대화에 붙이지 않는다. 임시 state는 10분 동안 유효하고 일회용이다. 설정의 `https://denomcp.com/oauth/threads/callback`은 앱 대시보드와 정확히 같아야 하며, 404 페이지여도 주소의 code를 받을 수 있다. localhost 수신 서버나 웹사이트 변경은 필요 없다.

`threads: {"text":"…"}`와 `targets`의 `threads`를 추가하면 R2 스테이징 → VIDEO 컨테이너 → FINISHED → T에 threads_publish → 본문·미디어·permalink 확인 → R2 정리를 수행한다. 키는 `social/<run-id>/threads/<hash-prefix>.mp4`로 Instagram과 분리한다. 모호한 게시 응답은 최근 게시의 본문·시각·영상 유형이 맞는 유일한 항목만 채택하고, 찾지 못하면 `THREADS_PUBLISH_UNKNOWN`으로 유지한다. [Meta 공식 Threads API 컬렉션](https://www.postman.com/meta/threads/documentation/dht3nzz/threads-api)을 따른다.

## X 연결과 게시

```powershell
node packages/social-publishing/tools/connect_x.cjs --init
node packages/social-publishing/tools/connect_x.cjs --token-file <runtime의-token.json>
# 브라우저 인증을 사용하는 경우
node packages/social-publishing/tools/connect_x.cjs --authorize
node packages/social-publishing/tools/connect_x.cjs --status
node packages/social-publishing/tools/connect_x.cjs --refresh
```

콘솔 발급 토큰은 [x-token.example.json](templates/x-token.example.json)의 `accessToken/refreshToken/expiresAt/scope` 형식으로 가져온다. 현재 셋업의 `access_token/refresh_token/expires_at/obtained_at/refreshed_at/user_id` 형식과 OAuth `expires_in`도 지원한다. 기존 파일의 키 형식과 username·scope·source·note를 갱신 시 보존한다. 필수 scope는 `tweet.read tweet.write users.read media.write offline.access`다. 연결 후 `/2/users/me`로 계정을 확인한다. preflight에서는 만료 또는 만료 10분 전일 때 갱신하며, worker는 게시 준비를 시작할 때마다 갱신한다. 새 refresh_token까지 저장하므로 예약이 최초 액세스 토큰 만료보다 늦어도 실행할 수 있다.

PKCE S256 콜백 기본값은 `http://127.0.0.1:3400/oauth/x/callback`다. `--https`는 설정의 `redirectUriHttps`와 runtime의 `x-localhost.pfx`를 사용한다. 시스템 인증서 저장소는 수정하지 않는다. 실제 연결에 성공한 네이티브 공개 클라이언트 경로에 맞춰 기본 토큰 교환은 client_id와 PKCE를 사용한다. clientSecret이 저장되어 있어도 인증 방식을 바꾸지 않는다. 기밀 클라이언트로 설정한 앱은 `tokenEndpointAuthMethod: "client_secret_basic"`을 명시해 Basic 인증을 사용할 수 있다. [X 공식 OAuth 2.0 PKCE 계약](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)을 따른다.

`x: {"text":"…"}`와 `targets`의 `x`를 추가하면 v2 initialize → 최대 5MB씩 multipart append → finalize → STATUS → T에 POST /2/tweets → 작성자·본문·첨부 미디어 확인 순서로 실행한다. R2는 사용하지 않는다. 게시 의도를 먼저 기록하고, 응답이 불명확하면 최근 게시에서 본문·시각·작성자·media_key가 같은 유일한 결과만 채택한다. 확인 전에는 게시를 재전송하지 않는다. [공식 청크 업로드](https://docs.x.com/x-api/media/initialize-media-upload), [multipart append](https://docs.x.com/x-api/media/append-media-upload), [가중 글자 수](https://docs.x.com/fundamentals/counting-characters)를 따른다.

X는 유료 API다. preflight에도 계정 조회가 포함되며, 이 구현은 잔액 확인·충전·자동 충전을 수행하지 않는다. 승인 표는 잔액 미확인을 표시하고 `X_PAID_API` 및 링크가 있을 때 `X_LINK_COST`를 알린다. 부족 응답은 `X_INSUFFICIENT_CREDIT`로 분류하며 자동 재시도하지 않는다. 기본 예시에는 URL을 넣지 않는다.

## 취소 후 같은 영상 재계획

```powershell
node packages/social-publishing/tools/publish_short_multi.cjs --run-id <old-id> --cancel
node packages/social-publishing/tools/publish_short_multi.cjs --run-id <old-id> --publish-file <수정한-publish.json> --replan
# 새 승인 전 입력 보완
node packages/social-publishing/tools/publish_short_multi.cjs --run-id <new-id> --publish-file <publish.json> --preflight
# 새 표와 전체 manifest를 승인한 뒤
node packages/social-publishing/tools/publish_short_multi.cjs --run-id <new-id> --execute
```

`--replan`은 이전 manifest·결과·로그를 보존하고 같은 원본 해시의 `pub-…-r2`, `-r3` run을 만든다. 이전 승인은 이어받지 않는다. 이전 worker가 살아 있으면 잠금으로 거부하고, 예약 작업이 실제로 해제되었는지 확인한다. 이미 게시된 ID, 불명확한 게시 시도, 아직 기록된 YouTube·TikTok 외부 예약이 있으면 `REPLAN_REMOTE_STATE_UNRESOLVED`로 중단한다. 원본 해시를 바꾸는 우회를 사용하지 않는다.

Instagram 작업명 `DENO\social-publishing\<run-id>`는 유지한다. Threads·X는 각각 `<run-id>-threads`, `<run-id>-x`를 사용하며 같은 T−leadMinutes에 준비를 시작해 T까지 기다린다. 세 레인 모두 PC 전원과 해당 사용자의 Windows 로그인이 필요하다. 레인별 결과·로그·잠금을 분리하여 다른 레인의 성공을 유지한다.

TikTok 증거는 스크린샷을 저장할 수 없으면 `record_external_post … --evidence-note "<예약 목록 또는 게시 화면의 텍스트>"`로 기록한다. 텍스트와 해시를 남기며 스크린샷으로 표시하지 않는다. 이미지와 텍스트를 함께 지정할 수도 있다. TikTok 기본 대상 제외와 웹 작업법은 workflow를 따른다.
