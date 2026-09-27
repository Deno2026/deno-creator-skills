---
slug: speech-check-whisper
title: 발화 자동 검수 — 목소리만 분리해 Whisper large-v3로 전사하고 원고와 대조한다
kind: technique
tags: 발화 검수, 전사, whisper, 자막, 대사, 말소리, 검수, mel-band roformer, 환청, 검수 자동화
models: Whisper large-v3, Mel-Band RoFormer
execution: local
version: 1
summary: 생성 영상의 말이 원고대로 나왔는지, 대사 없는 판에 말소리가 섞이지 않았는지를 귀 대신 전사로 판정하는 순서 — 목소리만 분리(Mel-Band RoFormer) → Whisper large-v3 전사 → 원고 문장 대조(OK/MISS) → MISS 구간만 슬라이스 재전사. 환청·단위 표기·모노 입력 함정과 판정 기준. 도구 둘 첨부(ComfyUI 경로·독립 실행 경로).
---

# 발화 자동 검수 — 목소리만 분리해 Whisper large-v3로 전사하고 원고와 대조한다

## 무엇을 얻나

- 클립마다 「전사 전문 + 구간별 문장 + 신뢰도」, 원고를 주면 문장마다 `OK`/`MISS`.
- 대사가 없어야 하는 판이면 「말 구간 N개(감지 언어)」 — 0이면 깨끗한 판.
- 예: `=== F03_v5 [high] ===` · `[ 0.80- 6.10] 막지 않고 물속에 낮은 보 하나를 놓은 겁니다` · `ref: OK 막지않고물속에…` · `ref: MISS 1986년잠실…` → MISS 한 문장만 2~3초 슬라이스로 다시 듣는다.

## 목적

말소리까지 함께 만드는 모델(MiniMax H3 등)의 발화는 판수가 많아 귀로 하나하나 듣기 어렵고, 원고를 아는 귀는 관대해진다. 전사로 잰 뒤 어긋난 문장만 사람이 듣는다. 이것은 검수 도구이지 판정자가 아니다 — 최종 판정은 사용자.

## 진행 순서와 갈림길

1. **어떤 검수인지 먼저 가른다.**
   - 원고가 있는 판(나레이션·대사) → `whisper_check.py`: ComfyUI 경로, 한국어 고정, 목소리 분리 후 전사, 원고 대조.
   - 대사가 없어야 하는 판(효과음·배경음만) → `speech_check.py`: 독립 실행, 언어 자동 감지 — 중국어·영어 말소리도 그 언어로 적혀 「말이 섞였다」를 잡는다.
2. **준비물을 확인한다**(아래 실행 절). 없는 것은 사용자에게 알리고, 설치는 사용자가 정한다.
3. **돌린다.** 클립을 한꺼번에 준다 — 모델은 한 번 올라가고 순차로 처리된다.
4. **판정 기준을 적용한다.**
   - 신뢰도 `high`(avg_logprob −0.35 이상)·`medium`. `low`는 발화 자체가 불명료할 가능성.
   - 원고 문장이 전부 `OK` → 합격 후보. `MISS`가 있으면 그 문장의 시각 구간 2~3초를 잘라 다시 전사하고, 원고 쪽 문제(오타·발음이 어려운 낱말)인지 발화 쪽 문제(뭉개짐·다른 말)인지 가른다.
   - 영상 길이 이후에 찍힌 구간은 환청 — 무시. 발화가 끝난 뒤에 구간이 있으면 그 자리의 음량(RMS)을 재서 발화와 룸톤을 가른다(임계는 아래 디노 값 참고).
   - 동음·단위 표기 차이(「얕게/약하게」, 「800m/800미터」)는 발화 문제가 아니다 — 도구가 단위를 통합해 비교하지만 남는 것은 사람이 본다.
5. **보고한다.** 클립별 `OK/MISS` 표와 의심 구간 시각, 사용자가 직접 들을 것만 짧게. 「전사가 이렇다」이지 「좋다/나쁘다」가 아니다.

갈림길: 판정 임계(신뢰도·RMS)는 사용자와 정한다. 언어가 한국어가 아니면 `whisper_check.py` 안의 `language`(한 줄)를 바꾼다.

## 내용 자리 — 사용자가 채우는 칸

| 칸 | 어디에 |
|---|---|
| 원고 문장(클립별) | `--ref` 인자 또는 작품 폴더의 원고 파일 |
| 검수 대상 클립 목록과 결과 | `productions/<작품>/상태.md`의 검수 표 |
| 판정 임계(신뢰도·RMS)와 예외 낱말 | `상태.md` 또는 `BRIEF.md` |

## 실행 — 로컬(내 ComfyUI)

