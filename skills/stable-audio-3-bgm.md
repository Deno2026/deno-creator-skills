---
slug: stable-audio-3-bgm
title: 로컬 배경음 — Stable Audio 3 Medium(증류판)으로 연주곡·앰비언트 만들기
kind: workflow
tags: 음악, 배경음, bgm, 앰비언트, 연주곡, 인트로, stable audio, stable audio 3, 오디오, comfyui, 로컬, 무보컬
models: Stable Audio 3 Medium
execution: local
version: 3
summary: 디노가 로컬에서 연주곡 배경음·인트로·앰비언트를 만드는 방법. Stable Audio 3 Medium(증류판, 8스텝·CFG 1 — base 판은 쓰지 않는다)을 ComfyUI 공식 템플릿 값 그대로 API로 돌린다. 프롬프트 한 문단 문법(TrackType·VocalType 태그 + 장르·악기·분위기·BPM), 길이 잡기, 후보 여러 개 뽑아 고르기, MP3 저장, 무보컬 오염 회피, 16GB 카드 길이 사다리 실측. 프롬프트 작법 전문과 실수 목록은 짝 편 stable-audio-3-prompting.
---

# 로컬 배경음 — Stable Audio 3 Medium

**가사 없는 음악**(배경음·인트로·앰비언트·효과음에 가까운 질감)을 내 ComfyUI에서 몇 초 만에 뽑는 워크플로다. 가사가 있는 노래는 이 편의 범위가 아니다.

## 무엇을 만드나

- 5초~수 분 길이의 스테레오 44.1kHz 음악 파일(MP3). 한 번에 여러 후보(배치)를 뽑아 사용자가 고른다.
- 결과 예(디노): 숏츠 인트로 20초 4갈래(브레이크비트·드럼앤베이스·저지 클럽·일렉트로 베이스, 2026-09-22 — 디노가 04를 채택), 향수 광고 20초 3갈래(2026-09-23 — 02 채택), 애니 인트로 1분 3곡(2026-08-28).

## 목적

- 편집에 바로 얹을 **무보컬** 배경음을 빠르게 여러 개 뽑아 고르게 한다. 노래 생성기(가사·보컬 학습)로 연주곡을 시키면 숨소리·유사 보컬이 섞이는 일이 있어(디노 실측 2026-08-21·28), 무보컬은 이 모델로 분리하는 것이 안전하다.
- 모델은 **Stable Audio 3 Medium 증류판**이다. 같은 이름의 `base` 판은 Stability가 「파인튜닝용, 바로 생성하려면 Medium을 써라」라고 적어 둔 사전학습 원본이고, 디노도 직접 들어 보고 「증류가 안 돼 별로」로 판정해 쓰지 않는다(2026-09-27).

## 진행 순서와 갈림길

1. **쓰임새와 길이를 정한다**: 어디에 깔 음악인가(인트로·본편 배경·전환), 몇 초인가(편집 길이 + 여유 1~2초 — 끝은 편집에서 자른다), 템포 감각(BPM)과 분위기.
2. **프롬프트 한 문단**을 쓴다(아래 「내용 자리」 문법). 시작에 `TrackType: Music, VocalType: Instrumental.`을 붙인다 — 공식 가이드의 태그로, 무보컬 지시의 핵심이다. 작법 전문(공식 가이드 기반 영어 지시문 — LLM에 그대로 넣는다)과 **실수 목록**(가사·부정문·설정 변경·한국어·딱 맞춘 길이·380초 초과 등)은 짝 편 `stable-audio-3-prompting`.
3. **후보를 여러 개 뽑는다**: 방향이 다른 프롬프트 3~4개(시드 고정) 또는 같은 프롬프트에 시드 여러 개(`batch_size` 2~4). 사용자에게는 파일과 한 줄 설명·템포를 같이 보인다.
4. **사용자가 고른다.** 판정은 귀로 — 에이전트는 길이·음량·무음 구간 같은 잰 값만 낸다. 고른 파일은 원본 그대로 보존하고 자르기·페이드는 편집에서.
5. 다시 뽑을 때는 프롬프트에서 **한 요소만** 바꾼다(악기·BPM·분위기 중 하나). 스텝·CFG는 건드리지 않는다(증류판의 공식 값).

