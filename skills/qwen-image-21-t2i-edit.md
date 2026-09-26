---
slug: qwen-image-21-t2i-edit
title: Qwen-Image 2.1 글→이미지 + 편집 — 한 그래프로 사진 생성·편집하는 디노 워크플로
kind: workflow
tags: qwen, qwen-image, qwen image 2.1, 이미지 생성, 사진, 편집, 합성, 배경 제거, 투명, rgba, 포스터, 인포그래픽, 판면, t2i, edit, comfyui, int8
models: Qwen-Image 2.1, Qwen3-VL 8B
execution: local
version: 5
summary: 로컬 오픈 웨이트 Qwen-Image 2.1(int8)로 글→이미지와 편집(참고 1~10장 합성·부분 편집·배경 제거·투명 PNG)을 한 그래프로 돌리는 순서 — 참고 칸을 비우면 생성, 채우면 편집. 크기·CFG·부정 프롬프트는 사진마다 사용자가 정하고, 프롬프트는 꾸러미 qwen-image-21-prompting으로 쓴다. API 그래프 전문과 모델 배포처.
---

# Qwen-Image 2.1 글→이미지 + 편집 — 한 그래프로

이 꾸러미는 **순서와 그래프 계약**을 준다. 무엇을 찍고 어떤 화풍·크기로 갈지는 사용자가 정한다.
디노가 실제로 고른 기본값(2K·CFG 2·40스텝)은 맨 아래 「디노는 이렇게 한다」에 예시로 두었다.

## 무엇을 만드나

- **글→이미지**: 사진·일러스트·포스터·인포그래픽·앱 화면 같은 판면(영문 글자가 많은 판면도 정확한 편).
- **편집**: 참고 이미지 1~10장으로 — 한 속성 바꾸기, 표시한 자리(색 네모·흰 칠·별도 마스크) 편집, 같은 인물의 새 장면, 같은 제품의 새 장면, 여러 장 합성(단체 사진·가구 배치), 통째로 화풍 바꾸기·복원, 배경 제거·투명(RGBA) 입출력.
- 결과 예(디노, 2026-09-21~24): 공식 기능 시험 28판(투명·부분 편집·인물 6장 → 단체 사진·제품 착용·영문 판면 전부 통과), 하이패션 화보 10장(2K).

## 목적

- 참고 칸을 **비우면 생성, 채우면 편집** — 그래프 하나로 두 일을 한다. 그래서 작품 폴더에 워크플로가 둘로 갈라지지 않는다.
- 크기·CFG·부정 프롬프트를 **사진마다 사람이 정한다.** 자동 전환 스위치를 두지 않는다.

## 진행 순서와 갈림길

### 0) 시작 — 사용자와 정해서 `BRIEF.md`에 적는다

- 목적: 사진인가 판면(글자 중심)인가 편집인가. 편집이면 어느 이미지가 캔버스(`image_1`)인가.
- 크기: 비율과 2K/1MP(표는 프롬프팅 꾸러미 끝의 크기표). 완성 사진은 네이티브 2K, 미리보기·고르기는 1MP.
- **내 PC에 맞추기(사용 노하우, 디노 확정 2026-09-27)**: 처음에는 **1080p급**(약 2MP, 예 1920×1088)·CFG 2.0·40스텝으로 스모크 테스트를 하고, 되면 2K(약 4MP)로 올리고 안 되면 1MP(1344×768급)로 내린다. 사용자와 정한 값은 `MY-PC.md`에 고정하고 그 뒤로는 그 값으로만 — 절차와 양식은 `comfyui-fit-my-pc`. 아래 예시 상자의 2K·CFG 2·40스텝은 디노 PC(96GB) 기준의 최고 품질 권장값이다.
- **상업 사용 여부**: 모델 라이선스는 Qwen Research License — 가중치·코드는 비상업(연구·평가) 목적이고 상업적 사용은 별도 라이선스다. 생성물은 라이선스 대상이 아니며 권리는 생성한 사용자에게 있다고 공식 계정이 밝혔다(2026-09-21, X). 모델 자체를 상업 서비스로 돌리는 경우는 그 설명의 범위 밖(미확인). 결과를 수익·광고에 쓸지는 사용자가 정한다.
- 화풍·톤은 사용자.

