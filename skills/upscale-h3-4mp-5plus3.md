---
slug: upscale-h3-4mp-5plus3
title: 업스케일 두 방법 — H3 1088p급 잠재 업스케일(7+1·8+1)과 LTX 2.5 MSR 리파인(×1.5)
kind: technique
tags: 업스케일, upscale, 잠재, latent, 1088p, 7+1, 8+1, LTX, MSR, 리파인, 디테일, 해상도, 오디오 보존
models: MiniMax H3 Ref2VA, MinimaxH3LatentUpscaler3D, LTX 2.5, LTX-2.5 MSR IC-LoRA
execution: local
version: 6
summary: 만든 영상의 해상도·디테일을 올리는 디노의 두 방법. ① 같은 생성 안에서 앞 단계 → 3D 잠재 업스케일(기본 ×2·액션 ×1.5) → 같은 8스텝 일정의 마지막 1스텝(H3 R2V, 오디오 잠재가 함께 간다) ② 이미 있는 mp4를 LTX 2.5가 1.5배로 다시 그리는 리파인(참조 시트로 인물을 붙잡고 오디오는 원본 트랙). 언제 무엇을 쓰는지, 배선 계약, 모델 배포처.
---

# 업스케일 두 방법

이 꾸러미는 **언제 무엇을 쓰는지와 배선 계약**을 준다. 얼마나 키울지·어느 판을 본 판으로 삼을지는 사용자가 정한다.

## 무엇을 만드나

- 픽셀 업스케일러(ESRGAN류)로 늘리면 디테일이 안 생긴다. 디노는 **잠재 공간에서 다시 그리는** 두 방법을 쓴다.

| | ① H3 1088p급 잠재 업스케일(7+1·8+1) | ② LTX 2.5 MSR 리파인 |
|---|---|---|
| 언제 | H3 R2V로 **새로 만들 때** 처음부터 큰 해상도가 필요할 때 | **이미 만든 mp4**(H3 결과 등)의 디테일을 올릴 때 |
| 무엇이 바뀌나 | 같은 시드·프롬프트로 앞 단계(기본 7스텝 / 액션 8스텝 전부)를 작은 크기에서 그리고, 그 결과를 3D 잠재 업스케일러로 키워(기본 ×2 / 액션 ×1.5) 같은 8스텝 일정의 마지막 한 칸을 1스텝으로 마저 그린다 | 영상을 잠재로 인코드 → ×1.5 잠재 업샘플 → 참조 이미지로 인물을 붙잡고 3스텝 리파인 |
| 오디오 | 같은 생성 안이라 오디오 잠재가 함께 간다(업스케일러에는 안 넣고 비켜 간다) | 원본 오디오 트랙을 그대로 얹는다(오디오 잠재는 마스크 0으로 얼림) |
| 결과 예 | 디노 드라마 클립 1920×1088·15초 연속 10편(2026-09-25), 액션 2016×1152(2026-09-26) | H3 1344×768 → 2016×1152 리파인(2026-09-10) |

## 목적

- ①은 **모델이 스스로 다시 그리게** 해서 얼굴 윤곽·머리카락·질감이 살아난다(같은 시드로 큰 캔버스에 그냥 8스텝을 돌리면 작은 판을 늘린 것과 같다 — 디노 실측 2026-09-09).
- ②는 구도·움직임·인물은 원본 잠재가, 얼굴·의상은 참조 시트가 잡아 **다른 사람이 되지 않게** 키운다.

## 진행 순서와 갈림길

1. 사용자와 정한다: 새로 만드는 판인가(①) 이미 있는 mp4인가(②), 목표 크기(네 GPU에서 5초부터), 어느 판을 본 판으로.
2. ①은 `minimax-h3-r2v-deno`의 그래프에서 뒷단만 바꾼다. ②는 mp4·참조 시트를 준비한다(시트는 출력과 같은 화면비 계열이면서 출력보다 큰 변이 없게 — 그래야 센터 크롭에 안 걸린다).
3. 접수·회수는 `comfyui-agent-basics`. ②는 영상과 오디오를 LTX에 넣기 전에 **같은 길이(8n+1 격자)로 먼저 자른다.**
4. 검수: 점·흉터·작은 표식이 증식하지 않았나(②의 배율 함정), 얼굴이 같은 사람인가, 오디오가 원본과 같은가(파형 상관), 꼬리 프레임.

