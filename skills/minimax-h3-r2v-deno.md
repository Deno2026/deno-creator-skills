---
slug: minimax-h3-r2v-deno
title: MiniMax H3 참고→영상(R2V)·시작 이미지→영상(FL2VA) — 디노의 현행 ComfyUI 워크플로(INT8 pruned + VDN 8스텝)
kind: workflow
tags: 미니맥스, minimax, h3, hailuo, r2v, ref2va, fl2va, flf2v, i2v, 참고 이미지, 시작 이미지, 캐릭터 시트, 영상 생성, comfyui, 오디오, 립싱크, 대사, vdn, 터보, 8스텝, int8, 워크플로, 화질, 초안, 1088p
models: MiniMax H3 Singularity Ref2VA Pruned v1.3 INT8, MiniMax H3 FL2VA pruned INT8, VDN 8-step turbo LoRA, Qwen3-VL 32B(H3), KJNodes
execution: local
version: 10
summary: 참고물(캐릭터 시트·장소 판·스타일 키·목소리 견본)로 새 장면을 만드는 R2V와, 독립 시작(·끝) 이미지를 정확한 첫 프레임으로 삼는 FL2VA를 같은 그래프 계약으로 돌리는 디노의 현행 워크플로. 한 번의 생성이 영상+스테레오 소리(대사·효과음)를 같이 낸다. 모드별 디퓨전·로라 한 쌍, 공통 체인, 화질 단계(초안·기본, R2V 1088p급 기본 7+1·액션 8+1), API 그래프 전문, 모델 배포처, 실측으로 확인된 함정.
---

# MiniMax H3 참고→영상(R2V)·시작 이미지→영상(FL2VA) — 디노의 현행 워크플로

이 꾸러미는 **그래프 계약과 진행 순서**를 준다. 무엇을 찍고 어떤 톤·연기 크기로 갈지는 사용자가 정한다.
디노가 고른 화질 값·1088p급 구성·길이 감각은 맨 아래 「디노는 이렇게 한다」에 예시로 두었다.

## 무엇을 만드나

- **R2V(Ref2VA)**: 참고물 — 캐릭터 시트(정체성), 장소 판(사람 없는 빈 공간), 소품, 스타일 키, 목소리 견본 — 을 바탕으로 **새 장면**을 만든다. 참고 이미지가 1장 이상 필요하다.
- **FL2VA/FLF2V**: 독립 시작 이미지 1장(선택으로 끝 이미지 1장)을 **정확한 첫(·끝) 프레임**으로 삼는 영상. 출력 화면비는 그 이미지가 정한다.
- 둘 다 5~15초, 24fps, **영상 + 네이티브 스테레오 소리**(대사·효과음·음악을 한 생성 안에서). 결과 예: 디노 채널의 실사풍 숏츠(2026-09-16 「카메라 꺼진 줄 알고 춤」 세로·가로), 드라마 클립 연속 10편(2026-09-25), 교육숏츠의 설명 클립(꾸러미 `education-shorts`).

## 목적

- 모드·디퓨전·로라·샘플러를 **한 쌍으로 고정**해 어떤 판이든 같은 그래프에서 시작한다. 판마다 바꾸는 것은 입력·길이·크기·시드뿐이다.
- 그래서 에이전트는 **참고물과 프롬프트**에 집중하고, 결과가 다르면 그 둘부터 본다.

## 진행 순서와 갈림길

### 0) 시작 — 사용자와 정해서 `BRIEF.md`에 적는다

- **모드**: 참고물로 새 장면을 만들면 R2V, 이 그림에서 정확히 시작해야 하면 FL2VA. 이어지는 장면에서 같은 장소·시간·미술 상태면 시작 이미지 하나로 길게, 장소·시간·큰 의상 상태가 바뀔 때만 새 시작 이미지.
- **길이**: 5~15초 격자(아래) 안에서 장면에 필요한 만큼. 배포 기준은 5~10초. 5초보다 짧은 원본은 만들지 않는다(짧은 컷은 긴 원본 안의 샷 전환·시간 점프로 만들고 편집에서 자른다).
- **화면비**(가로/세로는 두 변을 뒤집는다), **화질 단계**(초안 → 본 판, 고품질은 별도 꾸러미).
- 톤·연기 크기·리듬은 사용자. 상업 사용 여부는 모델 라이선스(MiniMax H3 Community License — 배포처 README)를 사용자가 확인한다.

### 1) 참고물

