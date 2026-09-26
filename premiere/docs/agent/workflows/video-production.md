# 영상 제작 A–Z

**자막 단계 하드룰:** A–Z 제작에서도 사용자가 Premiere에서 내보내 전달한 SRT를 기다린 뒤 그 타임코드를 유지하며 문구만 교정한다. SRT 미전달은 새 전사를 실행할 사유가 아니다. 자막 외 독립 작업은 계속할 수 있다.

## 1. 적용 범위

사용자가 원본 통파일부터 영상 마스터까지 전체 제작을 맡기거나 컷 확정 뒤 "영상 마스터까지 진행해"라고 요청했을 때 적용한다. 단계별 요청은 해당 workflow의 범위로 한다. 제목·설명·썸네일·업로드 헬퍼·YouTube는 마스터 뒤의 게시 후작업이다.

## 2. 역할과 승인

- 사용자는 영상 목적·시청자·피해야 할 방향, 컷 합격, 최종 자막, 프로젝트 저장, 원본·project item 삭제, 공개 범위를 정한다.
- 에이전트는 정독 방식, 컷 후보 구현, 오디오 처리, 자료 선택·생성, 모션 기법·레이아웃, 검수 범위, 기술 검증을 정한다.
- A–Z 인수는 해당 프로젝트 사본의 timeline cut/ripple·Level·overlay write를 포함한다. 프로젝트 저장, project item·원본 media 삭제, export·AME, 외부 유료 생성, 공개는 사용자의 현재 요청에 포함된 범위로.

## 3. 표준 사이클

### 3.1 인수와 현재 상태

원본, 현재 Premiere project·active sequence, 해상도·fps·duration, caption/SRT, 사용자 고정 편집을 읽는다. 원본과 프로젝트 사본의 관계를 확인하고 사용자 파일과 다른 세션 변경을 보존한다. 세션을 넘기는 제작은 `npm run production:new -- <slug>`로 production 폴더를 만든다.

### 3.2 컷편집

[오디오](audio-finishing.md)에 따라 파형으로 안전한 발화 경계를 잡는다. 통파일 컷은 명백한 재시작·중복·실패 테이크까지 정리한다. `파형만`·`소리 유무만`은 실제 소리 경계만 쓴다. 귀로 판정할 애매한 테이크는 `분:초 + 발화`로 사용자에게 제시한다.

### 3.3 컷 검수

사용자가 컷을 확인하는 동안 timeline에는 컷 결과만 둔다. 컷 확정 뒤 오디오·모션·자막 제작을 시작한다. 사용자가 직접 수정한 timeline을 최신 기준으로 다시 읽는다.

### 3.4 마스터 자동 제작

1. 확정된 컷에 [오디오](audio-finishing.md)의 처리를 적용한다.
2. 모션이 요청된 경우 영상 전체 맥락을 읽고 [모션 제작](motion-production.md)으로 제작·배치한다. 새 시각 방향·새 장르·직전 회귀가 있으면 대표 검수 구간을 먼저 확인한다.
3. 사용자가 전달한 SRT를 기다려 cue-locked 교정 → 문맥 병합 순서로 진행한다([자막 제작](caption-production.md)).
4. Premiere 호스트 호출과 같은 GPU를 점유하는 분석·렌더는 순서대로 실행한다. 독립적인 문구 교정·번역·자산 준비는 병행한다.

### 3.5 Premiere 배치와 구조 확인

[Premiere 제어](premiere-control.md)의 쓰기 계약을 적용한다. overlay는 무오디오·frame boundary·오름차순 placement로 배치한다. 작업별 checkpoint와 최종 read-back에서 목표 clip, start/end, sequence duration, 비대상 track을 확인한다.

### 3.6 재생 검수와 수정

숫자·단위·고유명사·hard cut·낮은 alignment confidence·긴 cue처럼 사람이 볼 가치가 높은 항목을 `분:초 + 발화 + 사유`로 우선 제시한다. 사용자 피드백이 지목한 구간을 수정해 timeline에 재반영한다. 최종 자막 합격 뒤 exact SRT와 caption revision을 고정한다.

### 3.7 마스터 렌더와 `MASTER_READY`

사용자가 현재 sequence의 render/export를 요청하면 UXP/AME 경로로 실행한다. 게시용 마스터의 기본 출력은 4K UHD(1080p 시퀀스도 업스케일)이며 근거·예외는 [게시 인계](publishing-handoff.md)의 마스터 출력 절. render 뒤 codec·해상도·fps·duration을 확인하고 `npm run production:build-delivery -- --production <slug> ...`로 exact 파일 hash와 revision을 `delivery/master-manifest.json`에 묶어 `MASTER_READY`로 고정한다. overlay 배치 뒤와 세션 종료에 Premiere Project Manager 백업을 알린다.

## 4. 보고

- 결과, 사용자가 지금 확인할 항목, 남은 승인 경계를 먼저 말한다.
- 구간은 `구간 N — 03:14–03:38 — "…"` 형식으로 식별한다.
- timeline write, 프로젝트 저장, render, master 검증을 각각 확인한 증거로 보고한다.
