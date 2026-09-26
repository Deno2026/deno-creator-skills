# Publishing core

Upload Helper의 exact READY를 검증하고 YouTube 분할 업로드·재조회·공개 전환을 수행하는 source 모듈이다.

운영은 [문서 라우터](../../docs/agent/README.md)에서 시작한다. 게시 문구와 태그는 [게시 인계](../../docs/agent/workflows/publishing-handoff.md#metadata-authoring), 명령과 검증 순서는 [YouTube 실행](../../docs/agent/workflows/youtube-upload-execution.md)이 소유한다.

## 실행 계약

- OAuth, settings, upload request, staging 영상과 실행 기록은 repo 밖 절대경로 `DENO_UPLOAD_HELPER_RUNTIME_ROOT`에 둔다.
- 사용자가 `완료 · 업로드 시작`을 누른 화면만 `READY`와 `uploadAuthorization`을 생성한다.
- publisher는 최신 READY의 request fingerprint·revision·master hash·final KO hash를 확인한다.
- 롱폼은 `unlisted` 영상과 manual KO를 먼저 올리고 read-back한다. 이어서 reviewed EN과 현재 지원 전체 metadata localization을 같은 승인으로 완료한다.
- direct Shorts 기본값은 `private`다. 승인된 `--privacy private|unlisted|public|scheduled`, `--publish-at <offset ISO>`, `--description-blocks default|none`을 지원하며, 숏폼 다중 게시 승인은 [social-publishing](../social-publishing/README.md)을 따른다.
- localization은 Helper에서 확정한 한국어 제목·설명 전체를 source로 사용한다. 챕터 개수·타임코드·순서를 보존한다.
- 롱폼 `public` 전환은 사용자의 별도 공개 요청으로 실행한다.
- 8분 이상 롱폼 공개에는 YouTube Studio의 저장된 `수익 창출=사용`과 `미드롤=켜짐` live-read가 필요하다.
- 협찬 영상 공개에는 Studio의 유료 프로모션 체크와 공식 API read-back이 추가로 필요하다.
- Studio에서 사용자가 바꾼 live metadata와 공개 상태를 보존한다.

## 주요 entrypoint

- `tools/upload_korean_first_youtube.cjs`: READY preflight, `unlisted` 영상·KO 업로드와 read-back
- `tools/extend_youtube_english_localizations.cjs`: reviewed EN과 전체 metadata localization
- `tools/upload_private_short_from_path.cjs`: exact 단일 파일 Shorts 업로드·예약·시각 전후 read-back (`private` 기본값, run schema 4)
- `tools/record_youtube_studio_publication_gate.cjs`: 공개 승인과 Studio 수익 창출·미드롤·유료 프로모션 상태 기록
- `tools/publish_youtube_longform.cjs`: publication preflight와 `public` 전환
- `tools/lib/helper_ready_gate.cjs`: READY·revision·hash·source binding 검증

## 검증

```powershell
npm --prefix .\packages\publishing-core install
npm --prefix .\packages\publishing-core run smoke
```
