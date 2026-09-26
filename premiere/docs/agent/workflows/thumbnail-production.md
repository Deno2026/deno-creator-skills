# 썸네일

썸네일의 기획·후보 생성·검수는 사용자의 썸네일 작업공간(`local.config.json` `thumbnailWorkspaceRoot`, 그 폴더의 `AGENTS.md`)이 맡는다. 이 키트는 내용 근거 전달, 선택 기록, YouTube 적용만 맡는다. 썸네일은 마스터 영상과 독립된 후작업이다.

## 작업공간에 넘기는 입력

- 현재 production의 최종 SRT(`productions/<slug>/captions/final-ko.srt`) 또는 확정 대본 — 내용 권위의 1순위.
- READY에서 확정된 제목. 게시 뒤라면 `publishing/localization-source.json`의 `title`.
- 영상에 실제로 나온 결과 장면. 마스터(`renders/<slug>/master/`)에서 프레임을 뽑아 머리 표시줄·자막을 잘라낸 뒤 참조 이미지로 넘긴다. 마스터 원본은 건드리지 않는다.
- 사용자가 준 인물·제품·화면 레퍼런스.

## 결과 위치와 선택 기록

- 후보·프롬프트·참조 이미지·contact sheet·검수 기록은 작업공간에 둔다. 사용자가 고르기 전에는 `FINAL`을 쓰지 않는다.
- 사용자가 고르면 `productions/<slug>/thumbnail/package.json`에 선택 candidate ID, 절대 경로, SHA-256, 내용 근거(`contentAuthority.kind=final-ko-srt` 또는 `approved-script`와 path·revision·SHA-256)를 기록한다.
- 업로드 전이라면 이 package가 READY에 묶이는 썸네일 정본이다([게시 인계](publishing-handoff.md)).

## YouTube 적용

YouTube 요건은 16:9, 1280×720 이상, 2MB 이하다. 사용자가 적용을 요청한 exact candidate hash를 헬퍼/API에 전달하고 실제 적용 결과를 확인한다. 사용자가 Studio에서 직접 넣기로 하면 선택본 경로와 candidate ID만 전달한다(Studio 업로드는 PNG 원본을 그대로 올려도 자동 압축된다).

- 2 MiB 초과: 업로더(`upload_korean_first_youtube.cjs`)가 1280×720 JPEG로 바꾸며 품질을 점점 낮춘다. 그래도 넘으면 업로드 전에 멈추므로 더 단순한 JPEG로 다시 내보내고 package hash를 갱신해 **새 READY**로 진행한다.
- `thumbnails.set` 실패: 영상과 자막은 이미 올라간 상태다. 같은 request-id로 업로더를 다시 실행하면 썸네일만 재시도한다. 두 번째도 실패하면 Studio 수동 적용으로 넘기고 `thumbnail/package.json`과 `STATE.md`에 기록한다.
- 업로드 뒤 적용·교체: 사용자의 적용 요청이 있어야 하고, 도구는 package의 선택 candidate와 파일 SHA-256 일치, 연결 채널의 영상, 2 MiB 이하를 확인한 뒤 `--execute`에서만 `thumbnails.set`을 부른다. 곧바로 live 썸네일을 내려받아 320×180 평균 픽셀 차이로 대조한다(10 미만이면 일치). 결과는 `publishing/thumbnail-apply.json`과 package의 `youtubeApplication`에 남긴다. 다른 채널의 영상은 `--channel <id>`.

  ```powershell
  $env:DENO_UPLOAD_HELPER_RUNTIME_ROOT = '<runtime root>'
  node .\packages\publishing-core\tools\set_youtube_thumbnail.cjs --package productions\<slug>\thumbnail\package.json            # 점검
  node .\packages\publishing-core\tools\set_youtube_thumbnail.cjs --package productions\<slug>\thumbnail\package.json --execute --log productions\<slug>\publishing\thumbnail-apply.json
  ```