갈림길:
- 가사·보컬이 필요하다 → 이 편이 아니다(노래 생성 모델).
- 효과음 한 개(문 닫기·바람)가 필요하다 → 같은 그래프에 `TrackType: SFX,` 태그(공식)로 1~5초짜리가 나오지만 디노는 효과음을 여기서 뽑지 않는다(영상 모델이 소리를 같이 만들거나 편집 라이브러리).
- 길이가 길다(2~3분 이상) → 「내 PC」 사다리에서 그 길이의 시간·VRAM을 보고, 곡 구조(도입·전개·마무리)를 프롬프트에 문장으로 적는다.

## 내용 자리 — 사용자가 채우는 칸

| 칸 | 어디 | 어떻게 |
|---|---|---|
| 프롬프트 | 그래프 `3.inputs.text` | 한 문단. 태그 → 장르·용도 → 악기(2~4개) → 리듬·전개 → 분위기 → BPM → 믹스 질감 |
| 길이(초) | `5.inputs.seconds` | 1~1000(실제 출력은 요청값 ±0.05초). 편집 길이 + 여유 |
| 후보 수 | `5.inputs.batch_size` | 1~4 |
| 시드 | `6.inputs.seed` | 재현·비교 때 고정 |
| 저장 이름 | `8.inputs.filename_prefix` | `audio/<작품>/<방향>` |

프롬프트 문법(디노가 채택한 판의 실제 문장):

```text
TrackType: Music, VocalType: Instrumental. Cinematic luxury perfume commercial score at 100 BPM. Deep rounded sub bass pulses, intimate solo cello, shimmering glass bells and rich orchestral strings. A sparse mysterious opening develops into an elegant rhythmic crescendo with dramatic low drums and soaring strings, then resolves into a memorable warm final chord with a spacious reverb tail. A complete twenty-second miniature with a clear opening, powerful central reveal and graceful closing cadence. Sensual, dark, opulent and emotionally compelling, polished wide stereo sound.
```

- 길이를 문장에도 적는다(`A complete twenty-second miniature …`) — 마무리 화음·여운이 길이 안에 들어온다.
- 부정 프롬프트 칸은 비워 둔다. CFG 1.0에서는 부정 조건이 적용되지 않으므로, 원하지 않는 것은 긍정문으로 대체한다(`no vocals` 대신 `VocalType: Instrumental` + 악기 열거).
- 같은 뜻을 반복하지 않는다. 악기·전개·분위기·BPM이 한 번씩 있으면 충분하다.

## 실행 — 로컬(내 ComfyUI)

**첨부 —** `Deno Stable Audio 3 Medium BGM.json`(배포용 UI 워크플로, 8노드 + 모델 링크 노트) · `stable_audio3_medium_bgm.api.json`(에이전트용 API 그래프, 같은 배선·같은 값). `deno_knowhow_get`의 `files` 칸 주소로 받는다(로그인 없음, 판이 바뀌면 sha256도 바뀐다). 공개 리포 `Deno2026/deno-creator-skills`의 `workflows/stable-audio-3-bgm/`에 같은 파일이 거울로 있다(창고를 그대로 따라온다).

| 필요한 것 | 값 | 어디에 |
|---|---|---|
| 체크포인트 | `stable_audio_3_medium.safetensors`(약 9.2GB; Comfy-Org/stable-audio-3 재포장) | `models/checkpoints/` |
| 텍스트 인코더 | `t5gemma_b_b_ul2.safetensors`(같은 저장소) | `models/text_encoders/`(CLIPLoader 목록에 보이면 됨) |
| 노드 | ComfyUI 코어(`CheckpointLoaderSimple`·`CLIPLoader(type=stable_audio)`·`EmptyLatentAudio`·`KSampler`·`VAEDecodeAudio`·`SaveAudioMP3`) — 0.37 이상 | — |
| 라이선스 | Stability AI Community License(상업 사용은 stability.ai/license 확인) · T5Gemma는 Gemma 약관 | — |

