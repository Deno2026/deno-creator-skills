# 게시 인계

`MASTER_READY` 이후 exact master·최종 한국어 자막·게시 metadata를 업로드 헬퍼로 넘기는 실행 계약이다. 게시 후작업은 Premiere 마스터 제작과 독립적으로 진행한다.

## 입력

- `productions/<slug>/delivery/master-manifest.json`: master path·hash·duration·source revision과 final KO pointer
- manifest가 지목한 final KO SRT: 본문·cue count·timeline hash의 정본
- `productions/<slug>/publishing/handoff.json`: 이번 게시 실행에 묶인 exact revision
- `productions/<slug>/thumbnail/package.json`: 사용자가 선택한 썸네일이 있을 때만

헬퍼 준비 단계는 위 manifest/handoff를 쓴다. 완료 버튼 이후에는 READY에 묶인 사용자 선택 영상·최종 한국어 SRT·썸네일·제목·설명·옵션이 게시 정본이다. 확정 이후 **업로드 전에** 수정이 생기면 새 READY를 만든다. **업로드 뒤**의 한국어 설명·태그 수정은 [YouTube 실행 §4b](youtube-upload-execution.md#4b-업로드-뒤-한국어-설명태그-수정)의 revise 도구로 같은 READY를 갱신한다. OAuth·token·account runtime은 리포 밖에 둔다.

사용자가 최종 확정한 SRT는 싱크·문구를 보존해 게시한다. delivery 생성 시 `--user-approved-srt-sha256 <해시>`로 파일을 고정하면 글자 수·읽기 속도·권장 cue 길이는 참고사항으로 처리한다. 형식·번호·시각 순서·겹침·0/음수 길이·최대 2줄·프레임 정렬 검사는 계속 차단 조건이다.

## 마스터 출력 기본값

**기본값은 4K UHD(3840×2160)다.** 시퀀스가 1080p로 편집돼 있어도 최종 마스터는 `export_sequence`에 `YouTube 2160p 4K.epr`(Premiere 설치 폴더 `MediaIO/systempresets/4E49434B_48323634/`)를 지정해 업스케일 출력한다 — YouTube가 4K 업로드에 더 높은 비트레이트·VP9/AV1 코덱을 배정해 1080p 출력보다 재생 화질이 좋다. 다만 1080p 시퀀스의 4K 출력은 합친 화면을 늘리는 것이라 4K 원본의 디테일은 없다 — 편집 시퀀스를 처음부터 4K로 만들면 모션·오버레이도 그 해상도로 렌더한다([Remotion 출력 계약](remotion-runtime.md#장면-종류와-출력-계약)). 프레임레이트·오디오는 시퀀스를 그대로 따르고, 출력 뒤 probe로 해상도·fps·길이를 확인한다. `YouTube 1080p HD.epr`은 사용자가 1080p를 명시한 경우에만.

준비 순서는 **마스터·자막·metadata·handoff 확정 → 로컬 커밋 → 헬퍼 파일 자동 준비 → 사용자 입력 확인**이다. 헬퍼를 연 뒤 해시에 묶인 문서를 다시 쓰거나 handoff를 재생성하지 않는다. 준비 후 수정으로 `STAGED_VIDEO_INVALID`가 나면 현재 입력을 보존하고 최신 handoff로 준비를 다시 실행한 뒤 대조한다. 오래된 preparation의 해시를 직접 바꾸거나 검사를 우회하지 않는다.

## 헬퍼 준비

1. exact master·final KO·metadata 후보·선택된 썸네일을 `publishing/handoff.json`에 고정한다(`npm run production:build-publishing-handoff -- --production <slug> [--youtube-channel <id>]`).
2. 리포 루트에서 헬퍼 launcher를 실행한다.

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\start_upload_helper.ps1" -ProductionSlug <slug>
   ```

3. launcher가 `127.0.0.1:3000`의 local server와 사용자의 Google Chrome 새 창을 연다. OAuth 설정과 refresh token은 런타임 폴더에서 읽는다.
4. Chrome에서 연결 채널, exact master, final KO cue 수, 제목 3안, 설명 3안, 챕터 3종과 세부 옵션을 확인한다.
5. 추천 설명과 선택 챕터를 실제 입력란에 적용하고 다음을 read-back한다: 채널 정책이 허용하는 고정 블록(`channels.json` `descriptionBlocks`), 모든 챕터 줄과 타임코드, category·audio language·privacy·madeForKids·synthetic media·embed·stats·notification·comments·license·recording date, playlist는 사용자의 현재 선택 또는 저장된 선택만.
6. 사용자가 제목·설명·옵션을 확정하고 `완료 · 업로드 시작`을 누르면 현재 화면 fingerprint, source revision과 hash가 묶인 최신 READY가 생성된다.

<a id="metadata-authoring"></a>

## 게시 문구 기준

현재 사용자가 확정한 문구와 캠페인 조건을 우선한다.

### 제목·설명·챕터

- 헬퍼 준비는 한국어 제목 3안·설명 3안·챕터 3종을 제공한다. 핵심 모델·도구·기능을 앞에 두고 읽기 쉬운 기술 표현을 쓴다. 과장이나 내용과 다른 표현을 피하며 사용자가 고친 값이 최종값이다.
- 설명은 실제 영상·최종 자막에 근거해 쓰고 선택 챕터와 고정 블록을 포함한다. 자막 사용법·자동 번역 안내를 추론해 넣지 않는다. 같은 링크는 중복하지 않는다.
- 챕터는 `00:00`부터 실제 전환점에 맞춘다. 균형형 7~9개, 상세형 9~13개, 확장형 13개 이상을 출발점으로 영상 길이와 내용에 맞게 조절한다. 각 이름은 내용을 설명하는 명사·행동으로 쓰고 검색어를 나열하지 않는다. 재편집·재업로드 시 삭제된 구간의 챕터와 길이를 현재 master에 맞춘다.
- **고정 블록은 `channels.json`이 소유한다.** `descriptionBlocks.tutorialBlocks.hub`·`.pcSpec`, `comfyReferral`, `discord`에 적은 문단을 채널별 `descriptionLinks` 스위치대로 붙인다. 순서는 챕터 뒤 HUB → 추천 링크 → Discord → PC Spec. 비워 두면 아무 블록도 붙지 않는다. 캠페인 영상은 그 뒤 맨 끝에 해시태그 한 줄.
- 헬퍼의 자동 조립(`composeUploadDescription`)과 READY 저장 서버는 블록을 다시 붙이므로, READY 전에 입력란에서 최종 순서를 확인한다. 사용자가 헬퍼에서 고친 문구·순서는 그대로 둔다.

### 태그

- 모델명·도구명·핵심 주제를 식별하는 기본값과 함께, 오타·한글 음차·철자·띄어쓰기 변형으로 검색하는 시청자를 포괄하도록 쓴다. API의 500자 제한 안에서 관련성이 높은 표기 변형을 우선하고, 무관한 유행어·기계적 오타·대소문자만 다른 중복은 뺀다.
- 오타 태그는 태그 입력란에 넣고 제목·설명·자막의 정확한 표기는 유지한다.

### 채널별 기본값

강의 채널과 드라마 채널처럼 설명 틀이 다른 채널은 `channels.json`의 `uploadDefaults`(설명 틀·태그·카테고리·합성 콘텐츠 표시)로 나눈다. 채널은 작품 장르로 정하지 않는다 — 사용자가 이번 업로드에 채널을 이름으로 말했을 때만 그 채널이다. 명시가 있을 때 인계는 `--youtube-channel <id>`, 헬퍼는 `-YouTubeChannel <id>`로 같은 채널을 준다. 둘이 다르면 헬퍼 실행이 멈춘다.

## 캠페인과 고정댓글

- **협찬 브리프는 에이전트가 먼저 요구한다.** 자막 교정·모션 작업 중 협찬 신호가 보이면 게시 준비를 시작하기 전에 브리프 원문을 달라고 요청한다. 브리프 원문은 개인 자료이므로 리포·공개 metadata에 옮기지 않고 `publishing/campaign-review.md`에 적용 항목만 정리한다.
- **브리프의 키워드는 태그와 해시태그로 반영한다.** 설명 본문에 `키워드: A, B, C` 줄을 넣지 않는다. 키워드는 (1) 영문 원문 그대로 태그에, (2) 설명 맨 끝에 해시태그 한 줄(앞 3개가 제목 위에 노출되므로 브랜드·제품명을 앞에, 15개 초과 금지), (3) 본문에는 자연스러운 곳에만. 현지화 설명도 같은 구조.
- 고정댓글이 필수인 캠페인은 헬퍼 준비 때 초안도 함께 준비한다. 실제 게시·고정은 사용자 승인 범위.
- 설명·고정댓글에 "유료 광고 포함" 고지 줄을 넣지 않는다. 표시는 공개 전 Studio `유료 프로모션` 체크로 한다.
- 영어 자동 더빙은 YouTube가 자동으로 처리한다(`en-US` 제목·설명을 자체 번역해 붙이며 우리 `en`과 별개). 게시 뒤 `en-US`를 재조회해 고유명사를 확인하고, 틀렸으면 사용자 승인 뒤 검수한 `en`으로 바꾼다. 완료 보고에서 "켜 달라"고 요청하지 않는다.

## 분할 업로드

헬퍼 완료 버튼은 해당 READY에 대해 다음 순서를 승인한다.

1. 롱폼을 `unlisted`로 올리고 exact clean KO를 manual 한국어 자막으로 등록한다.
2. 영상·metadata·한국어 자막 본문을 YouTube에서 재조회한다.
3. final KO 전체 문맥으로 reviewed EN을 만들고 manual 영어 자막으로 등록한 뒤 재조회한다.
4. 현재 지원 언어 전체에 제목과 설명을 localization하고 누락 0개를 확인한다.

## 공개 전환

**`public` 전환은 사용자가 Studio에서 직접 한다.** 업로드 완료 보고에서 공개 전환을 남은 할 일로 안내하지 않는다. 사용자의 별도 공개 요청으로 실행할 때는: 8분 이상 롱폼은 Studio의 `수익 창출=사용`, `미드롤 광고=켜짐`, 저장 완료를 exact video ID에서 확인; 협찬 영상은 `유료 프로모션=체크됨`과 API read-back 확인; 시청자에게 약속한 링크·파일·스킬은 전달 위치를 사용자에게 알린다. 필수 상태를 확인할 수 없는 영상은 `unlisted`로 유지한다.

## 완료 확인

- 현재 게시 포인터가 사용자 확정 READY의 exact 영상·final KO revision/hash를 가리킨다.
- 완료 버튼 이전 YouTube write는 0건이다.
- 최초 `unlisted` 영상과 manual KO가 read-back과 일치한다.
- reviewed EN과 전체 metadata localization의 누락이 0개다.
- 캠페인이 있으면 완료·초안·사용자 처리 상태도 함께 전달한다.

구현 명령과 세부 read-back은 [YouTube 실행](youtube-upload-execution.md)에서 이어 읽는다.
