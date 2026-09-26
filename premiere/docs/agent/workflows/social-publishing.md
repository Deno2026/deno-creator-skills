# 숏폼 다중 플랫폼 예약 게시

완성된 세로 숏폼과 플랫폼별 문구(`publish.json`)를 받아 같은 시각에 YouTube Shorts·Instagram Reels·Threads·X 중 선택한 플랫폼으로 예약한다. 기본 대상은 YouTube·Instagram이며 TikTok은 요청에 포함된 경우에만 브라우저로 넘긴다. 구현과 입력 계약의 정본은 [social-publishing README](../../../packages/social-publishing/README.md)다. 원본 영상·문구를 만들고 고치는 단계는 이 문서 밖(창작 상류)이다.

YouTube 레인은 `channels.json`의 **기본 채널 전용**이다. 다른 채널의 숏폼은 이 레인이 아니라 [YouTube 실행 「업로드 채널」](youtube-upload-execution.md#업로드-채널)의 직접 Shorts 도구(`--channel <id>`)로 올린다.

## 한 편 실행

1. 최종 파일 절대경로와 `publish.json`을 준비한다(틀은 `packages/social-publishing/templates/publish.example.json`). 대상 플랫폼·전체 문구·시각을 넣는다. 일반 예약은 leadMinutes+5분보다 뒤. TikTok이 포함되면 20분 이후, 10일 이내의 5분 단위 시각.
2. `publish_short_multi.cjs --publish-file <path> --inspect`를 실행하고 contact sheet·오디오를 실제로 검수한다. 결과 해시·샘플 번호·화면 내용·오디오 평가·메타데이터 근거를 `youtube.analysis`에 채운다.
3. `--publish-file <path> --preflight`를 실행한다. 오류를 해결하고 stderr의 승인 표, run 안의 정규화된 전체 `publish.json`, 파일 해시, 공개 시각을 사용자에게 보인다. YouTube `public`은 실행 즉시 공개이므로 표에서 확인한다.
4. 사용자가 이 publish.json을 승인하면 `--run-id <id> --execute`를 부른다. 승인은 선택된 플랫폼의 업로드·예약·공개를 포함한다. 일반 구현 요청이나 preflight 실행 자체를 게시 승인으로 해석하지 않는다.
5. 사용자의 로그인된 Chrome에서 YouTube Studio를 열어 업로드 처리·예약 표시·저작권 검사·광고 적합성·수익 창출을 확인하고 장부를 기록한다. claimed·limited는 즉시 알린다.
6. TikTok이 선택된 경우에만 사용자가 곁에 있을 때 같은 Chrome의 TikTok Studio 업로드를 한다. `tiktok/handoff.json`의 파일·캡션·댓글·Duet·Stitch·공개 범위를 입력하고 예약 T를 설정한 뒤 예약 목록을 다시 확인해 기록한다.
7. `--run-id <id> --status [--result-out <path>]`로 상태와 링크를 모은다. 예약 전에는 YouTube `uploaded_scheduled`, Instagram `task_registered`, TikTok `scheduled_by_browser`가 정상 대기 상태다.

```powershell
$tool = '<키트 폴더>\packages\social-publishing\tools'
node "$tool\publish_short_multi.cjs" --publish-file <publish.json> --inspect
node "$tool\publish_short_multi.cjs" --publish-file <publish.json> --preflight
# 사용자 승인 후
node "$tool\publish_short_multi.cjs" --run-id <run-id> --execute
node "$tool\publish_short_multi.cjs" --run-id <run-id> --status --result-out <publish_result.json>
```

Chrome 단계는 현재 제공되는 브라우저 도구로 사용자의 로그인 세션에서 한다. 로그인·비밀 입력은 사용자가 담당하며 전용 브라우저 자동화 코드를 이 패키지에 넣지 않는다.

## 기록 명령

```powershell
node "$tool\record_youtube_studio_check.cjs" --run-id <id> --checks copyright=passed,ad_suitability=passed --monetization on --scheduled-visible --observed-at <offset-ISO>
node "$tool\record_external_post.cjs" --run-id <id> --platform tiktok --state scheduled_by_browser --scheduled-at <offset-ISO> --evidence <absolute-screenshot.png>
```

Studio 확인은 장부이며 공개 차단 게이트가 아니다. API는 수익 창출을 켜지 않는다.

## 예약 전 셋업

- 런타임 폴더: `DENO_SOCIAL_PUBLISHING_RUNTIME_ROOT` → 없으면 `local.config.json` `socialRuntimeRoot` → 없으면 `%LOCALAPPDATA%\DenoCreatorSkills\social-publishing`. 설정 틀은 `packages/social-publishing/templates/*.example.json`.
- `social-settings.json`의 `youtube.expectedChannelId`는 비워 두면 `channels.json` 기본 채널의 ID를 쓴다. 둘 다 없으면 게시 시점에 `YOUTUBE_CHANNEL_ID_MISSING`으로 멈춘다.
- Instagram 프로페셔널 계정, Meta 개발자 앱·Instagram 제품·테스터 역할·리다이렉트 URI를 준비한다. `connect_instagram --init` 후 사용자가 앱 시크릿을 입력하고 `--authorize`로 연결한다.
- 미디어 staging용 R2(S3 호환) 버킷과 키는 사용자가 준비한다(`r2-settings.json`). 비공개 버킷을 쓴다.
- Instagram 게시 시각에는 PC가 켜져 있고 해당 Windows 사용자가 로그인돼 있어야 한다(작업 스케줄러 worker). T+30분까지 결과가 없으면 `MISSED`를 보고한다.

## 실패·취소·재계획

- 종료 코드 2는 예약/브라우저 대기 또는 부분 실패다. `--status`의 해당 레인을 확인하고, 실패·missed 레인만 `--execute --lane <platform>`으로 재개한다. 전체 execute를 반복하지 않는다.
- 취소는 `--cancel`로 Instagram·Threads·X 작업을 해제한다. YouTube·TikTok 예약은 각 사이트에서 처리하고 read-back한다.
- 예약 시각·문구를 바꾸려면 이전 run을 취소한 뒤 `--publish-file <수정본> --run-id <취소한-id> --replan`으로 새 run을 만들고 다시 승인받는다.
- Threads·X는 `targets`에 명시하고 `threads.text`·`x.text`를 채운다(Threads 500자·5분·1GB, X 가중 280자·140초·512MiB를 preflight가 검사). X API는 유료이며 크레딧 부족은 `X_INSUFFICIENT_CREDIT`로 보고한다.
- 자동 파싱은 stdout의 `SOCIAL_* <JSON>` 행을 쓴다. 사람용 표는 stderr에 있으므로 두 스트림을 합쳐 파싱하지 않는다.
