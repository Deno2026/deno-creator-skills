---
slug: minimax-h3-tiled-sampler
title: MiniMax H3 타일 샘플러 — 16GB VRAM에서 15초 1080p 영상
kind: workflow
tags: 미니맥스, minimax, h3, r2v, 참고 이미지, 타일 샘플러, tiled sampler, 16gb, vram, 1080p, 1088p, 잠재 업스케일, denomix, comfyui
models: MiniMax H3 DenoMix v3, DENO Tiled Sampler
execution: local
version: 1
summary: 16GB 그래픽카드에서 MiniMax H3로 15초 1920×1088 영상을 만드는 ComfyUI 워크플로. 작게 그린 뒤 잠재 공간에서 두 배로 키우고, 마지막 한 스텝을 조각(타일)으로 나눠 다시 그립니다.
---

## 이 워크플로는

참고 이미지와 프롬프트로 15초 1920×1088 영상을 만드는 MiniMax H3 R2V 워크플로입니다. 16GB 그래픽카드에서 돌아가도록 짰습니다.

960×544로 먼저 6스텝을 그리고(Pika 로라), 잠재 공간에서 두 배로 키운 뒤, 마지막 한 스텝을 DENO Tiled Sampler가 조각(타일)마다 나눠 다시 그립니다. 조각을 따로 그려 붙이는 방식이 아니라 매 스텝 화면 전체를 한 번에 고치기 때문에 이음새가 남지 않습니다. 대사와 효과음은 영상과 함께 만들어지고 마지막까지 그대로 따라갑니다.

확인한 환경은 RTX 4060 Ti 16GB · 시스템 메모리 32GB · ComfyUI v0.44.0이고, 15초(24fps)까지 완주했습니다. 워크플로의 기본 길이는 5초입니다.

## 준비물

- **ComfyUI v0.44.0 이상** — MiniMax H3 잠재 업스케일러가 기본으로 들어 있는 판입니다.
- **노드 팩** — DENO Custom Nodes v0.7.126 이상(타일 샘플러가 들어 있습니다) · H3-Optimizations · KJNodes · VideoHelperSuite
- **모델** — 받는 곳은 워크플로 안의 「Model Links」 메모에 파일마다 적혀 있습니다.

| 폴더 | 파일 | 크기 |
|---|---|---|
| diffusion_models | MiniMax-H3_DenoMix_ref2va_pruned_int8_v3.safetensors | 21.0 GB |
| loras | pika_h3_flex_ref2va_v1_avg_rank_55_bf16.safetensors | 553 MB |
| loras | minimax_h3_dmd_ref2va_8step_turbo_pruned.safetensors | 2.29 GB |
| text_encoders | qwen3vl_32b_minimax_h3_int8_convrot.safetensors | 27.1 GB |
| vae | minimax_h3_video_vae_int8_convrot.safetensors | 2.81 GB |
| vae | minimax_h3_audio_vae_fp32.safetensors | 605 MB |
| latent_upscale_models | minimax_h3_latent_upscaler_3d_bf16.safetensors | 691 MB |

## 쓰는 법

1. **워크플로를 엽니다.** 받은 `.json` 파일을 ComfyUI 화면에 끌어다 놓습니다.
2. **모델과 노드 팩을 갖춥니다.** 위 표의 파일을 각 폴더에 두고 노드 팩을 설치한 뒤 ComfyUI를 다시 켭니다.
3. **입력을 채웁니다.** 「2 · Inputs」에 참고 이미지를 넣고 프롬프트를 씁니다. 시작 크기(Resize Box), 길이(초), 시드를 정합니다. 처음에는 기본 5초로 돌려 보세요.
4. **실행합니다.** 544p로 영상과 소리를 만들고, 두 배로 키워 조각마다 마무리한 뒤, 한 번에 풀어 소리가 든 MP4로 저장합니다.
5. **결과를 봅니다.** 저장된 소리도 들어 보세요. 원하지 않는 말소리가 섞일 때가 있습니다.

## 프롬프트

영어로 여섯 칸을 이 순서로 씁니다: `subject_definitions` → `summary` → `retention_analysis` → `detailed_description` → `overall_soundscape` → `non_diegetic_music`. 참고 이미지는 `<Picture 1>`부터 번호로 부르고, 이미지마다 얼굴 · 옷 · 화풍 · 배경 중 무엇을 가져올지 적습니다.

- **대사가 있을 때** — 원래 언어 그대로 `<d>[Korean]안녕하세요.</d>`처럼 적습니다. 화자 번호는 말하는 인물에게만 붙입니다.
- **대사가 없을 때** — `overall_soundscape`에 `Only ambient sound and sound effects are heard.`처럼 들려야 할 소리만 적고, 말하거나 노래하는 묘사는 넣지 않습니다.

## 막힐 때

- **메모리가 모자라면** 시작 크기나 길이부터 줄입니다.
- **타일 크기** — 기본 896×704 타일(겹침 256×320)이 16GB에서 확인한 값입니다. 모두 32의 배수로 두고, 겹침은 타일보다 작게 합니다. 메모리가 넉넉하면 타일을 키우고, 화면만큼 키우면 한 번에 그립니다.
- **DynamicVRAM은 켜 둡니다.**
- **컴파일러 오류가 나면** ComfyUI 시작 옵션 `--disable-comfy-compiler`를 확인합니다.

## 바뀐 점

- v1 (2026-11-06): 처음 공개.