### 1) 프롬프트 — 꾸러미 `qwen-image-21-prompting`으로 쓴다

- 모드부터 고른다(글→이미지는 관찰자 서술, 편집은 지시문으로 시작). 참고 이미지가 있으면 새 장면이라도 편집 모드.
- 부정 프롬프트는 CFG가 1보다 클 때만 쓰인다. **CFG 1이면 부정 조건이 적용되지 않는다**(공식 재현 설정).
- 글자는 짧고 크게, 원문 그대로 큰따옴표 안에. 작은 한글 글자는 틀리기 쉽다(아래 「함정」).

### 2) 그래프 채우기

- 글→이미지: 노드 `16.inputs.prompt`·`16.inputs.negative_prompt`, `20.inputs.seed`, 크기(`10.inputs.width/height`, 32의 배수), 저장 접두어(`22.inputs.filename_prefix`).
- 편집: `LoadImage` 노드를 더하고 `16.inputs["images.image_1"] = ["<그 노드>", 0]`로 잇는다(추가 참고는 `images.image_2`… 최대 10장 권장). 캔버스(`10`)는 `image_1`과 같은 비율, 넓이는 `16.resolution`²(1024² ≈ 1MP) 근처로 — 크게 다르면 편집이 밀린다(ComfyUI 공식 템플릿 메모).
- 배경 제거·투명 레이어 편집: 공식 배경 제거 템플릿처럼 `16.inputs.resolution`을 0(입력 크기 그대로), 캔버스를 입력 크기로. 투명 PNG를 넣을 때는 `LoadImage`의 마스크를 `JoinImageWithAlpha`(image, alpha=마스크)로 다시 붙여 `images.image_1`에 잇는다 — 글 인코더가 네 채널을 VAE로 그대로 넘긴다.

### 3) 접수·회수 — `comfyui-agent-basics` 순서 그대로

- 큐잉 전 `/free`, 접수 뒤 `/history`, `/view`로 회수.

### 4) 검수

- 지정한 글자(철자·개수), 요청하지 않은 로고, 손, 인물 수·중복, 지정한 자리.
- **저장 PNG는 보통 판도 RGBA다**(VAE가 네 채널을 낸다 — 알파 240~254가 섞인다). 합성·편집 프로그램에 올리면 조금 비치므로 보통 용도는 RGB로 바꿔 쓴다. 투명 판만 RGBA로 둔다.
- 같은 PC·같은 시드·같은 설정이면 픽셀까지 같은 그림이 다시 나온다 — 재현 확인에 쓴다.

### 갈림길

- **고르기 → 본 판**: 같은 시드·같은 크기면 스텝을 바꿔도 구도가 유지된다. 가벼운 설정으로 여러 장 고르고, 고른 판을 본 설정으로 다시 뽑는다.
- **CFG 1(공식 재현) vs CFG > 1(부정 프롬프트 적용)**: 부정 조건이 필요하면 1보다 크게. 별도 사본으로 갈라 둔다.
- **16GB급 장비의 참고 여러 장 편집**: `3.inputs.dtype`을 `int8`로(디노 실측: 6장 합성 600 → 311초, 그림 차이는 장비 차이보다 작음). 캐시를 끄면 느려지기만 하고 그림은 같다.

## 내용 자리 — 사용자가 채우는 칸

| 칸 | 어디에 | 비고 |
|---|---|---|
| 프롬프트·부정 프롬프트 | `scenes/<판>.txt` | 프롬프팅 꾸러미 형식 |
| 시드 | 실행 그래프 · `상태.md` | 고를 때만 고정 |
| 크기(비율·2K/1MP) | 실행 그래프 `10` | 사람이 직접 넣는다 |
| 참고 이미지(캔버스·정체성·재료) | `assets/` → `LoadImage` | `image_1`이 캔버스 |
| 저장 접두어 | 실행 그래프 `22` | 작품/장면/판 |

## 실행 — 로컬(내 ComfyUI)


| 종류 | 파일 | 크기 | 받는 곳 |
|---|---|---|---|
| 디퓨전 | `diffusion_models/qwen_image_2.1_int8_convrot.safetensors` | 약 7.3GB | Comfy-Org/Qwen-Image-2.1 |
| 텍스트 인코더 | `text_encoders/qwen3vl_8b_int8_convrot.safetensors` | 약 9.4GB | Comfy-Org/Qwen-Image-2.1 |
| VAE | `vae/qwen_image_2.1_vae_bf16.safetensors` | 약 0.7GB | Comfy-Org/Qwen-Image-2.1 |