- R2V 참고 상한: 이미지 9·영상 3·오디오 3, 합쳐 12. 참고 영상·오디오는 클립당 2~15초, 합쳐 15초 이내. **오디오는 단독 투입이 안 된다** — 이미지 1장이 항상 같이 필요하다.
- 참고와 출력의 **화면비를 맞춘다**(세로 출력이면 세로 판). 캐릭터 시트는 정체성만 잡는다 — **참조만으로는 공간과 카메라가 서지 않는다**(디노 실측 2026-08-31: 공간+인물 참조만 넣은 판은 배경이 소실되고 카메라가 지시를 무시했다). 구도가 중요하면 첫 프레임 그림(앵커)을 `<Picture N>`으로 함께 넣고 그 임무를 프롬프트에 주거나, 코어 노드 `MiniMaxH3AddGuide`로 그 이미지를 프레임 0(끝은 -1)에 박는다(디노 실측 2026-09-23: 첫·끝 프레임이 그 이미지와 화소 단위로 같아지고 정체성은 유지).
- **생성된 영상의 프레임을 다음 판의 참고·시작 이미지로 넣지 않는다.** 장면 사이 연속성은 참고물과 상태 장부로 유지한다.
- FL2VA: 시작 이미지는 독립 자산 1장. 끝 이미지를 쓰면 `last_frame`에.

### 2) 프롬프트 — 공식 여섯 칸

- `subject_definitions → summary → retention_analysis → detailed_description → overall_soundscape → non_diegetic_music` 순서·이름 그대로. 작법·대사 문법·검사 항목은 꾸러미 `h3-prompt-six-fields`.
- 큐잉 전에 형식 검사를 스크립트로 돌린다(여섯 칸이 한 번씩 순서대로, `summary`가 `[과제 유형]`으로 시작, 첫 샷은 시각 없음·이후 샷 `At MM:SS.mmm`, 부정형 낱말, 화면 안 화자의 대사 밀도). 검사는 형식만 본다 — 통과가 곧 좋은 프롬프트는 아니다.
- **원하는 상태를 긍정형으로 지정한다.** 「하지 마라」는 무시되고 「이렇게 있어라」는 따른다(디노 실측 2026-08-29: `never turns to the camera`는 5샷 중 2샷이 정면, 샷마다 `still seen from behind`로 바꾸자 5샷 전부 이행).

### 3) 그래프 채우기 — 계약

**모드별 한 쌍(반드시 같은 모드끼리):**

