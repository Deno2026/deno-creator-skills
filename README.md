# Deno Creator Skills

**디노 크리에이터 스킬** — 에이전트(클로드 코드·코덱스 등 MCP를 지원하는 에이전트)를 영상 제작 스태프로 만드는
스킬·워크플로·킷의 공개 창고. 연결은 [Deno MCP](https://denomcp.com) 하나, 자료는 이 저장소 하나다.

감독은 당신이다. 이 저장소는 장비와 절차를 주고, 어떻게 연출할지는 당신이 에이전트와 대화하며 정한다.
그래서 모든 설정은 순정값(기본값) 위주이고, 개인 취향·채널 정보는 각자의 설정 파일에 들어간다.

| 폴더 | 무엇 | 상태 |
|---|---|---|
| [`premiere/`](premiere/) | 프리미어 프로 후반 키트 — 통파일 컷·오디오·자막·모션 오버레이·4K 마스터·유튜브 업로드·현지화·숏폼 예약 게시. 프리미어를 조종하는 UXP 플러그인과 MCP 서버, 도구 스크립트, 업로드 헬퍼 앱, 설치·확인 스크립트, 에이전트 문서 | 첫 판(2026-09-27) — 처음 설치 검증 통과(오프라인 검사 전부·프리미어 읽기 전용 스모크). [설치 안내](premiere/README.md) |
| [`skills/`](skills/) | 에이전트 스킬(꾸러미) — 제작 워크플로의 목적·진행 순서·갈림길, 기법, 프롬프트 작법. Deno MCP의 노하우 창고(Deno Skill)와 같은 내용·같은 판을 파일로. 목록은 [`skills/INDEX.md`](skills/INDEX.md) | 21편(도구 스크립트·설명서 첨부 포함) — 매시 자동 동기화([아래](#동기화--deno-mcp를-그대로-따라온다)) |
| [`workflows/`](workflows/) | ComfyUI 워크플로 배포판 — 워크플로 편에 첨부된 정본 파일(UI 워크플로 `.json`, 에이전트용 API 그래프 `.api.json`): 영상 MiniMax H3(초안·기본·1088p급·FL2VA), 이미지 Qwen-Image 2.1, 배경음 Stable Audio 3, LTX 2.5, MSR 리파인. 편의 판과 함께 바뀐다([목록](workflows/README.md)) | 5편 13파일 — 매시 자동 동기화 |
| [`kits/starter/`](kits/starter/) | 스타터 킷(도화지) — 작업 폴더에 복사하면 어떤 에이전트든 같은 정본·같은 순서로 일하는 뼈대: AGENTS.md, 작업 유형 표, 작품 폴더 틀, 장부, 압축 뒤 다시 읽기 훅. Deno MCP `deno_starter_kit`이 주는 것과 같은 파일(한국어 루트, 영어 `en/`, 판은 `KIT.json`). v8부터 `MY-PC.md`(이 PC의 고정값 틀)와 로컬 작업 유형 | v8 — 매시 자동 동기화 |
| [`plugin/`](plugin/) | 클로드 코드 플러그인 정의(MCP 연결 + 스킬 한 번에 설치) | 준비 중 |

## 쓰는 법

- **에이전트로**: Deno MCP를 연결하면 에이전트가 필요한 스킬·킷을 스스로 읽는다(`deno_knowhow_search`·`deno_starter_kit`).
- **직접**: 필요한 폴더의 README를 따라 복사·설치한다. 프리미어 후반 키트는 [`premiere/README.md`](premiere/README.md)가 설치부터 첫 실행까지 안내한다.

## 동기화 — Deno MCP를 그대로 따라온다

`skills/`·`workflows/`·`kits/starter/`의 원본은 이 저장소가 아니라 Deno MCP다. [`tools/sync-from-denomcp.mjs`](tools/sync-from-denomcp.mjs)가 공개 API(`GET /v1/knowhow`,
편의 첨부 `GET /v1/knowhow/<slug>/files`, `GET /v1/starter-kit`)를 받아 그대로 적고(첨부는 sha256 대조 — 워크플로 편은 `workflows/<slug>/`, 기법 편은 `skills/<slug>/`), GitHub Action([`sync-from-denomcp`](.github/workflows/sync-from-denomcp.yml))이 이를 매시 돌려 바뀐 것이 있을 때만
커밋한다. 그래서 창고에 새 편이 오르거나 판이 바뀌면 한 시간 안에 이 저장소도 같아진다. 두 폴더의 파일을 직접 고치는 제안은 받지 않는다(다음 동기화가 되돌린다) —
내용에 대한 제안은 이슈로 남긴다. 손으로 돌리려면 저장소 루트에서:

```bash
node tools/sync-from-denomcp.mjs
```

## 넣지 않는 것

- 개인 채널·계정·경로·PC 사양, 접속 키·토큰, 작품 원본·렌더(mp4·wav), 내부 운영 규칙과 개인 발언 인용.
- 재배포가 금지된 서드파티 팩(프리셋·전환 라이브러리 데이터).
- 연출 취향. 가이드는 절차와 판단 기준만 주고, 「디노는 이렇게 한다」 예시가 있어도 기본값은 아니다.

## 라이선스

- 코드: [GPL-3.0-only](LICENSE).
- 문서·노하우·워크플로: 출처(Deno MCP, denomcp.com) 표기 조건으로 자유롭게 사용·수정·재배포(CC BY 4.0 취지).
- `premiere/vendor/` 아래 서드파티 패키지는 각자의 라이선스(예: `premiere-pro-mcp` MIT)를 따르며 원 라이선스 파일을 함께 둔다.

## 이름과 자리

- 저장소: https://github.com/Deno2026/deno-creator-skills (2026-09-27, 옛 `deno-director-mcp`에서 개명).
- 제품·사이트 이름은 **Deno MCP**로 유지하고, 이 저장소는 그 MCP가 가리키는 자료 창고다. MCP도 하나, 저장소도 하나.
- 상태: 2026-09-27 공개. 프리미어 후반 키트는 첫 판이며, 제작자가 확인하지 못한 항목은 [키트 README 「검증 상태」](premiere/README.md#검증-상태--무엇을-확인했고-무엇은-못-했나)에 적혀 있다.

## 남은 일

- `skills/`·`workflows/`: 편의 도구 스크립트 첨부(큐·회수·검사 도구)와 발화 검수·BPM 편은 창고에 오르는 대로 자동으로 따라온다.
- `premiere/`: 제작자가 확인하지 못한 항목([검증 상태](premiere/README.md#검증-상태--무엇을-확인했고-무엇은-못-했나))의 실사용 보고를 받아 다음 판에 반영.