- 배포처 `https://huggingface.co/Comfy-Org/Qwen-Image-2.1`(bf16 변형도 있다). ComfyUI는 Qwen-Image 2.1 노드(`TextEncodeQwenImage21`·`QwenImage21Cache`)가 든 버전(v0.37 이상).
- **그래프에 어텐션 노드를 넣지 않는다.** 세이지 KJ 패치가 글자 구간의 가림막을 버려 옷·구도까지 바뀌던 실측(2026-09-21)에서 온 규칙이다. 전역 `--use-ck-attention`(2026-09-26 통일) 아래의 Qwen 화질은 디노가 예전에 검사를 끝냈다(2026-09-26 확인) — 그대로 쓴다.
- 아래 그래프의 크기 노드 `10`은 디노 커스텀 노드 `(Deno) Resize Box`(`DenoResolutionSetup`, GitHub Deno2026/comfyui-deno-custom-nodes)다. 없으면 `11.inputs.width/height`와 `4.inputs.width/height`에 같은 숫자를 직접 넣어도 된다 — 하는 일은 「사람이 정한 크기를 잠재와 순서표에 같이 꽂기」뿐이다.

API 그래프(글→이미지 기본, 프롬프트 자리는 예시 문장 대신 `REPLACE_…`로 바꿔 넣는다):

```json
{
 "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "qwen_image_2.1_int8_convrot.safetensors", "weight_dtype": "default"}},
 "3": {"class_type": "QwenImage21Cache", "inputs": {"model": ["1", 0], "device": "auto", "dtype": "default"}},
 "4": {"class_type": "ModelSamplingFlux", "inputs": {"model": ["3", 0], "max_shift": 0.693548, "base_shift": 0.5, "width": ["10", 1], "height": ["10", 2]}},
 "5": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_8b_int8_convrot.safetensors", "type": "qwen_image", "device": "default"}},
 "6": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_2.1_vae_bf16.safetensors"}},
 "10": {"class_type": "DenoResolutionSetup", "inputs": {"mode": "Manual Input", "ratio_preset": "1:1", "megapixels": 4.194304, "width": 2048, "height": 2048, "divisible_by": "32", "resize_method": "Center Crop (Fill)", "interpolation": "lanczos", "crop_x": 0.5, "crop_y": 0.5, "crop_zoom": 1}},
 "11": {"class_type": "EmptyLatentImage", "inputs": {"width": ["10", 1], "height": ["10", 2], "batch_size": 1}},
 "16": {"class_type": "TextEncodeQwenImage21", "inputs": {"clip": ["5", 0], "vae": ["6", 0], "prompt": "REPLACE_WITH_PROMPT", "negative_prompt": "blurry hands, blurred fingers, fused fingers, extra fingers, missing fingers, malformed hands, twisted finger joints, melted fingertips", "resolution": 1024}},
 "20": {"class_type": "KSampler", "inputs": {"model": ["4", 0], "seed": 0, "steps": 40, "cfg": 2.0, "sampler_name": "euler", "scheduler": "simple", "positive": ["16", 0], "negative": ["16", 1], "latent_image": ["11", 0], "denoise": 1.0}},
 "21": {"class_type": "VAEDecode", "inputs": {"samples": ["20", 0], "vae": ["6", 0]}},
 "22": {"class_type": "SaveImage", "inputs": {"images": ["21", 0], "filename_prefix": "REPLACE_WITH_JOB_PREFIX"}}
}
```

- `ModelSamplingFlux`의 `max_shift 0.693548 / base_shift 0.5`는 공식 `scheduler_config.json`(256토큰 0.5 ~ 8192토큰 0.9)을 이 노드의 4096 기준식에 옮긴 값이라 **어떤 크기에서든 공식 세기와 같다.** width·height에 실제 출력 크기를 꽂아야 성립한다. 화면은 0.69로 반올림해 보이지만 저장값은 그대로.
- 부정 프롬프트는 `TextEncodeQwenImage21`의 두 번째 출력을 `KSampler.negative`에 잇는다.


