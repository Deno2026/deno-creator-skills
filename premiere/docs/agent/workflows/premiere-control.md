# Premiere 제어

## 1. 실행 권한과 시작

- "컷해줘", "오디오 맞춰줘", "자막 올려줘", "모션 넣어줘"는 지목한 범위의 되돌릴 수 있는 timeline write 승인이다. 내부 CLI의 `--allow-write`로 이 승인을 실행기에 전달한다.
- 첫 live read로 project path, sequence ID/name, fps, duration, target track/clip identity를 읽는다. 동명 clip은 track index와 timeline start로 좁힌다.
- 등록된 UXP handler와 production wrapper를 bounded call로 실행한다. `servers/premiere-uxp-mcp/capabilities.json`의 capability label은 증거 깊이를 설명하고, 현재 호출 결과가 실제 가용성을 결정한다.
- 대상 식별이나 호출이 실패하면 해당 도구의 오류와 capability를 확인한다. 연결 문제에는 `npm run premiere:mcp:env`(설치 점검) → `npm run premiere:lifecycle:doctor`(읽기 전용 진단) → `npm run premiere:mcp:smoke` 순서로 원인을 좁힌다.
- Premiere 호출은 한 process/lane에서 직렬로 한다. 문구 교정·번역·독립 자산 준비는 병행할 수 있고, Premiere 갱신과 같은 GPU를 점유하는 고부하 작업은 순서대로 한다.

다음은 현재 요청에 포함됐거나 사용자가 별도로 승인한 범위에서만 한다: 프로젝트 저장·Save As·기존 파일 덮어쓰기, project item·원본 media·sequence 삭제, export·AME queue, 외부 API 전송·비용 발생·플러그인 설치·계정/시스템 변경.

## 2. 두 경로 — UXP와 CEP

| 경로 | 무엇 | 언제 |
| --- | --- | --- |
| UXP(`extensions/deno-premiere-uxp` + `servers/premiere-uxp-mcp`) | Adobe 공개 UXP API. 읽기 전부, 컷·클립 이동·캡션 트랙·효과 추가·렌더 등 대부분의 쓰기. 파일로 명령을 주고받는다(포트 없음) | 기본 |
| CEP(`vendor/premiere-pro-mcp` + `servers/premiere-control-mcp`) | ExtendScript 경로. UXP가 거절하는 것 — 새로 추가한 효과의 property 값 쓰기(리미터 수치), 일부 전환 | UXP가 못 할 때만. `node scripts/premiere-mcp-call.mjs <tool> --allow-write` |

일반 도구 호출: `node servers/premiere-uxp-mcp/call-tool.mjs <tool> '<json>'` (`--output-json <파일>`로 결과 저장). 상시 MCP 등록은 기본으로 꺼 두고 필요할 때만 CLI로 부른다 — 서버가 켜져 있으면 Premiere 종료·재시작과 엉킨다.

## 3. 작업별 최소 검증

| 작업 | 시작 | 진행 중 | 완료 |
| --- | --- | --- | --- |
| 전체 오디오 밸런스 | 모든 clip·사용 구간·기존 효과/automation | 구간 gain·리미터 설정 read-back | 전체 설정·구조·duration 및 실제 출력 오디오 측정 |
| 오디오 Level | identity/current raw 1회 | 20개 단위 Level read-back | 전체 Level·clip 수·duration 1회 |
| 파형/편집 컷 | target V/A·fps·manifest preflight 1회 | 기본 20컷 단위 target V/A·누적 duration checkpoint | 전체 구조·비대상 트랙·실제 V/A 링크 그룹 1회 |
| caption 반영 | SRT·project·sequence·현재 caption track 1회 | 단발 import/create | active track·cue 수·V/A duration 1회 |
| overlay 배치 | target range/track·무오디오 1회 | placement batch checkpoint | 배치 위치·duration·비대상 트랙 1회 |
| marker/effect/property | 현재 대상·값 1회 | write | 결과값 1회 |