| 모드 | `UNETLoader` 디퓨전 | `LoraLoaderModelOnly` 로라(강도 1.0) |
|---|---|---|
| R2V / Ref2VA | `Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors` | `minimax_h3_dmd_ref2va_8step_turbo_pruned.safetensors` |
| FL2VA / FLF2V | `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | `minimax_h3_dmd_fl2va_8step_turbo_pruned.safetensors` |

**공통 체인(모든 모드·모든 화질):**

```text
UNETLoader → ModelAttentionBackend(comfy kitchen attention) → LoraLoaderModelOnly(1.0) → MiniMaxH3SigmaShift(video 12, audio 3)
조건: MiniMaxH3ReferenceToVideo(prompt·참고·크기·length) → DenoTextEncoderUnload(text_encoder ← CLIPLoader; 조건은 그대로 통과시키고 인코더만 VRAM에서 내림) → BasicGuider
→ BasicGuider + BasicScheduler(simple, 8, denoise 1.0) + KSamplerSelect(euler) → SamplerCustomAdvanced(RandomNoise(seed))
→ VRAM_Debug(denoised_output; empty_cache·gc_collect·unload_all_models 모두 true) → VAEDecode(영상 VAE) + VAEDecodeAudio(오디오 VAE)
→ VHS_VideoCombine(h264, crf 15, 24fps, trim_to_audio false) → VHS_PruneOutputs(Intermediate and Utility)
```

- **어텐션은 Comfy Kitchen(ComfyUI 내장 INT8 어텐션)으로 통일한다(디노 확정 2026-09-26).** 기동 인자 `--use-ck-attention`으로 전역으로 켜고(NVIDIA SM 7.5 이상 = RTX 20·GTX 16 세대부터, AMD RDNA3 이상; 미지원 GPU에 인자를 넣으면 서버가 안 뜬다), 그래프에는 코어 노드 `ModelAttentionBackend(comfy kitchen attention)`을 둔다 — 인자를 빠뜨려도 그 모델은 Kitchen으로 가고, 못 쓰는 GPU에선 경고만 내고 PyTorch 어텐션으로 폴백한다. 외부 세이지 휠·KJ 패치 노드는 쓰지 않는다(디노 실측: 같은 장면에서 Kitchen이 세이지와 같은 시간·노이즈 없음, 2026-09-09·09-25).
- 시그마 이동(video 12 / audio 3)·Euler/simple 8스텝은 디노의 운용값이다. 로라 배포자가 보장한 최적값이라고 표현하지 않는다.
- 조건 노드: R2V는 `MiniMaxH3ReferenceToVideo`(`ref_image_size = max` — 정체성 보존 우선; `ref_images.ref_image_0…`, 선택 `ref_audios.ref_audio_0`, `ref_videos.ref_video_0` + `ref_video_audios.ref_video_audio_0`), FL2VA는 `MiniMaxH3ImageToVideo`(`first_frame`, 선택 `last_frame`). 프롬프트·`width`·`height`·`length`는 이 노드에 들어간다.
- **프레임 격자**: `length = max(124, 5 + round((초 × 24 − 5) / 17) × 17)` — 5초 124, 10초 243, 15초 362. 학습 범위가 124~362(약 5~15초)라 그 밖은 미검증. 크기는 32의 배수.
- 저장은 원본 한 개(오디오 포함 mp4)만 남긴다. 자르기·재인코딩·중복 mp4 없이 전달한다.
- 디코드 뒤에 다른 모델을 이어 쓰는 판은 VRAM_Debug가 먼저 모델을 내리므로 순서를 지킨다.

**화질 단계(같은 그래프, 크기와 뒷단만 다르다):**

| 단계 | 언제 | 구조 |
|---|---|---|
| 초안 | 방향·구도·대사 확인 | 낮은 크기에서 native 8스텝(R2V·FL2VA) |
| 기본 | 본 판 | 1MP급에서 native 8스텝(R2V·FL2VA) |
| 1088p급(R2V) | 큰 해상도가 필요할 때 | 같은 8스텝 일정을 `SplitSigmas(step 7)`로 갈라 앞 단계 → 영상 잠재만 `MinimaxH3LatentUpscaler3D`(`enable_chunking = true`) → 원래 오디오 잠재와 합쳐 마지막 1스텝. 구성은 기본(범용) 7+1과 액션 8+1 둘(아래 예시 상자). 배선은 꾸러미 `upscale-h3-4mp-5plus3` ① |

- **잠재 업스케일의 두 손잡이(사용 노하우, 디노 확정 2026-09-27)** — 큰 해상도를 잠재 업스케일로 만드는 구성(7+1·8+1)에는 조절 손잡이가 둘이다: ① **시작 해상도** ② **업스케일 배수**(= 최종 해상도).
  - 시작 해상도가 너무 낮으면 업스케일해도 디테일이 살지 않는다(디노 실측: 0.1MP 밑그림은 무지개 깜빡임·디테일 불합격 2026-08-26~27, 544 시작은 액션 잔상 2026-09-26). **짧은 변 768 근처에서 시작해야 최고 품질**이다. 544 시작 ×2(기본 7+1 → 1088p급)는 계산 시간 때문에 하는 타협(1088p 네이티브 8스텝의 절반).
  - 업스케일 뒤 단계는 **1스텝뿐**이지만, 그 1스텝의 어텐션이 최종 해상도 × 프레임 수에 비례해 VRAM을 먹는다 — 여기서 메모리 부족·기어감이 난다(디노 96GB도 15초 2560×1472의 마지막 1스텝은 별도 스트리밍 노드가 필요했다).
  - 그래서 **PC마다 배수를 조절해 최적값을 찾는다**: 시작 해상도를 먼저 정하고(그 PC에서 8스텝이 완주하는 가장 큰 크기, 되도록 768 근처) → 배수는 ×1.5부터(예 1344×768 → 2016×1152) → 되면 ×2 → 마지막 스텝이 안 되면 배수를 내리거나 길이를 줄인다. 잠재 업스케일러의 `enable_chunking`은 켠 채로. 정한 값은 `MY-PC.md`에 고정(`comfyui-fit-my-pc`).
- **크기·길이는 네 GPU에서 찾는다(사용 노하우, 디노 확정 2026-09-27)**: 스모크 테스트는 늘 **5초**·초안 크기(짧은 변 480, 예 864×480)에서 정본 그래프 그대로 돌려 완주·시간·VRAM 피크를 잰다. 되면 크기(480 → 768 → 1088p급) → 길이(5 → 10 → 15초) 순으로 한 칸씩 올리고, 안 되면 길이부터 내린다. 사다리를 다 돈 뒤 2~3안을 사용자에게 물어 정하고 `MY-PC.md`에 고정해 그 뒤로는 그 값으로만 돌린다 — 절차와 양식은 `comfyui-fit-my-pc`. 아래 예시 상자의 값은 디노 PC(96GB) 기준의 최고 품질 권장값이지 시작값이 아니다.
- 초안 판을 본 판의 재료로 쓰지 않는다(프레임 재주입 금지). 초안은 방향 확인용이고 본 판은 같은 참고·프롬프트로 다시 만든다.

### 4) 접수·회수

- 꾸러미 `comfyui-agent-basics`의 순서 그대로: 노드·모델 대조 → 참조 업로드 → 큐 비었나 → `/free {"unload_models": true}` → 접수 → `/history` → `/view`. 시드는 기본 무작위, 비교·재현 때만 고정하고 `상태.md`에 적는다.

### 5) 검수

- 콘택트 시트(시작·중간·끝)와 정상 속도 재생. 전 구간 노이즈(어텐션 노드 누락 증상), 얼굴·의상·장소가 전 프레임에서 같은가, 지시한 소품이 있는가(있어야 할 물건은 샷 서술에 위치까지 적어야 나온다), 상태가 컷 뒤에 되돌아가지 않았는가.
- 대사는 받아쓰기(목소리 분리 → 전사)로 존재만 확인하고, 립싱크·발음·품질은 사용자가 듣고 판정한다.
- 컷 시각: 앞 샷이 5초를 넘으면 뒤 컷이 1~1.3초 늦게 발화한다 — 원하는 시각보다 앞당겨 적는다(앞 샷이 짧으면 밀림 없음).
- 실패도 결과물이다. 어디가 어긋났는지(앵글·연속성·대사·소품) 적고 다음 판을 정한다.

### 갈림길

- **VRAM이 모자랄 때(16GB급)**: 짧은 변 480·5초에서 시작. 그래도 부족하면 크기·길이를 더 내린다(KJNodes `MiniMaxLowVRAMAttention` head 청킹은 세이지 시절 실측이고 Kitchen 경로에서는 피크가 같아 붙이지 않는다 — 디노 실측 2026-09-25).
- **소비자 GPU(Ampere 등)에서 평탄면에 격자·얼룩 무늬**: int8 양자화 커널의 아키텍처별 구현 차이다(디노 실측 2026-08-28, 소프트웨어 요인 전부 소거). 수용하거나, 전 층 풀정밀로 우회하면 무늬가 줄되 1.8배 느리다. 스텝을 바꾸는 것은 레버가 아니다(증류 로라는 증류된 스텝 수에서만 제 성능).
- **참고 영상을 무는 것**(모션 전이·영상 이어 만들기)은 시간이 폭증한다(5초 참고 +2분 40초, 10초 참고 34분 실측) — 참고는 이미지·오디오로. 모델이 혼자 못 하는 액션은 회색 상자·구로 만든 **프리비즈 영상**을 `<Video 1>`로 넣는 길이 있다(디노 실측 2026-09-23, 4/4).
- **더 큰 해상도**: 이 모델은 768급이 기본 해상도이고 공식 2K는 별도 재생성 모듈(로컬 미공개)이다. 로컬에서 키우는 두 길은 꾸러미 `upscale-h3-4mp-5plus3`.

## 내용 자리 — 사용자가 채우는 칸

| 칸 | 어디에 | 비고 |
|---|---|---|
| 모드·길이·화면비·화질 단계 | `BRIEF.md` | 0)에서 |
| 참고물(시트·장소 판·앵커·오디오) | `assets/` → `LoadImage`/`LoadAudio` | 독립 자산만 |
| 프롬프트(여섯 칸) | `scenes/<판>.txt` | 큐잉 전 형식 검사 |
| 크기·프레임 수·시드·저장 접두어 | 실행 그래프 | 시드는 `상태.md`에 |
| 판별 결과(무엇이 어긋났나) | `상태.md` | 실패도 기록 |

## 실행 — 로컬(내 ComfyUI)

**첨부 — 디노 정본 API 그래프 여섯**(같은 배선·같은 값, `REPLACE_`로 시작하는 자리표시자만 채운다): `minimax_h3_ref2va_pruned_vdn8_draft.api.json`(R2V 480p 초안) · `minimax_h3_ref2va_pruned_vdn8_native.api.json`(R2V 768 기본) · `minimax_h3_ref2va_pruned_vdn8_general7plus1.api.json`(R2V 1088p급 기본 7+1) · `minimax_h3_ref2va_pruned_vdn8_action8plus1.api.json`(R2V 1088p급 액션 8+1) · `minimax_h3_fl2va_pruned_vdn8_draft.api.json`(FL2VA 480p 초안) · `minimax_h3_fl2va_pruned_vdn8_native.api.json`(FL2VA 768 기본). `deno_knowhow_get`의 `files` 칸 주소로 받는다(로그인 없음, 판이 바뀌면 sha256도 바뀐다). 공개 리포 `Deno2026/deno-creator-skills`의 `workflows/minimax-h3-r2v-deno/`에 같은 파일이 거울로 있다(창고를 그대로 따라온다). 아래 본문의 그래프는 그중 R2V 기본을 풀어 쓴 것이고, 1088p급 둘의 배선 설명은 `upscale-h3-4mp-5plus3`에 있다.

**첨부 — 도구 넷(파이썬 3.10+, 표준 라이브러리만, 정본 그래프와 같은 폴더에 둔다):** `h3_prompt_lint.py`(공식 여섯 칸 형식 검사 — 제출 전에 반드시, 오류 0이어야 큐잉) · `queue.py`(참고 이미지 업로드 + 정본 그래프 큐잉: `--quality draft|standard|general|action`, `--duration` 5~15, `--ref` 1~9장, `--ref-video`·`--ref-audio`, `--ratio`, `--prefix`) · `h3_vdn.py`(`queue.py`가 쓰는 정본 그래프 빌더 — 모드·화질·크기(32의 배수)·프레임 격자(17k+5) 검사; 그래프는 같은 폴더에서 읽는다) · `lightx_i2v.py`(FL2VA 발사기 — 독립 시작 이미지 1장·끝 이미지 선택, 형식 검사 → 접수 → 대기 → 결과 기록까지; `--comfy-root`는 로라 파일 확인용 선택). 그래프 안 로라 경로 `H3_R2V_AB\…`는 디노 폴더명이니 자기 `models/loras/` 하위 폴더명으로 바꾸거나 같은 이름 폴더를 둔다.


| 종류 | 파일 | 넣는 곳 | 받는 곳(2026-09-26 파일 목록 확인) |
|---|---|---|---|
| R2V 디퓨전 | `Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors`(약 21GB) | `models/diffusion_models/` | `https://huggingface.co/WarmBloodAban/Minimax-h3_Singularity` |
| FL2VA 디퓨전 | `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | `models/diffusion_models/` | `https://huggingface.co/Comfy-Org/MiniMax-H3` |
| 터보 로라(모드별) | `experimental/minimax_h3_dmd_ref2va_8step_turbo_pruned.safetensors` · `experimental/minimax_h3_dmd_fl2va_8step_turbo_pruned.safetensors` | `models/loras/`(하위 폴더는 자유) | `https://huggingface.co/drbaph/MiniMax-H3-Turbo-Lora-ComfyUI` — VDN 8-step 추출, 배포자가 experimental로 표기 |
| 텍스트·비전 인코더 | `qwen3vl_32b_minimax_h3_int8_convrot.safetensors`(약 27GB) | `models/text_encoders/` | Comfy-Org/MiniMax-H3 |
| 영상 VAE | `minimax_h3_video_vae_fp16.safetensors`(약 5GB) | `models/vae/` | Comfy-Org/MiniMax-H3 |
| 오디오 VAE | `minimax_h3_audio_vae_fp32.safetensors`(약 0.6GB) | `models/vae/` | Comfy-Org/MiniMax-H3 |
| 잠재 업스케일러(1088p급만) | `minimax_h3_latent_upscaler_3d_bf16.safetensors` | `models/latent_upscale_models/` | 꾸러미 `upscale-h3-4mp-5plus3` |
| 노드 | ComfyUI 코어(H3 노드 — `MiniMaxH3ReferenceToVideo`·`MiniMaxH3ImageToVideo`·`MiniMaxH3SigmaShift`·`MiniMaxH3AddGuide`) · `ModelAttentionBackend`) · `kijai/ComfyUI-KJNodes`(`VRAM_Debug`) · VideoHelperSuite(`VHS_VideoCombine`·`VHS_PruneOutputs`) · 1088p급 액션만 `Zironic/H3-Optimizations`(`H3MemoryOptimization`) | | |
| 실행 환경 | ComfyUI(코어 H3 지원은 0.30 이상, comfy-kitchen 동봉). 기동 인자에 `--use-ck-attention`(데스크탑은 Manage → Startup Args, 포터블은 배치 파일) | | |