**첨부 —** `whisper_check.py`(ComfyUI 경로: 스테레오 16k wav로 바꿔 입력함에 API로 올리고 `LoadAudio → MelBandRoFormerSampler → DenoAudioTranscript → SaveText` 4노드를 클립 수만큼 이어 큐잉·대기·출력 해석, `--ref`로 원고 대조) · `speech_check.py`(독립 실행: faster-whisper large-v3, 음성 구간 검출 켬, 언어 자동, `--words`로 낱말 시각). `deno_knowhow_get`의 `files` 칸 주소로 받는다(로그인 없음, 판이 바뀌면 sha256도 바뀐다). 공개 리포 `Deno2026/deno-creator-skills`의 `skills/speech-check-whisper/`에 같은 파일이 있다.

| 종류 | 이름 | 받는 곳 |
|---|---|---|
| 노드 팩(`whisper_check.py`) | `kijai/ComfyUI-MelBandRoFormer`(모델 로더·샘플러) · `Deno2026/comfyui-deno-custom-nodes`(`DenoAudioTranscript`) — ComfyUI Manager에서 설치 | GitHub |
| 분리 모델 | `MelBandRoformer_fp16.safetensors`(약 456MB) → `models/diffusion_models/` | HF `Kijai/MelBandRoFormer_comfy` |
| 전사 모델 | Whisper `large-v3`(약 3GB) → `models/stt/whisper/large-v3.pt`(`DenoAudioTranscript`가 처음 실행 때 받거나 직접 둔다) | OpenAI Whisper 공개 가중치 |
| 독립 실행(`speech_check.py`) | `pip install faster-whisper`, 모델은 처음 한 번 `--download` | PyPI·HF |
| 공통 | `ffmpeg`·`ffprobe`(PATH) | |

```bash
python whisper_check.py "clip_01.mp4" "clip_02.mp4" --server http://127.0.0.1:8188 --ref "첫 문장" "둘째 문장"
python speech_check.py "sfx_only_01.mp4" "sfx_only_02.mp4"      # 대사 없는 판: 말 구간 0개면 깨끗
python speech_check.py "x.mp4" --words                             # 긴 구간이 실제로 어디서 말하는지 낱말 시각
```

- Whisper는 **항상 large-v3** — turbo는 뭉개진 말을 그럴듯하게 복원해 검수가 헐거워진다(디노 지시 2026-08-24).
- 입력은 스테레오 — Mel-Band RoFormer는 mono를 받지 않는다(도구가 자동 변환).
- 다른 생성이 도는 동안 같이 돌려도 VRAM만 넉넉하면 서로 막지 않는다.

## 함정 — 실측으로 확인된 것

- **환청.** 발화가 끝난 뒤 침묵·룸톤 위에 「감사합니다」 같은 무관한 한 문장을 붙인다(2026-08-24: 56.2초에 발화가 끝난 1분 판에서 57~60초 룸톤(−37~−50dB) 위에 「60.00-62.00 감사합니다」). 영상 길이 이후 구간은 도구가 표시하고, 그 앞은 RMS로 가른다.
- **음성 구간 검출을 끄면 없는 말을 지어낸다**(`speech_check.py --no-vad`: 잡음 위에 「Teksting av …」 같은 자막 문구). 기본은 켠 채로.
- **전사 오인은 발화 문제가 아니다** — 「얕게→약하게」, 「800m→800미터」.
- **언어 고정의 함정** — `whisper_check.py`는 한국어 고정이라 외국어 말소리를 한국어로 뭉개 적는다. 「말이 섞였나」는 `speech_check.py`(자동 감지)로 본다.

## 디노는 이렇게 한다 — 예시 (참고이지 기준이 아니다)

- 원고를 잠근 뒤 H3 판마다 돌리고, `MISS` 문장이 하나라도 있으면 그 판은 「확인 대기」 — 슬라이스 재전사와 귀 확인을 거쳐 원고 오타면 원고를 고치고, 발화 문제면 판을 버린다.
- 대사 없는 판(효과음 전용 지시서)은 `speech_check.py`로 말 구간 0개를 확인한 뒤 채택 후보에 올린다(2026-09-26부터).
- 임계: 신뢰도 high 또는 medium + 원고 전부 OK를 「합격 후보」로 부른다. 룸톤 −35dB 이하, 발화 −25dB 이상(0.1초 창 RMS). 15초 클립 4개에 약 5분(디노 PC).

## 포함되지 않은 것

- 자막 파일(SRT) 만들기·교정 — 프리미어 키트의 자막 편(`premiere-captions-two-stage`).
- 발화의 감정·억양 판정 — 사용자의 귀.

## 바뀐 점

- v1 (2026-09-27): 첫 판. 디노의 ComfyUI 실행 문서 「발화 자동 검수」(2026-08-24)와 말소리 검출 도구(2026-09-26)를 옮기고 도구 둘을 첨부(장비 주소·설치 경로 제거, 입력은 API로 올림).