- cut batch 안에서는 exact V/A 두 조각 선택과 removal response를 확인하고, full structure는 batch checkpoint와 최종에 읽는다.
- direct Razor 뒤에는 같은 source·timeline start/end·source in/out이 모두 일치하는 V/A만 1쌍씩 다시 링크한다(`premiere:repair-av-links`). 전체 쌍의 `getLinkedItems()`가 정확히 2개인지 확인한다.
- 시퀀스 지문(`scripts/lib/premiere-sequence-fingerprint.mjs`)은 video clip만 프레임 정렬을 요구하고 audio clip은 초 단위로 비교한다 — 사용자가 올린 WAV/BGM은 샘플 단위 끝점을 가질 수 있어 프레임 정렬을 강제하면 배치가 막힌다.
- Adobe collection의 일시적인 `null` slot은 건너뛰고 유효 clip을 계속 처리한다. target identity·duration·비대상 변경이 확인되면 중단해 진단한다.
- timeout 뒤에는 read-back으로 write 적용 여부를 판단한다. 긴 wrapper는 batch 완료 로그로 진행률을 전한다.

## 4. 기능별 운영 경로

- 컷: `premiere:capture-direct-cut-inputs` → cut proposal/manifest → `premiere:apply-direct-razor-cuts -- --allow-write` → `premiere:repair-av-links -- --allow-write`
- 전체 오디오 밸런스: [오디오](audio-finishing.md)의 체감 음량 보정·순간 피크 제한 기본 경로
- Level만: `premiere:export-audio-map` → `premiere:propose-audio-balance` → `premiere:apply-audio-balance`
- caption: 사용자 전달 SRT → (`premiere:transcribe-timeline`은 문구 대조용 Whisper) → 교정/문맥 병합/QC → `premiere:apply-caption-track`
- overlay: 모션 workflow의 alpha/placement → `premiere:place-overlays`. **배치된 렌더 파일을 같은 경로에 덮어쓰지 않는다** — 덮어쓰기 + refresh 뒤 Premiere가 항목을 오프라인 처리하고 `relink_media`도 실패한다. 블록을 다시 렌더하면 새 파일명(`--suffix`)으로 저장하고, 기존 클립을 ripple 없이 제거 → 캡처 → `build-placement --blocks=<id> --suffix=<new>` → 배치로 교체한다. 오프라인이 된 옛 항목은 사용자 승인 전에 삭제하지 않는다. 트랙 추가(`add_tracks`)는 capability가 `write-unverified`라 실제 시퀀스에 쓰지 않는다 — 블록이 맨 위 비디오 트랙의 빈자리에 들어가면 거기에 배치하고(`place-overlays`는 `overwriteClip` + 점유 검사라 기존 클립을 밀지 않는다), 안 들어가면 사용자에게 빈 트랙 추가를 요청한다.
- 시퀀스 렌더: `export_sequence` 또는 AME 경로로 지정한 출력·preset을 쓰고 결과 파일을 probe한다. 게시용 마스터의 기본 preset은 4K(`YouTube 2160p 4K.epr`)이며 근거와 예외는 [게시 인계](publishing-handoff.md)가 소유한다.

새 실행기나 실제 실패는 바뀐 동작을 재현하는 fixture와 해당 대상의 read-back으로 확인한다. 결과가 불명확할 때만 필요한 capture나 구조 비교를 추가한다.

## 5. 자막 API 지원 범위

- 자막 텍스트·타이밍·track 생성, rename, mute는 현재 wrapper로 한다.
- 폰트·크기·Track Style은 Adobe 공개 API 밖이다. caption 반영을 마친 뒤 `[스타일 적용 필요]`로 한 번 알린다.
- caption track write 직전에 live track ID/index를 다시 읽는다.
- caption 텍스트 읽기 API도 없다(UXP `getTrackItems()`는 타이밍만). 사용자가 트랙을 직접 다듬은 최종 상태는 저장된 `.prproj`에서 `python scripts/extract-premiere-captions-from-prproj.py`로 읽는다([자막 제작 §6](caption-production.md#6-사용자-직접-편집분-읽기prproj-추출)).

작업이 끝나면 이 작업이 만든 helper process를 종료하고 Premiere 본체와 사용자 프로젝트는 유지한다.