- Singularity 베이스는 디노가 같은 프롬프트·참조·시드·로라·샘플러·크기에서 기본 pruned와 비교한 뒤 고른 것이다(2026-09-26). 기본 pruned `minimax_h3_ref2va_pruned_int8_convrot`(Comfy-Org)도 같은 계약으로 돈다 — 파일명만 바꾸면 된다.
- 아래 그래프의 크기 노드 `140`은 디노 커스텀 노드 `(Deno) Resize Box`(`DenoResolutionSetup`, GitHub Deno2026/comfyui-deno-custom-nodes)다. 없으면 노드 `7`의 `width`·`height`에 32의 배수 숫자를 직접 넣는다.
- **노드 `220` `DenoTextEncoderUnload`(같은 팩)는 조건 인코딩이 끝난 자리에서 텍스트 인코더(H3의 32B 인코더, INT8로도 약 21GB)를 VRAM에서 내리는 관문이다** — 조건은 그대로 통과하고 결과는 바이트 단위로 같다(디노 실측 2026-09-25: 15초 1088p 피크 88 → 62GB). 작은 VRAM에서 특히 효과가 크다. 디노 정본 6개 전부의 고정값(2026-09-27). 팩이 없으면 `9.conditioning`을 `["7", 0]`으로 직접 잇는다 — 대신 인코더가 샘플링 내내 VRAM에 남는다.