갈림길: 인물이 크게 잡히는 판은 ②에서 ×1.5를 먼저 본다(×2는 표식이 없는 소재나 인물이 작은 판). 액션·빠른 장면은 ①에서 시작 크기를 768급으로(작게 시작하면 잔상이 남는다). VRAM이 모자라면 ①의 배수를 내리거나 길이를 줄인다 — 5초 완주가 먼저.

## ① H3 1088p급 잠재 업스케일(7+1·8+1) — 배선 계약

`minimax-h3-r2v-deno`의 공통 체인(디퓨전 + Kitchen 어텐션 노드 + VDN 로라 + 시그마 이동 12/3, `BasicScheduler(simple, 8, 1.0)`, euler)에서 샘플러 뒤를 이렇게 바꾼다. **같은 8스텝 일정을 7에서 자른다** — 스텝 수·분할점을 새로 만든 일정(6+3·15+5)으로 바꾸지 않는다(디노 A/B 2026-09-11: 학습된 8스텝 일정을 그대로 쓴 쪽이 나았다).

```text
BasicScheduler(simple, 8, 1.0) → SplitSigmas(step 7)                      ← 시그마 값은 스케줄러가 낸다(손으로 적지 않는다)
1차 SamplerCustomAdvanced(euler, 시작 크기) — 기본: 앞 7스텝(SplitSigmas 출력 0) / 액션: 8스텝 전부(BasicScheduler 출력 그대로)
→ LTXVSeparateAVLatent(1차 출력 1 = denoised_output — 출력 0(노이즈 낀 잠재)이 아니다)
→ MinimaxH3LatentUpscaler3D(minimax_h3_latent_upscaler_3d_bf16, scale by multiplier 기본 2.0 / 액션 1.5, align 32, enable_chunking = true)   ← 영상 잠재만
→ LTXVConcatAVLatent(업스케일 영상 잠재 + 원래 오디오 잠재)
2차 SamplerCustomAdvanced(euler, 같은 RandomNoise, 마지막 1스텝 = SplitSigmas 출력 1)
→ VRAM_Debug(모두 true) → VAEDecode / VAEDecodeAudio(2차 출력 1) → 저장(h264 crf 15)
```

- 2차 가이더: 기본은 1차와 같은 모델 체인·가이더. 액션은 2016×1152급 마지막 스텝의 메모리를 위해 같은 UNET에서 `UNET → VDN 로라 → 시그마 이동 → H3MemoryOptimization(qkv_streaming_mode Forced)` 체인을 따로 만들어 그 가이더를 쓴다(희소 어텐션이 아닌 full-density 청킹).
- 1차 크기 = 최종 ÷ 배수(예: 기본 가로 960×544 → 1920×1088, 액션 1344×768 → 2016×1152; 세로는 뒤집는다). 시작 크기는 사용자 GPU에서 찾는다.
- `enable_chunking = true`(디노 확정 2026-09-25): 잠재 시간축이 길면 24씩 나눠 겹쳐 합산한다. 업스케일 단계의 피크 메모리를 크게 줄이고(15초 실측 20GiB), 전체 시간 문맥 경로와 픽셀 동일은 아니지만 최종 영상은 SSIM 0.988로 같은 장면·동작이었다. 로그의 `temporal chunking`은 이 단계이며 샘플러 어텐션 청킹이 아니다.
- 디노 정본에서 ①은 R2V 전용이다. FL2VA는 초안·기본 두 화질로 쓴다.
- 저장은 마스터 화질로(예: h264 crf 15). 스트리밍급 기본 저장은 큰 해상도의 디테일을 뭉갠다.
- **네 GPU에서 되는지부터**: 5초에서 목표 크기 완주를 확인한 뒤 길이를 늘린다. 참고: 96GB 카드에서 15초 1088p급은 피크 약 50~55GB로 완주하고, 배수를 올려 15초 2560×1472까지 가면 마지막 스텝이 Kitchen도 stride 한계에 걸려 그 스텝만 스트리밍 청킹 체인으로 돌린다(`minimax-h3-r2v-deno` 예시 상자).

## ② LTX 2.5 MSR 리파인 — 배선 계약