샘플링은 공식 템플릿 값 그대로: **8스텝 · CFG 1.0 · lcm · simple · denoise 1**. 올리거나 내리지 않는다(증류판은 이 값에 맞춰져 있다).

API 그래프(자리표시자 셋: 프롬프트·길이·저장 이름; 시드는 `6`):

```json
{
  "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "stable_audio_3_medium.safetensors"}},
  "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "t5gemma_b_b_ul2.safetensors", "type": "stable_audio", "device": "default"}},
  "3": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": "REPLACE_WITH_ONE_PARAGRAPH_PROMPT"}},
  "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": ""}},
  "5": {"class_type": "EmptyLatentAudio", "inputs": {"seconds": 25.0, "batch_size": 1}},
  "6": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "positive": ["3", 0], "negative": ["4", 0], "latent_image": ["5", 0], "seed": 0, "steps": 8, "cfg": 1.0, "sampler_name": "lcm", "scheduler": "simple", "denoise": 1.0}},
  "7": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["6", 0], "vae": ["1", 2]}},
  "8": {"class_type": "SaveAudioMP3", "inputs": {"audio": ["7", 0], "filename_prefix": "audio/REPLACE_PROJECT/REPLACE_NAME", "quality": "V0"}}
}
```

- 접수·확인·회수는 `comfyui-agent-basics`와 같다(`/prompt` → `/history/<id>` → `/view`). 결과 파일명은 `<저장 이름>_00001.mp3`.
- 저장은 MP3 V0(디노 확정 2026-09-24, 무손실이 필요하면 `SaveAudio` FLAC으로 바꾼다).
- 확인은 잰 값으로: 길이(ffprobe), 최대·평균 음량, 10초 구간 RMS(끝까지 소리가 있는지). 템포는 계측해 적어 두면 편집 때 맞추기 쉽다.
- 처음 한 판은 모델 적재(콜드)가 포함돼 몇 초 더 걸리고, 그 뒤는 길이에 비례한다(아래 실측).

## 내 PC에 맞추기 — 16GB 카드 길이 사다리 (디노 실측 2026-09-27, RTX 4060 Ti 16GB · RAM 32GB)

같은 프롬프트·시드, 길이만 바꿈. 노드 상한 1000초까지 **모두 완주** — 16GB 카드의 한계는 메모리가 아니라 시간이다. 시간은 길이에 거의 비례하고(약 0.19초/초), 180초를 넘기면서 ComfyUI가 가중치를 램으로 내려 보내(피크가 낮아지고) 속도가 한 번 꺾인다.

| 길이 | 실행 시간 | VRAM 피크(1초 표본) | 실제 길이 | 파일 | 비고 |
|---:|---:|---:|---:|---:|---|
| 25초(콜드, 모델 적재 포함) | 6.5초 | 6.2GB | 25.03초 | 0.8MB | 첫 판 |
| 5초 | 1.6초 | 6.2GB | 5.04초 | 0.2MB | |
| 10초 | 1.7초 | 6.2GB | 10.06초 | 0.3MB | |
| 25초 | 2.5초 | 6.2GB | 25.03초 | 0.8MB | |
| 60초 | 5.8초 | 6.5GB | 60.03초 | 2.0MB | |
| 120초 | 15.1초 | 7.3GB | 120.03초 | 4.0MB | |
| 180초 | 29.9초 | 15.9GB | 180.04초 | 6.0MB | 16GB에 꽉 참 |
| 240초 | 57.6초 | 4.1GB* | 240.04초 | 7.8MB | 끝 10초가 −43dBFS(조용해짐 — 마무리인지 붕괴인지는 청취 판정) |
| 300초 | 62.0초 | 4.3GB* | 300.04초 | 9.6MB | 끝 10초 −40dBFS |
| 380초 | 73.5초 | 4.2GB* | 380.00초 | 12.6MB | 끝 10초 −41dBFS |
| 480초 | 89.8초 | 4.5GB* | 480.05초 | 15.7MB | 첫 10초 −34dBFS(조용한 도입) |
| 600초 | 113.2초 | 4.5GB* | 600.03초 | 19.7MB | |
| 800초 | 151.5초 | 4.7GB* | 800.00초 | 26.5MB | |
| 1000초(노드 상한) | 187.7초 | 4.9GB* | 1000.07초 | 33.4MB | 완주 |
| 25초 × 4후보(batch 4) | 8.0초 | 5.8GB | 25.03초 ×4 | 0.8MB ×4 | 후보당 2초 |