API 그래프 — R2V 기본(참고 1장, 자리표시자 셋: 프롬프트·참고 파일명·저장 접두어; 크기는 `140`, 프레임 수는 `7.length`, 시드는 `8`):

```json
{
  "1": {"class_type": "UNETLoader", "inputs": {"weight_dtype": "default", "unet_name": "Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors"}},
  "100": {"class_type": "ModelAttentionBackend", "inputs": {"model": ["1", 0], "attention": "comfy kitchen attention"}},
  "2": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["100", 0], "lora_name": "minimax_h3_dmd_ref2va_8step_turbo_pruned.safetensors", "strength_model": 1.0}},
  "104": {"class_type": "MiniMaxH3SigmaShift", "inputs": {"model": ["2", 0], "shift_video": 12.0, "shift_audio": 3.0}},
  "3": {"class_type": "CLIPLoader", "inputs": {"type": "minimax", "device": "default", "clip_name": "qwen3vl_32b_minimax_h3_int8_convrot.safetensors"}},
  "4": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
  "5": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
  "6": {"class_type": "LoadImage", "inputs": {"image": "REPLACE_WITH_REFERENCE_IMAGE.png"}},
  "140": {"class_type": "DenoResolutionSetup", "inputs": {"mode": "Manual Input", "ratio_preset": "16:9", "megapixels": 1.0, "width": 1344, "height": 768, "divisible_by": "32", "resize_method": "Center Crop (Fill)", "interpolation": "lanczos"}},
  "7": {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": {"prompt": "REPLACE_WITH_H3_SIX_SECTION_PROMPT", "ref_image_size": "max", "clip": ["3", 0], "vae": ["4", 0], "audio_vae": ["5", 0], "width": ["140", 1], "height": ["140", 2], "length": 243, "ref_images.ref_image_0": ["6", 0]}},
  "8": {"class_type": "RandomNoise", "inputs": {"noise_seed": 1}},
  "220": {"class_type": "DenoTextEncoderUnload", "inputs": {"positive_conditioning": ["7", 0], "text_encoder": ["3", 0]}, "_meta": {"title": "Unload H3 Text Encoder Before Sampling"}},
  "9": {"class_type": "BasicGuider", "inputs": {"conditioning": ["220", 0], "model": ["104", 0]}},
  "102": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
  "103": {"class_type": "BasicScheduler", "inputs": {"model": ["104", 0], "scheduler": "simple", "steps": 8, "denoise": 1.0}},
  "10": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["8", 0], "guider": ["9", 0], "sampler": ["102", 0], "sigmas": ["103", 0], "latent_image": ["7", 1]}},
  "130": {"class_type": "VRAM_Debug", "inputs": {"any_input": ["10", 1], "empty_cache": true, "gc_collect": true, "unload_all_models": true}},
  "11": {"class_type": "VAEDecode", "inputs": {"vae": ["4", 0], "samples": ["130", 0]}},
  "12": {"class_type": "VAEDecodeAudio", "inputs": {"vae": ["5", 0], "samples": ["130", 0]}},
  "120": {"class_type": "VHS_VideoCombine", "inputs": {"images": ["11", 0], "audio": ["12", 0], "frame_rate": 24.0, "loop_count": 0, "filename_prefix": "REPLACE_WITH_JOB_PREFIX", "format": "video/h264-mp4", "pix_fmt": "yuv420p", "crf": 15, "save_metadata": true, "trim_to_audio": false, "pingpong": false, "save_output": true}},
  "160": {"class_type": "VHS_PruneOutputs", "inputs": {"filenames": ["120", 0], "options": "Intermediate and Utility"}}
}
```