```text
UNETLoader(ltx-2.5-22b-dev-transformer-bf16) → LoraLoaderModelOnly(distilled-lora-450, 0.5)
→ ComfyUILTX25MSRICLoRALoader(LTX-2.5-Licon-MSR-V1, 1.0) → ModelAttentionBackend(comfy kitchen attention) → LTXVDualCFGGuider(1/1)
LoadVideo → GetVideoComponents → ImageFromBatch(8n+1 프레임 격자) → VAEEncode(Conv 영상 VAE) → LTXVLatentUpsampler(LTX-2.3 ×1.5)
→ ComfyUILTX25MSRMultiReferenceGuide(참조 시트 pic1…, reference_frames 33, strength 1.0) → LTXVConditioning(24)
GetVideoComponents.audio → LTXVAudioVAEEncode → SetLatentNoiseMask(SolidMask 0) → LTXVConcatAVLatent(audio_latent)
SamplerCustomAdvanced(euler, ManualSigmas 0.85 / 0.7250 / 0.4219 / 0) → VRAM_Debug(모두 true) → LTXVSeparateAVLatent → LTXVCropGuides → VAEDecode(일반)
GetVideoComponents.audio → TrimAudioDuration(length ÷ 24) → CreateVideo(images + 원본 오디오) → SaveVideo
```

- 참조 시트가 인물을 붙잡는다 — 리파인 뒤 얼굴이 다른 사람이 되는 것을 막는 핵심. 프롬프트에서 `Image 1:`로 참조를 호명하고 무엇을 맡는지 밝힌다(LTX 규격, `ltx25-official-defaults` 3).
- **배율 ×1.5 고정.** ×2에서는 볼의 점 하나가 얼룩 3~4개로 증식했고 ×1.5에서는 그대로였다(같은 영상·시드, 2026-09-08). 시간도 절반.
- 오디오는 마스크 0으로 얼려 모델이 다시 그리지 않게 하되, LTX 오디오 VAE 왕복 자체는 파형을 보존하지 않으므로(말소리가 입과 어긋나 보인다) **최종 파일은 원본 오디오 트랙**을 얹는다. 위 배선은 ComfyUI 안에서 원본 오디오를 바로 합친다.
- 샘플러 뒤 `LTXVCropGuides`를 반드시 — 참조가 토큰으로 앞에 붙어 그대로 디코드하면 화면에 남는다.
- 시그마·CFG·참조 프레임 수는 레시피이니 그대로. 샘플러는 `euler`(벤더의 `euler_ancestral`은 흐려진다 — 디노 판정).
- 프레임 8n+1은 격자 규칙이지 권장 길이가 아니다(예 10초 241).
- 디코드는 Conv VAE + 일반 `VAEDecode`, 앞에 `VRAM_Debug`(`ltx25-official-defaults` 2).

## 내용 자리 — 사용자가 채우는 칸

| 칸 | 어디에 |
|---|---|
| 목표 크기(①: 시작 크기·배수 / ②: 배율) | 실행 그래프 |
| ② 입력 mp4·참조 시트 | `renders/` · `assets/` |
| 시드(①은 1차와 같은 노이즈) | `상태.md` |

## 실행 — 로컬(내 ComfyUI)


| 종류 | 파일 | 받는 곳 |
|---|---|---|
| ① 잠재 업스케일러 | `minimax_h3_latent_upscaler_3d_bf16.safetensors`(690,592,992바이트) → `models/latent_upscale_models/` | 공식 저장소(MiniMaxAI·Comfy-Org·Kijai)에는 없고 커뮤니티 재배포본만 있다. 디노 파일과 **바이트까지 같은** 것(2026-09-26 허깅페이스 파일 해시 대조): `https://huggingface.co/Konteni2/Minimax_h3_latent_Upscaler`·`https://huggingface.co/PixelAlchemist123/Minimax_h3_latent_Upscaler`의 같은 이름 파일(`LBH-123-AI`·`b-rosel`의 `…_3d_conv_v1_bf16`도 같은 바이트). 받은 뒤 SHA256 `4f57821f5837f32f7142b67d815606dbd7550f194e5c769f7d6c3f83b146a5e6`로 대조한다 |
| ① 나머지 | `minimax-h3-r2v-deno`의 모델 표 그대로(액션의 후반 체인은 `Zironic/H3-Optimizations`의 `H3MemoryOptimization` 노드도 필요) | |
| ② 모델 | `Lightricks/LTX-2.5`(dev 트랜스포머·디스틸 로라 450·텍스트 인코더·Conv 영상 VAE·오디오 VAE), `Lightricks/LTX-2.3`(`ltx-2.3-spatial-upscaler-x1.5-1.0` — 2.5 잠재와 규격이 같아 그대로 돈다; 2.5에는 ×2·시간 ×2만 있다), `LiconStudio/LTX-2.5-Multiple-Subject-Reference`(MSR LoRA V1 — 2.5용은 V1뿐) | 허깅페이스(LTX-2.5는 약관 동의) |
| ② 노드 | `liconstudio/ComfyUI-LTX2.5-MSR`, `kijai/ComfyUI-KJNodes`, ComfyUI 코어 LTX 노드 | |