## 함정 — 모델 사실(디노 실측 2026-09-19~24)

- **작은 한글 글자가 틀린다**(긴 한글 문단은 줄마다 한두 글자). 짧고 큰 문구와 영문은 정확했다. 한글이 많은 판면은 글자를 편집에서 얹는 것이 안전하다.
- 영문도 작은 글자는 가끔 틀리고, **지정하지 않은 글자·숫자를 스스로 넣으면 깨진다** — 라벨이 없는 자리는 「글자 없음」을 못박는다.
- 요청하지 않은 실존 로고가 생긴다(운동복의 스우시 모양). 가이드 양식(무지·무브랜드, 표면을 긍정문으로)으로 쓰면 같은 시드에서 사라졌다.
- 얼굴을 자르는 극단 접사와 시선 지시(「줄을 바라본다」)는 약하다.
- 정교한 커스텀 서식(전신에서 얼굴을 뺀 인물 시트, 칸이 많은 스토리보드)은 약하다 — 칸이 갈라지거나 같은 인물이 둘 나온다.
- 투명 PNG에서 투명해지는 것은 **배경뿐** — 유리·향수병도 알파는 불투명이고 비치는 느낌은 그림으로 그려진다.
- 제품 묘사가 입력 이미지와 어긋나면 **글이 이긴다**(굵은 체인을 「가는 체인」으로 쓰면 가늘어진다). 제품은 이미지에 보이는 대로 쓴다.
- 편집에서 얼굴은 유지된다(정체성은 참고 이미지를 가리키고 얼굴 묘사는 하지 않는다).

## 디노는 이렇게 한다 — 예시 (참고이지 기준이 아니다)

- 사진 기본값(디노 확정 2026-09-24): **네이티브 2K(약 4MP)·CFG 2.0·40스텝·euler/simple·denoise 1**. 1440/2K와 CFG 2/3, 부정 프롬프트 유무를 같은 10장면으로 비교한 뒤 고른 값이다.
- 부정 프롬프트: 손 관련 기본 문구(위 그래프의 값) + 그 사진에서 꼭 필요한 제외(인물 수·반사·소품·글자·로고)를 에이전트가 짧게 판단해 더한다. 같은 긴 제외 목록을 모든 사진에 복사하지 않고, 긍정 지시와 충돌시키지 않는다.
- 스텝: 25·30·40·45·50 비교에서 50이 확실히 낫다는 판정 뒤, 공식 순서표(`ModelSamplingFlux`)를 넣은 40스텝이 50스텝급 얼굴·세부를 40스텝 시간에 냈다(2026-09-21, 2장면 × 2대).
- 참고 실측(2026-09-21, 96GB 카드): 1344×768 40스텝 8.9초, 편집 864×1184 9초. 16GB 카드는 int8 캐시로 여러 장 합성 311초.
- 인물 시트·스토리보드처럼 서식이 엄격한 그림은 이 모델이 아니라 다른 경로로 만든다.

## 포함되지 않은 것

- 배포용 UI 워크플로 파일(모델 링크 노트 한 장 포함) — 다음 판에 첨부한다. 위 API 그래프와 같은 배선·같은 값이다.
- 디노의 화풍·소품·색 체계.

## 바뀐 점

- v5 (2026-09-27): 사용 노하우 — 스모크는 1080p급부터, 되면 2K·안 되면 1MP, 사용자와 정해 `MY-PC.md`에 고정(`comfyui-fit-my-pc`).
- v4 (2026-09-27): Kitchen 전역 인자 아래 Qwen 화질 A/B는 불필요(디노 — 예전에 검사 끝). 기본값은 그대로 네이티브 2K·CFG 2.0·40스텝·Euler/simple.
- v3 (2026-09-26 밤): 어텐션 규칙 문장 갱신(세이지 은퇴, Kitchen 전역 인자 아래 Qwen 화질은 A/B 대기).
- v2 (2026-09-26 밤): 상용 절을 뺐다 — 지금은 로컬 파이프라인 복제만(디노).
- v1 (2026-09-26): 첫 판. 디노의 Qwen-Image 2.1 배포 워크플로 문서·플레이북(2026-09-24 기준)을 도화지 순서로 옮김.