- 참고를 더 넣으려면 `LoadImage`를 복제해 `7`의 `ref_images.ref_image_1`, `…_2`에 잇는다(넣은 순서가 `<Picture N>` 번호). 오디오 견본은 `LoadAudio` → `ref_audios.ref_audio_0`.
- **FL2VA로 바꾸려면**: `1`의 디퓨전과 `2`의 로라를 FL2VA 쌍으로, `7`을 `MiniMaxH3ImageToVideo`(`first_frame` ← `6`, 선택 `last_frame` ← 끝 이미지 `LoadImage`)로. 나머지는 같다. FL2VA는 초안·기본 두 화질로 쓴다(잠재 업스케일 1088p급 구성은 R2V 전용).


## 함정 — 모델 사실(디노 실측)

- **같은 구도로 시간 경과를 컷으로 넘기면 「중간이 뚝 끊긴 사고」로 읽힌다.** 시간 경과가 사건인 장면은 컷 없이 한 테이크로 변화를 연속 이동으로 서술하고, 컷이 필요하면 앵글·크기를 확 바꾼다(2026-08-16 교정 검증).
- **화면에 있어야 할 물건은 샷 서술에 위치까지 적는다**(참조 앵커에 그려 뒀어도 모델이 새로 그리므로 빠질 수 있다). 빼야 할 물건은 어디에도 언급하지 않는다 — 언급하면 만들어 낸다.
- **립싱크 밀도**: 화면 안 인물의 대사는 6초당 한 줄 수준. 넘기면 초반 립싱크가 빠진다.
- **소리 지시가 없으면 모델이 엉뚱한 언어의 내레이션을 지어낸다.** `overall_soundscape`에 들리는 소리를 세어 적고, 필요한 배타 선언 한 번(존재하는 소리 열거 + 목소리 없음)으로 막는다.
- **참고 소리 길이를 넘어서는 음악은 그 시각에서 붕괴한다** — 재료가 떨어지는 것이라 지시로 못 막는다. 출력을 참고 소리 안으로, 또는 음악은 편집에서.
- **스토리보드 페이지를 통째로 참고에 넣으면 정지 컷의 연기가 굳는다.** 보드 칸은 「샷의 끝 키프레임」으로 작동하고, 보드는 참고 순서의 마지막에 둔다(첫 참고로 올리면 칸 속 소품이 샷 시작에 복제된다).
- **빠른 접촉 동작(킥 등)은 문장·보드로는 안 되고 프리비즈 영상 참조로 된다.** `in slow motion`은 동작을 되풀이·정지시킨다.
- **긴 판에서 전 구간 노이즈**가 나오면 어텐션 경로부터 본다(세이지 시절 전역 인자만 켠 판에서 났던 증상). 그래프에 Kitchen 노드가 있는지, 기동 로그에 「Using Comfy Kitchen attention」이 찍혔는지.
- 프롬프트 글자 수 제한은 로컬에 없다(인코더에 그대로 들어간다). 7천 자 제한은 유료 API 쪽 규격이다.