## 디노는 이렇게 한다 — 예시 (참고이지 기준이 아니다)

- ① 구성 둘(R2V, 2026-09-26 확정): 기본(범용) = 960×544에서 7스텝 → ×2 → 1920×1088 마지막 1스텝, 스타일 로라 Authentic Cinematic Texture 0.6을 VDN 로라 뒤에 / 액션·빠른 장면 = 1344×768에서 8스텝 → ×1.5 → 2016×1152 마지막 1스텝. 세로는 뒤집는다. 고화질 요청은 이 둘로 받고, 액션이 아니면 기본. 업스케일러는 위 표의 SHA256과 같은 파일을 세 PC에 두고 manifest로 대조한다.
- **두 손잡이(디노 확정 2026-09-27)**: ①의 품질은 **시작 해상도**가 정하고(짧은 변 768 근처가 최고, 너무 낮으면 업스케일해도 디테일이 안 산다 — 544 시작 기본 구성은 계산 시간 때문의 타협), 메모리는 **배수**(= 최종 크기 × 프레임)가 정한다 — 뒷단은 1스텝뿐이지만 그 단계의 어텐션이 가장 크다. PC마다 시작 해상도를 먼저 정하고 배수를 ×1.5 → ×2로 올리며 최적값을 찾아 `MY-PC.md`에 고정한다(절차 `comfyui-fit-my-pc`, 원칙 `minimax-h3-r2v-deno` 「잠재 업스케일의 두 손잡이」).
- ① 참고 실측(96GB, 15초·362프레임): 기본 7+1 390~412초(2026-09-25), 액션 8+1 750초(2026-09-26). 같은 장면을 1920×1088 네이티브 8스텝으로 그리면 1,541초였다.
- ② 참고 실측(96GB): 1344×768 → 2016×1152·241프레임 169초, 오디오 원본 유지(파형 상관 0.9998). 같은 소재를 H3 자체 잠재 업스케일(당시 4MP 구성)로 민 판은 1,778초에 왕복손실이 스틸의 절반이었다 — **해상도를 크게 올리는 일은 LTX MSR이 맡는 경우가 많다.** 대신 미세 질감은 H3 잠재 업스케일 쪽이 더 살아났다(고주파 에너지 5배) — 무엇을 원하느냐로 고른다.
- MSR의 아직 안 건드린 손잡이(`background` 슬롯에 빈 공간 플레이트, 참조 시트 배치, `reference_frames` 25, `strength`)는 미검증으로 남겨 두었다.

## 바뀐 점

- v6 (2026-09-27): ①을 5+3(1280×736 → 2560×1472)에서 디노 현행 1088p급 두 구성(기본 7+1·액션 8+1)으로 바꿨다 — 5+3 은퇴(디노 확정). FL2VA 재인코딩 안내를 뺐다(디노 정본의 ①은 R2V 전용). 꾸러미 이름(slug)은 그대로.
- v5 (2026-09-27): 두 손잡이(시작 해상도·배수) 갈림길 추가 — PC마다 배수 조절(디노 확정).
- v4 (2026-09-26 밤): 어텐션을 Comfy Kitchen으로 통일 — ①·② 배선의 세이지 노드를 코어 `ModelAttentionBackend`로.
- v3 (2026-09-26 밤): 상용 절을 뺐다 — 지금은 로컬 파이프라인 복제만(디노).
- v2 (2026-09-26): ①을 현행 VDN 8스텝 계약(세이지 패치 + VDN 로라 + 시그마 이동)에 맞추고, v1의 옛 가속 로더 기준 시그마 숫자 목록을 뺐다(값은 스케줄러가 낸다). `enable_chunking` 기본, FL2VA 재인코딩 조건, 업스케일러 배포처 사정, 도화지 순서.
- v1 (2026-09-17): 첫 판.
