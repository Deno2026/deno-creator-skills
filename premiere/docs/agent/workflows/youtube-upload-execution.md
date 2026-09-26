# YouTube 실행

`MASTER_READY` production을 업로드 헬퍼에서 확정하고 `unlisted+KO → reviewed EN+전체 metadata localization → 승인된 public 전환` 순서로 실행한다. 제목·설명·챕터·태그를 준비하거나 바꿀 때는 [게시 인계의 문구 기준](publishing-handoff.md#metadata-authoring)을 함께 읽는다.

## 1. 헬퍼 준비와 READY

1. exact master·final KO·metadata 후보를 `productions/<slug>/publishing/handoff.json`에 고정한다.
2. 헬퍼를 실행한다. 사용자가 다른 채널을 명시한 영상만 `-YouTubeChannel <id>`를 붙인다(생략 = `channels.json`의 기본 채널).

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\start_upload_helper.ps1" -ProductionSlug <slug>
   ```

3. Google Chrome 창에서 업로드 채널과 연결 상태, exact master/final KO, 제목 3안·설명 3안·챕터 3종·태그, 고정 블록, 세부 옵션, playlist 선택을 확인한다.
4. 사용자가 최종 제목·설명·옵션을 확인하고 `완료 · 업로드 시작`을 누른다.
5. 헬퍼는 현재 화면 fingerprint, master/final KO hash와 source revision을 묶어 최신 READY를 생성한다.

YouTube write는 이 READY의 승인 범위에서 시작한다. 완료 뒤 화면 값을 수정했으면 현재 값으로 새 READY를 만든다.

## 2. source와 runtime

- production source: `productions/<slug>/`
- 헬퍼 source: `apps/youtube-upload-helper/`, publisher source: `packages/publishing-core/`
- runtime root: `DENO_UPLOAD_HELPER_RUNTIME_ROOT` → 없으면 `local.config.json` `uploadRuntimeRoot` → 없으면 `%LOCALAPPDATA%\DenoCreatorSkills\youtube-upload-helper`
- 채널 목록·설명 고정 블록: `<runtime>/channels.json`(틀은 `packages/runtime-paths/templates/channels.example.json`)
- OAuth 앱 설정: `<runtime>/youtube-settings.json`(Google Cloud 콘솔에서 만든 OAuth 클라이언트 — 여러 채널이 같은 앱을 쓴다). 토큰: 기본 채널 `<runtime>/youtube-oauth-token.json`, 다른 채널 `<runtime>/channels/<id>/youtube-oauth-token.json`
- READY requests `<runtime>/upload-requests/<request-id>/`, staging `<runtime>/upload-video-staging/`, 실행 증거 `<runtime>/runs/`

publisher shell에는 현재 source와 runtime을 명시한다.

```powershell
$env:DENO_PRODUCTION_ROOT = '<이 키트 폴더>'
$env:DENO_UPLOAD_HELPER_RUNTIME_ROOT = '<runtime root>'
```

OAuth secret과 token 원문은 runtime에만 둔다. refresh token 부재 또는 Google `invalid_grant`가 확인되면 사용자에게 Google 연결을 요청한다. 계정 선택·허용은 사용자가 누른다.

### 업로드 채널

- 채널은 항상 `channels.json`의 기본 채널이고, 다른 채널은 사용자가 그 영상에 이름으로 명시했을 때만이다. 장르·인트로·썸네일·폴더 이름·이전 업로드 위치로 추정하지 않고, 앞선 영상의 지시를 다음 영상으로 이어 쓰지 않는다.
- 사용자는 헬퍼를 직접 띄우지 않는다. 화면의 채널 선택도 에이전트가 맞춘다. `start_upload_helper.ps1`은 실행할 때마다 선택 채널을 `-YouTubeChannel`(없으면 기본 채널)로 다시 맞추고, 인계 `youtubeChannel`과 다르면 서버를 띄우기 전에 멈춘다.
- 채널 연결은 헬퍼 설정 화면의 채널별 `Google 승인 시작`이다. 받은 토큰의 채널 ID가 `channels.json`과 다르면 저장하지 않는다.
- READY를 읽는 실행기는 READY 채널의 토큰을 쓰고, 쓰기 전에 토큰의 실제 channel ID를 대조한다. `--channel <id>`는 READY 채널과 같을 때만 허용된다. READY 밖 도구(썸네일 적용·직접 Shorts)는 `--channel <id>`, 지정이 없으면 기본 채널이다.
- 숏폼 다중 게시(`packages/social-publishing`)의 YouTube 레인은 기본 채널 전용이다. 다른 채널의 숏폼은 직접 Shorts 도구 `--channel <id>`로 올린다.
- API 한도: 새 Google Cloud 프로젝트의 YouTube Data API 기본 할당량은 하루 10,000 units다(`videos.insert` 1,600, `captions.insert` 400, `videos.update`·`thumbnails.set` 50, `videos.list` 1 — 공식 quota cost 표에서 다시 확인한다). 한 편의 롱폼 + 자막 둘 + 82개 언어 현지화는 넉넉히 들어가지만 하루에 여러 편이면 quota 소진 시 checkpoint에서 다음 날 이어간다. 더 필요하면 Google의 할당량 증가 신청 폼으로 요청한다(용도·채널을 적고 승인은 기한이 있다).

## 3. 최신 READY preflight

같은 slug에서 가장 최신인 READY 한 개를 선택하고 OAuth 호출 전에 검사한다.

```powershell
node .\packages\publishing-core\tools\upload_korean_first_youtube.cjs --request-id <request-id> --preflight
```

preflight 항목: `READY`와 `uploadAuthorization.authority=user_pressed_upload_helper_complete_button`, request fingerprint·slug·source revision 일치, exact master path·size·SHA-256, final KO와 clean KO의 cue·timecode·본문·timeline SHA-256, clean KO의 style tag 0개, 헬퍼에서 확정한 metadata와 옵션, `defaultLanguage=ko`·`defaultAudioLanguage=ko`, 챕터 순서·범위와 현재 final KO/master 일치, 선택 썸네일의 request-bound SHA-256.

자막 없는 영상(`cinematic` 유형): `defaultLanguage=ko`는 제목·설명의 언어이고 `defaultAudioLanguage`는 실제 음성 언어를 유지한다. SRT나 수동 자막 track은 만들지 않으며, 현지화 실행기에 `--metadata-only`를 쓴다.

## 4. 1차 업로드: unlisted 영상과 KO

```powershell
node .\packages\publishing-core\tools\upload_korean_first_youtube.cjs --request-id <request-id>
```

롱폼은 `unlisted` 영상과 exact clean KO manual caption을 함께 올린다. 선택된 썸네일과 playlist가 있으면 request에 묶인 값만 적용한다. 직접 Shorts는 전용 entrypoint로 `private` 업로드한다.

영상 생성 직후 exact video ID·처리 상태·`unlisted`, 제목·설명·태그·카테고리, `snippet.defaultLanguage/defaultAudioLanguage`, manual KO track과 내려받은 caption body, 로컬 clean KO와 YouTube KO의 일치를 재조회한다. 재조회 중 사용자가 Studio에서 바꾼 값은 이후 단계의 live authority로 보존한다.

- `containsSyntheticMedia`는 업로드 때 보내지만 `videos.list(part=status)` 재조회에는 값이 오지 않는다(null). 재조회 값으로 표시가 꺼졌다고 판정하지 않는다.
- 업로드 직후 재조회가 전파 지연으로 `verification_mismatch`(예: 태그가 비어 보임)가 되면 **같은 명령을 그대로 다시 실행한다.** 실행기는 기록된 `videoId`·`captionId`를 보고 업로드를 건너뛴 뒤(`VIDEO_UPLOAD_SKIPPED_EXISTING`) 재조회만 다시 한다. 새 영상으로 다시 올리지 않는다.

## 4b. 업로드 뒤 한국어 설명·태그 수정

재업로드나 새 READY 대신 `revise_youtube_korean_metadata.cjs`를 쓴다. live snippet이 READY의 `effectiveExpected`와 같은지 대조하고, 보호 링크(첫 줄 추적 링크·설정된 고정 링크)와 태그 500자 한도를 검사한 뒤 `videos.update(snippet)`으로 반영하고 재조회로 확인한다.

```powershell
node .\packages\publishing-core\tools\revise_youtube_korean_metadata.cjs --request-dir <request-dir> --video-id <video-id> --description <revised-ko.txt> --tags <tags.json> --reason "<사유>"   # preflight
# 대조가 깨끗하면 같은 명령에 --execute
```

## 5. 2차 작업: EN과 전체 localization

1차 read-back이 통과하면 같은 READY로 바로 이어간다. READY의 `uploadAuthorization.scope`에 `reviewed_en_caption_upload`·`metadata_localization_write`가 있고 `postUploadExpansionAuthorized=true`면 완료 버튼 승인이 이 절 전체를 덮는다 — 싱크 확인을 따로 묻지 않는다.

1. final KO 전체 문맥을 source로 reviewed EN SRT를 만든다(타임코드는 final KO와 동일; 검수 보고서 `captions/english-review.md`에 PASS 기록).
2. `srt_tool.py source-lock`으로 caption review PASS와 `caption-source-lock.json`을 같은 revision에 고정한다.
3. manual EN을 업로드하고 본문을 다시 내려받아 비교한다.

   ```powershell
   node .\packages\publishing-core\tools\extend_youtube_english_localizations.cjs --video-id <video-id> --request-dir <request-dir> --caption-only --caption <reviewed-en.srt> --slug <slug> --source-lock <caption-source-lock.json> --final-korean <final-ko.srt> --clean-korean <clean-ko.srt> --review-report <english-review.md>
   ```

4. 작업 시점의 `i18nLanguages.list`를 조회하고, 한국어를 제외한 현재 지원 언어 전체에 제목과 설명을 localization한다. 80개 안팎의 번역은 언어 그룹별로 나눠 번역하고, 조립 스크립트로 구조 검사(모든 대상 언어, 추적 링크 첫 줄, 필수 URL 전부, 챕터 개수·타임코드·순서, 캠페인 해시태그, 제목 ≤100자·설명 ≤5000자, 한글 잔존 0)를 통과한 것만 `metadata-localizations.json`으로 합친다. 홍콩(zh-HK)은 표준 서면 번체로 쓴다.

   ```powershell
   node .\packages\publishing-core\tools\extend_youtube_english_localizations.cjs --video-id <video-id> --request-dir <request-dir> --metadata-only --metadata <metadata-localizations.json> --clean-korean <clean-ko.srt>
   ```

5. 재조회로 언어 누락 0개를 확인한다. 일부 언어만 누락되면 같은 명령에 `--verify-only`로 전파 결과를 읽는다. quota가 소진되면 완료 언어와 남은 언어를 checkpoint에 저장하고 다음 quota 구간에서 이어간다.

## 6. public 전환

사용자가 exact video의 공개 전환을 요청하면 먼저 사용자의 Chrome에서 YouTube Studio 설정을 확인한다(8분 이상 롱폼: 수익 창출·미드롤; 협찬 영상: 유료 프로모션 체크와 API `paidProductPlacementDetails` read-back). 필수 상태가 확인된 exact request에 Studio 증거를 기록하고 preflight와 공개 전환을 실행한다.

```powershell
node .\packages\publishing-core\tools\record_youtube_studio_publication_gate.cjs --request-id <request-id> --video-id <video-id> --duration-seconds <seconds> --monetization-enabled --midroll-enabled --saved --user-public-approval
node .\packages\publishing-core\tools\publish_youtube_longform.cjs --request-id <request-id> --video-id <video-id> --execute
```

필수 Studio/API 상태를 확인할 수 없는 영상은 `unlisted`로 유지한다.

## 7. 완료

- exact video가 의도한 공개 상태와 metadata를 가진다.
- manual KO/EN track의 다운로드 본문이 승인된 로컬 source와 일치한다.
- 현재 지원 metadata localization의 누락이 0개다.
- production state에는 exact video ID와 검증 포인터를 기록한다.

## 게시 후 수정과 재업로드

- 기존 영상의 한국어 태그·제목·설명 수정은 §4b로. 다른 필드는 exact video ID와 최신 live 값을 먼저 읽고 요청한 필드만 바꾼 뒤 재조회하고 `productions/<slug>/publishing/`에 수정 내용·승인 근거·검증 포인터를 남긴다.
- 재업로드는 [Premiere 제어](premiere-control.md)에서 현재 시퀀스를 다시 렌더하고 master·자막·삭제 구간 챕터를 대조한 뒤 새 READY와 새 영상 ID로 실행한다.
- 이미 반영한 API 쓰기의 즉시 재조회가 이전 값이면 같은 쓰기를 반복하지 않고 전파 후 읽기만 다시 한다.
- 기존 영상의 **제목만** 현지화할 때: `part=localizations`는 번역 전체를 바꾸므로 YouTube 자동 번역을 받은 그대로 합쳐 보낸다. 설명을 비우면 시청 페이지는 원문 설명을 보여 준다.
- 썸네일 적용·교체는 [썸네일](thumbnail-production.md)의 `set_youtube_thumbnail.cjs`.