## 디노는 이렇게 한다 — 예시 (참고이지 기준이 아니다)

- **화질**(가로 기준, 세로는 뒤집는다): 초안 864×480 · 기본 1344×768(두 모드), 큰 해상도는 아래 R2V 1088p급 둘. 기본 768을 픽셀 수에 맞추려고 736으로 내리지 않는다.
- **1088p급 작품용 구성 둘**(2026-09-26 확정, R2V 전용): 기본(범용) = 960×544에서 앞 7스텝 → 영상 잠재 ×2 → 1920×1088에서 마지막 1스텝(`SplitSigmas step 7`) + 스타일 로라 Authentic Cinematic Texture 0.6(0.7은 조금 진하다) / 액션·빠른 장면 = 1344×768에서 8스텝을 끝까지 → 잠재 ×1.5 → 2016×1152에서 같은 일정의 마지막 한 칸만 1스텝. 액션은 기초 해상도가 768급이어야 잔상이 덜하고 표현이 정확하다(544 시작 구성을 쓰지 않는다). 1920×1088 네이티브 8스텝보다 계산 시간이 절반인 타협점이고, 같은 장면·시드의 768 네이티브 8스텝과 SSIM 0.904. 이 두 구성도 같은 Kitchen 노드이며, 2016×1152급 마지막 스텝은 스트리밍 청킹 노드(`H3MemoryOptimization`, Forced)를 별도 체인으로 쓴다.
- **길이 감각**: 10~15초가 안정권, 사건이 적으면 5~10초. 15~20초는 되지만 비추천, 20초를 제작 상한으로. 30초 판은 파일은 나와도 15초 이후 샷 지시를 무시했다. 긴 서사는 여러 생성으로.
- **참고 운용**: 참고 최대 9장 안에서 인물 캐스팅(얼굴·헤어)·차량·핵심 소품·공간 시트·오디오(목소리·말속도) 네 역할만 잠근다. 같은 참고 묶음을 샷마다 유지한다. 배경·구도·카메라를 잡을 때는 샷별 설명을 넣은 보드 한 장을 마지막 참고로.
- **스타일 로라 후보**(요청받은 비교에서만): Authentic Cinematic Texture(Civitai 모델 2890588, 트리거 `DY`), Realism People(`fal/MiniMax-H3-Realism-People-LoRA`, 트리거 `r34l1sm`). 기본으로 넣는 것은 1088p급 기본 구성의 시네마틱 0.6뿐.
- **참고 실측(96GB 카드, 15초·362프레임)**: 1344×768 native 8스텝 약 7분 반(457초), 1088p급 기본 7+1 약 6분 반(390~412초, 2026-09-25), 액션 8+1 약 12분 반(750초, 2026-09-26), 1920×1088 native 8스텝 약 26분(1,541초). 배수를 올려 15초·2560×1472까지 가면 마지막 스텝이 Kitchen도 stride 한계(int32)에 걸려 스트리밍 청킹 노드(`H3MemoryOptimization`)로 돌린다(2026-09-25 실측 1,025초). 16GB 카드는 10초·1MP 약 17분(2026-09-03, 당시 가속 로라 구성) — 그 카드로는 초안·짧은 판 위주.
- 검수는 콘택트 시트 + 정상 재생 + 발화 전사(Mel-Band RoFormer 분리 → Whisper large-v3). 품질 판정은 디노가 한다.

