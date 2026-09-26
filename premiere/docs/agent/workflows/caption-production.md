# 자막 제작

## 사용자 전달 SRT 기준 — 최우선 하드룰

**자막 싱크는 사용자가 전달한 SRT의 발화 envelope를 그대로 사용한다.** Premiere 받아쓰기 결과가 싱크를 소유하며 에이전트는 문구 교정, 문맥 병합(envelope 안 내부 경계 제거), 반영을 맡는다. 이 절은 아래 새 전사·재분할·싱크 진단·정렬 절차보다 우선한다. 아래 절차는 사용자가 그 예외 작업을 별도로 명시한 경우에만 쓴다.

1. 사용자가 지정한 SRT 파일과 현재 대상 시퀀스를 확인한다. 파일이 없으면 전달을 요청하고 자막 단계만 기다린다. 열린 caption track·transcript·과거 산출물을 대신 쓰지 않는다.
2. **1단계 cue-locked 교정본**: 원본을 보존하고 모든 cue의 번호·순서·시작·종료 타임코드를 고정한 채 오탈자·고유명사·띄어쓰기만 교정한다. 로컬 Whisper `large-v3`(`npm run premiere:transcribe-timeline`, VAD 기본 꺼짐 — VAD가 실제 발화를 무음 처리한 실측이 있다)로 **전체 발화를 한 번 전사해 모든 cue를 전수 대조한다**(cue 창 단위가 아니라 본문을 이어 붙인 글자 단위 diff로 누락·오인식을 찾고, 차이마다 수정/유지/미확인을 판정해 changes 문서에 표로 남긴다). 받아쓰기가 빠뜨린 영문 토큰·숫자·모델명 복원이 목적이며, Whisper의 무발화 구간 환각과 표기 규칙 차이는 유지로 판정한다. 확인하지 못한 값은 `확인 필요`로 남긴다. 이어서 에이전트가 전체 문맥을 읽고 어색한 문장·빠진 단어를 스스로 찾아 고친다 — 두 소스가 일치해도 최종 문구가 자연스러운지 직접 판정한다. `srt_tool.py compare`로 원본 대비 구조 보존을 검증한다. 도구 사용법은 [caption-core README](../../../packages/caption-core/README.md), 표기 규칙은 [교정 패턴](../../../packages/caption-core/references/CORRECTION_PATTERNS.md)·[용어집](../../../packages/caption-core/references/GLOSSARY.md)(내 채널 용어로 채운다).
3. **2단계 문맥 병합본(검수·게시 track)**: 받아쓰기의 `1줄 약 45자` 분할은 입력 기준일 뿐이다. 조사·수식어·서술어·한 기술 용어를 cue 사이에서 끊어 놓은 인접 cue 1~3개를 한 문장 또는 한 번에 읽히는 문맥으로 병합한다. 병합 cue의 시작은 첫 source cue 시작, 종료는 마지막 source cue 종료만 쓰고, 모든 source cue를 순서대로 정확히 한 번 포함하며, 문구를 다른 시간 범위로 옮기지 않는다. 화자·장면 전환이나 긴 무음(내부 공백 1.5초 초과)은 넘지 않는다. 표시는 cue당 최대 2줄, 줄당 글자 수는 하드 상한이 아니라 가독성 가이드(줄 평균 45자 부근, 45~50자도 괜찮음, 맥락 우선)다. 짧고 독립적인 cue는 기계적으로 합치지 않는다. `srt_tool.py compare-grouped --max-line-chars 50`(source=cue-locked, candidate=병합본)로 envelope·포함·줄 수를 검증한다. 병합본에 `premiere:validate-srt -- --strict`를 쓸 때는 `--max-duration 12 --max-line-length 50`을 준다(기본값 7초·42자는 병합 cue를 오류로 센다).
4. 검수는 문구(한국어 자연스러움·문법 직접 판정 포함), envelope·source cue 보존, SRT 구조, Premiere 반영 결과에 한정한다. 정렬기나 파형 재검증을 자동으로 추가하지 않고, 노출시간·가독성 기본값을 맞추려고 source envelope 밖으로 시간을 바꾸지 않는다.
5. 반영 뒤 전달 SRT에 대응하는 프레임과 실제 caption 경계를 확인한다. Premiere import 반올림·마지막 cue 손실 보정은 반입 전용 처리이며 원본·게시용 SRT 타임코드는 바꾸지 않는다.
6. 싱크 문제 제보에는 먼저 전달 SRT와 반영 결과가 어긋났는지 확인해 반입 오류만 바로잡는다. 전달 SRT 자체의 타이밍 변경은 사용자가 수정 SRT를 주거나 구간을 명시한 경우에만 한다.
7. 자막을 읽다가 협찬 신호(유료 광고·추적 링크·프로모션 코드·"광고 포함" 언급·브랜드 시연)가 보이면 그 자리에서 사용자에게 캠페인 브리프를 요청한다 — 규칙은 [게시 인계의 캠페인 절](publishing-handoff.md#캠페인과-고정댓글). 자막 작업은 멈추지 않는다.
8. 폰트·크기·Track Style은 공개 API 밖이며 사용자가 직접 적용한다. 반영 뒤 `[스타일 적용 필요]`로 한 번만 알린다. 새 트랙은 Premiere 기본 스타일로 들어와 긴 줄이 한 번 더 꺾여 보이므로, 줄 수 판정은 사용자 스타일 적용 뒤에 한다.

Premiere가 참조하는 import SRT는 음소거·폐기 revision도 연결 미디어로 보존한다. 프로젝트 항목 제거 또는 재연결과 저장·재열기가 확인되기 전에는 삭제·이동·이름 변경하지 않는다.

## 1. 표준 경로

자막 요청은 현재 Premiere 타임라인에서 바로 확인할 수 있는 caption track 반영까지 한다.

Premiere 반영 전에는 원본과 review SRT의 모든 cue 시작·종료를 sequence frame으로 전수 비교하고, SRT 밀리초를 Premiere가 읽는 frame으로 내림 변환한 결과도 확인한다. 검증된 import route가 마지막 SRT cue 종료점만 1프레임 줄이는 경우에는 canonical timing을 바꾸지 않고 import 전용 SRT의 마지막 종료 전송값만 `+1f`로 보정할 수 있다(`--premiere-final-cue-end-compensation`). Premiere import 전용 SRT는 final KO·게시 자막으로 쓰지 않는다.

1. 원본 SRT를 보존하고 cue 시작·종료·순서와 자연스러운 묶음을 기본으로 유지한다.
2. 전체 문구를 읽고 실제 음성과 대조해 오인식·누락 용어·표기를 교정한다.
3. 의존구나 기술 용어가 어색하게 끊긴 경계만 인접 cue의 원래 시작·종료 범위 안에서 병합한다.
4. 원본 cue와 교정·병합 cue의 대응으로 누락·중복과 시간 보존을 확인한 뒤 반영한다.

새로 전사해야 하는 경우(**사용자가 "SRT 없이 새로 전사해"라고 명시한 경우에만**):

1. 현재 sequence audio map과 exact timeline audio를 읽고 Whisper `large-v3` CUDA quality-first로 전사한다. BGM·효과음과 발화 원본이 같은 track에 섞여 있으면 `transcribe-premiere-timeline.mjs --target-item-name <정확한 project item 이름>`으로 발화 원본만 남긴다.
2. 원본 token의 순서·source identity·실제 발화 시간을 보존한다.
3. 표기를 교정하고 연속 token을 의미 단위로 병합·재분할한다. 새 시작·종료는 그 cue의 첫·마지막 token의 실제 발화 시간이다.
4. 최대 2줄, 12초가 cue 길이 상한. 짧은 독립문은 1줄, 문장종결·실제 휴지·하드컷에서 나눈다.
5. 구조 QC와 targeted timing review(시작·중간·끝 대표 구간, hard cut 전후, 짧은 독립문과 긴 cue, 낮은 word confidence, 영문 기술명·숫자·고유명사, word timing과 waveform이 충돌한 cue).
6. review SRT를 timeline에 반영한다. write 직전에 기존 caption track identity를 읽어 이전 표시본을 rename/mute하고 새 검수본 하나를 활성화한다.

## 2. 자막 불변조건

- 네이티브 SRT 교정은 원본 cue 대응, 새 전사는 source token/word 대응을 써서 발화 순서와 전체 coverage를 유지한다.
- 네이티브 cue 병합은 원래 시간 범위를 쓰고, 새 전사 cue의 병합·분할은 포함된 token의 실제 시간을 쓴다.
- strict SRT 형식과 실제 audio sync를 각각 확인한다.

## 3. 싱크 오류 수정

(사용자가 특정 시각의 싱크 문제를 지목했거나 `전수조사`를 명시한 경우에만.)

- 지목한 cue와 인접 cue를 실제 audio/waveform에서 확인하고 수정본을 바로 재반영한다.
- 여러 구간에서 같은 문제가 반복되거나 `전수조사`를 요청하면 full audit — 파형(`premiere:align-captions-to-waveform`)을 진단 자료로 쓰고 실제 audio와 원본 token 대응으로 최종 timing을 판정한다.

## 4. Premiere 반영

- `premiere:apply-caption-track`으로 현재 검수 SRT를 반영하고 project·sequence·caption count·V/A duration을 read-back한다.
- 반영에는 반입 전용 사본을 쓴다: 모든 경계를 '의도한 프레임 시작 이상인 최소 밀리초'로 올려 적는다. 원본·검수·게시 SRT의 타임코드는 그대로 둔다.
- 2단계 병합본은 `--revision-review-mode --allow-context-grouping`으로 반영한다. `--allow-caption-retime`은 이 경계 검사를 통째로 끄므로 병합본에 쓰지 않는다.
- 프로젝트 저장은 사용자가 요청한 범위에서. 세션 종료에는 Project Manager 백업을 한 번 알린다.

## 5. 게시용 final

사용자가 문구와 싱크를 확정하면 해당 revision을 `productions/<slug>/captions/final-ko.srt`로 고정하고, 스타일 태그만 제거한 clean KO와 동일 타이밍의 EN을 만든다. 게시 정본은 [게시 인계](publishing-handoff.md)의 입력 계약을 따른다.

## 6. 사용자 직접 편집분 읽기(.prproj 추출)

사용자가 "컷편집·자막을 내가 다 했다, 현재 상태가 최종"이라고 확정하면 그 트랙이 정본이다. UXP에 caption 텍스트 읽기 API가 없으므로 저장된 `.prproj`(gzip XML)에서 추출한다:

```powershell
python scripts/extract-premiere-captions-from-prproj.py --project <.prproj> --track <트랙 이름 또는 부분 일치> --out <final-ko.srt> --json <cues.json>
```

저장본의 mtime이 사용자의 마지막 편집 이후인지 확인한 뒤 추출하고, 추출본을 리포 정본 revision SRT와 cue 단위로 대조해 사용자의 수정을 changes 문서에 기록한 뒤 `final-ko.srt`로 고정한다.
