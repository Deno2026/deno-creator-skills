# 에이전트 문서 안내판

새 세션과 단계 전환은 루트 [AGENTS.md](../../AGENTS.md)에서 여기로 들어와, 현재 요청에 맞는 workflow와 필수 참조를 읽는다. 같은 단계에서 이미 읽은 문서는 이어서 쓴다. 요청 분류가 애매하면 `npm run production:route -- "요청 문장"`의 `workflows`를 참고한다. 라우터가 `recognized:false`를 내면 아래 표에서 직접 고르고, 그 문장을 `scripts/self-test-production-request-router.mjs`에 추가해 다음부터 분류되게 한다.

**자막 하드룰:** 사용자가 전달한 SRT의 발화 envelope(각 cue의 시작·종료)이 싱크의 정본이다. 1단계 cue-locked 교정본(타임코드 고정) → 2단계 문맥 병합본(인접 cue를 envelope 안에서 합친 최대 2줄 표시본)을 만들어 반영한다. 파일이 없으면 자막 단계만 기다리며 재전사·자동 정렬로 대체하지 않는다. 세부는 [자막 제작](workflows/caption-production.md).

| 현재 요청 | 읽을 workflow | 필수 참조·다음 단계 |
| --- | --- | --- |
| 통파일 컷, 파형 컷, 전체 오디오 밸런스·피크·레벨 | [오디오](workflows/audio-finishing.md) | 열린 Premiere를 쓰면 [Premiere 제어](workflows/premiere-control.md) |
| Premiere SRT 교정·새 전사·싱크·타임라인 반영 | [자막 제작](workflows/caption-production.md) | [Premiere 제어](workflows/premiere-control.md) |
| 새 모션·오버레이·자료화면 제작 | [모션 제작](workflows/motion-production.md), [채널 연출 기준(내 것)](workflows/channel-motion-profile.md) | 필수: [서체](workflows/motion-typography.md), [렌더·배치 계약](workflows/remotion-runtime.md); 진행자 샷이 있으면 [진행자 프로필](workflows/avatar-longform-direction.md) |
| 모션 블록 수정·재렌더·배치 실패·미디어 오프라인 | [모션 제작 §4](workflows/motion-production.md#4-수정) | [Premiere 제어](workflows/premiere-control.md)의 overlay 항목(같은 경로 덮어쓰기 금지) |
| 알파 ProRes 출력·프리뷰 합성·Remotion 업그레이드·폰트 로딩 실패 | [Remotion](workflows/remotion-runtime.md) | [서체의 폰트 실패 진단](workflows/motion-typography.md#폰트-실패-진단) |
| 현재 시퀀스 렌더·인코딩("렌더해줘", "4K로") | [Premiere 제어](workflows/premiere-control.md) | 마스터 기본값은 [게시 인계](workflows/publishing-handoff.md)의 마스터 출력 절 |
| 원본부터 마스터까지 A–Z | [영상 제작](workflows/video-production.md) | 현재 단계의 workflow |
| 제목·설명·챕터·태그·캠페인·고정댓글·헬퍼 준비 | [게시 인계](workflows/publishing-handoff.md) | 헬퍼 준비 뒤 READY 실행으로 전환 |
| READY 저장 뒤 업로드·재업로드·현지화·공개·게시 후 수정 | [YouTube 실행](workflows/youtube-upload-execution.md) | 문구는 [게시 인계](workflows/publishing-handoff.md#게시-문구-기준); 재인코딩은 먼저 [Premiere 제어](workflows/premiere-control.md) |
| 숏폼 다중 플랫폼 예약 게시 | [소셜 게시](workflows/social-publishing.md) | [입력·실행 계약](../../packages/social-publishing/README.md) |
| 썸네일 | [썸네일](workflows/thumbnail-production.md) | 기획·생성은 사용자의 썸네일 작업공간(`local.config.json` `thumbnailWorkspaceRoot`), 이 키트는 선택 기록과 YouTube 적용 |
| Premiere 밖 긴 원본(가변 프레임레이트·재생이 끊기는 통파일) | [긴 원본](workflows/long-recording.md) | 배치는 [Premiere 제어](workflows/premiere-control.md) |
| 대본·클립 생성·BGM 제작 같은 창작 상류 | 상류 리포(`local.config.json` `creativeUpstreamRoot`)의 `AGENTS.md` | 이 키트는 완성 클립을 받아 후반만 맡는다 |

실제 기능 실패에는 해당 도구의 capability 항목(`servers/premiere-uxp-mcp/capabilities.json`)과 workflow의 진단 절차를 추가로 읽는다.

## 저장소 구조

| 경로 | 책임 |
| --- | --- |
| `docs/agent/workflows/` | 제작·Premiere·게시 실행법(이 표의 문서들) |
| `docs/premiere/` | 브리지·capability·패널 명세(연결 오류 진단, 개별 도구 API 확인) |
| `productions/<slug>/` | 영상별 상태·확정 artifact 포인터(`npm run production:new -- <slug>`) |
| `src/productions/<slug>/` | 영상별 Remotion source |
| `assets/<slug>/`, `renders/<slug>/` | 추적하지 않는 입력 미디어와 렌더 결과 |
| `scripts/` | 제작·Premiere 실행 도구. 어떤 도구가 있는지는 `package.json` scripts와 [설치 안내의 도구 표](../../README.md#도구-한-장)에서 먼저 확인하고 추측으로 없다고 하지 않는다 |
| `servers/`, `extensions/`, `vendor/` | Premiere 조종: UXP 플러그인, MCP 서버 둘, CEP 브리지 패키지(패치본) |
| `apps/youtube-upload-helper/` | 업로드 헬퍼 앱(로컬 웹) |
| `packages/` | 자막 도구(`caption-core`), YouTube 게시(`publishing-core`), 숏폼 게시(`social-publishing`), 경로·채널 설정(`runtime-paths`), 스키마(`production-contract`) |
| `tmp/` | 재생성 가능한 일회성 작업 파일 |

OAuth·업로드 요청·staging 같은 런타임은 리포 밖 `DENO_UPLOAD_HELPER_RUNTIME_ROOT`(없으면 `local.config.json`, 그것도 없으면 `%LOCALAPPDATA%\DenoCreatorSkills\youtube-upload-helper`)에 둔다. 채널 목록과 설명 고정 블록은 그 폴더의 `channels.json`이 소유한다.