## 포함되지 않은 것

- 디노의 장비 배분·2차 가공(마감) 스크립트와 로컬 LLM 프롬프트 정제 경로 — 디노 환경 고유.
- 스타일 로라 파일, 디노 작품의 프롬프트·참고물.

## 바뀐 점

- v10 (2026-09-27): 도구 넷 첨부(`h3_prompt_lint.py`·`queue.py`·`h3_vdn.py`·`lightx_i2v.py`) — 디노 「편리한 도구는 다 넣어 준다, 취향이 아니라 축적된 노하우」. 장비 주소·설치 경로는 인자·환경변수로 뺐다.
- v9 (2026-09-27): 정본 API 그래프 여섯(초안·기본·1088p급 7+1·액션 8+1·FL2VA 둘)을 첨부로 실었다(`files`). 공개 리포 `workflows/minimax-h3-r2v-deno/`가 거울 — 디노 「공개 리포와 MCP 가이드는 항상 동기화」.
- v8 (2026-09-27): 5+3 은퇴(디노 확정) — 화질은 초안·기본(두 모드)과 R2V 1088p급 기본 7+1·액션 8+1. 고품질 5+3 줄, FL2VA 5+3 재인코딩 안내, 5+3 실측을 빼고 7+1·8+1 실측을 넣었다.
- v7 (2026-09-27): 텍스트 인코더 선제 해제(`DenoTextEncoderUnload` 220)를 그래프에 넣음 — 디노 정본 8개 전부의 고정값(디노 승인). 체인·API 그래프·노드 설명 갱신.
- v6 (2026-09-27): 잠재 업스케일의 두 손잡이(시작 해상도·배수) — 768 근처 시작이 최고 품질, 낮은 시작은 업스케일 효과 저하, 1스텝 업스케일 단계의 VRAM은 최종 크기×프레임에 비례하니 PC마다 배수 조절(디노 확정).
- v5 (2026-09-27): 사용 노하우 — 스모크는 5초·초안 크기, 사다리로 올리고 사용자와 정해 `MY-PC.md`에 고정(`comfyui-fit-my-pc`). 디노 값은 디노 PC 기준 권장값이라고 명시.
- v4 (2026-09-26 밤): 어텐션을 Comfy Kitchen으로 통일(디노 확정) — 그래프의 세이지 KJ 노드를 코어 `ModelAttentionBackend(comfy kitchen attention)`으로, 기동 인자 `--use-ck-attention`, 실행 환경·함정·예시 갱신. 세이지 휠 불필요.
- v3 (2026-09-26 밤): 상용(DenoMCP) 절을 뺐다 — 지금은 로컬 파이프라인 복제만(디노).
- v2 (2026-09-26): 그래프를 **INT8 pruned + VDN 8스텝**(디노 확정 2026-09-24, R2V 베이스 Singularity 2026-09-26)으로 바꿨다. v1의 알리바바 Acc-8Step 전용 로더 + Sol 희소 어텐션 그래프는 은퇴(재현용 기록). FL2VA 갈래, 세 가지 화질, 모델 배포처, 실측 함정을 더하고 도화지 순서(순서·갈림길·내용 자리·실행·예시)로 옮겼다.
- v1 (2026-09-17): 첫 판(Acc-8Step 1MP 그래프, 로컬/상용 두 갈래).