\* 180초 이후의 낮은 피크는 가중치가 램으로 내려간 상태의 표본값이다(1초 간격이라 순간 피크는 더 높을 수 있다). 모든 판이 10초 구간 RMS로 끝까지 소리가 있었고(−50dBFS 아래 구간 0), 평균 음량 약 −14dBFS, **최대 음량 0.0dBFS(풀스케일)** — 편집에서 리미터·게인을 거친다. 음악적 품질(특히 4분 이상)은 사용자가 듣고 판단한다.

- 스모크 테스트는 25초 한 판이면 충분하다(`comfyui-fit-my-pc` 절차). 길이는 VRAM보다 시간에 걸린다 — 위 표에서 내 길이의 시간을 본다.

## 함정 — 실측으로 확인된 것

- **연주곡 생성기라도 「목소리 없음」을 태그로 못 박아야 한다.** 무보컬 지시 없이 노래 생성 모델에 맡기면 숨소리·유사 보컬이 섞인다(디노 2026-08-21·28). 이 모델 + `VocalType: Instrumental`이 분리 경로다.
- 실제 길이는 요청값과 ±0.05초 차이(디코더·MP3 프레임). 편집에서 끝 1초를 자르는 것을 전제로 여유를 준다(디노 9/23: 20초 요청 → 19.97초, 끝 1초 제거해 채택).
- 부정 프롬프트는 CFG 1.0에서 무효다 — 칸을 채워도 달라지지 않는다.
- 스텝을 늘려도 좋아지지 않는다(증류판). 다르게 나오게 하려면 프롬프트나 시드를 바꾼다.
- 공식 학습 최대는 380초(medium)다 — 위 사다리처럼 1000초까지 돌긴 하지만 학습 범위 밖이다. 가사·보컬은 못 만든다(공식) — 나머지 실수 목록은 `stable-audio-3-prompting`.

## 디노는 이렇게 한다 — 예시 (참고이지 기준이 아니다)

- 디노 채널의 BGM 기본은 API(Suno)이고, **인트로·무보컬 짧은 곡은 이 로컬 경로**로 3~4갈래를 뽑아 귀로 고른다(2026-09-22·23). 후보에는 계측한 BPM을 붙인다.
- 길이는 인트로 20~25초, 애니 인트로 60초. 생성한 음악을 그대로 최종본에 얹지 않고 편집에서 자르고 페이드한다(음악·효과음 후반은 디노 몫).
- 만든 음악은 작품 폴더와 별개로 재사용 창고(`창작 BGM/<작품>_<날짜>`)에 원본을 복사해 둔다.
- 디노 PC(96GB)에서는 20초 한 곡이 4~5초(2026-09-22·23 실측, 모델 적재 뒤).

## 포함되지 않은 것

- 가사 있는 노래 생성, 상용 API 경로(지금은 로컬만), 디노의 장르 취향·채널별 음악 방향, 편집에서의 볼륨 믹스.
- `base` 판·`small` 판(HF 승인 필요)·CPU용 `optimized` 판 — 디노는 쓰지 않는다.

## 바뀐 점

- v3 (2026-09-27): 배포용 UI 워크플로와 API 그래프를 첨부로 실었다(`files`). 공개 리포 `workflows/stable-audio-3-bgm/`가 거울.
- v2 (2026-09-27): 짝 편 `stable-audio-3-prompting`(공식 가이드 기반 작법 전문 + 실수 목록) 연결, 효과음 태그를 공식 `TrackType: SFX`로, 공식 최대 380초·보컬 불가 함정 줄.
- v1 (2026-09-27): 첫 판. 디노 결정 「지금 쓰는 증류판(Medium)을 로컬 배경음으로, base는 안 씀」 + 16GB 서브PC 길이 사다리 실측.
