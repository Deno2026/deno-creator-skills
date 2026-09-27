# 교육숏츠 도구 설명서

DenoMCP 노하우 창고 `education-shorts` 편의 첨부입니다. 도구는 셋이며, 자막 정렬만 기본이고 나머지 둘은 선택입니다.
제미나이·타입캐스트는 외부 서비스라 없어도 교육숏츠를 만들 수 있습니다. 다만 디노가 실제로 쓰는 조합이라 추천하며, 두 서비스 모두 무료로 시작할 수 있습니다(아래 조건을 확인하세요).

| 도구 | 폴더 | 하는 일 | 필요한 것 |
|---|---|---|---|
| 자막 강제정렬 — 기본 | `caption-align/` | 확정된 원고를 최종 영상의 소리에 맞춰 프레임 단위 자막(SRT)을 만들고, 원하면 영상에 박아 넣습니다(번인) | Windows PowerShell(설치 스크립트), 처음 설치 때 인터넷 |
| 대본 검수·집필 — 선택·추천 | `script-review/` | 대본을 제미나이에 합격 기준으로 검수받거나, 설명 명세로 처음부터 쓰게 합니다 | 제미나이 API 키(무료) |
| 나레이션 — 선택·추천 | `typecast-tts/` | 원고를 문장 단위로 읽혀 쉼을 규칙대로 다듬고 한 파일로 잇습니다 | 타입캐스트 API 키(무료 플랜 있음) |

세 도구 모두 결과를 판정하지 않습니다. 대본 합격, 목소리, 자막 모양은 사용자가 정합니다(편의 GATE 1·2·2.5).

## 1. 자막 강제정렬 — 기본

`caption-align` 폴더에서 PowerShell로 한 번 설치합니다.

```powershell
.\bootstrap_mfa.ps1
```

- 이 폴더의 `.runtime/`에만 micromamba, Python 3.11, Montreal Forced Aligner 3.4.2와 한국어 모델을 설치합니다. 시스템 파이썬은 건드리지 않습니다.
- 지울 때는 `.runtime` 폴더 하나만 지우면 됩니다.
- macOS·Linux는 제작자가 확인하지 못했습니다(미확인). MFA 공식 안내로 같은 버전을 설치한 뒤 `--mfa-runtime`에 그 환경을 주는 방식이 될 것입니다.

실행 예(원고 형식과 결과 파일 설명은 `caption-align/README.md`):

```powershell
& .\.runtime\env\python.exe .\caption_align.py `
  --media ..\..\final.mp4 --script ..\..\script.json --out-dir ..\..\caption-result
```

영상에 자막을 박아 넣으려면 같은 폴더의 번인 스크립트를 넘깁니다. 한국어 글꼴 파일을 함께 지정하세요.

```powershell
& .\.runtime\env\python.exe .\caption_align.py `
  --media ..\..\final.mp4 --script ..\..\script.json --out-dir ..\..\caption-result `
  --burner .\subtitle_paper_burn.py --burn-out ..\..\final_subbed.mp4 --burn-style bold `
  --burn-font C:\Windows\Fonts\malgunbd.ttf
```

## 2. 제미나이 API 키 — 무료

- **무료 등급이 있습니다.** 스크립트의 기본 모델 `gemini-3.8-flash`(검수)와 `gemini-3.7-flash`(집필)는 무료 등급에서 입력·출력 모두 무료이고, 신용카드가 필요 없습니다.
- **주의할 점:** 무료 등급으로 보낸 내용은 구글 제품 개선에 쓰일 수 있습니다. 대본에 민감한 정보는 넣지 마세요.
- 호출 한도가 있습니다. 한도는 Google AI Studio의 사용량 화면에서 확인합니다. 한 편에 몇 번 부르는 대본 검수 용도에는 충분합니다.
- **받는 법:** [aistudio.google.com](https://aistudio.google.com)에 구글 계정으로 로그인한 뒤 API 키를 만들어 복사합니다.
- **넣는 법(둘 중 하나):** 환경변수 `GEMINI_API_KEY`, 또는 파일 `~/.deno/gemini_api_key.txt`(키 한 줄). 키는 채팅·문서·Git에 적지 마세요.

```bash
python script-review/gemini_review.py 대본.txt
python script-review/gemini_write.py 명세.json --out 대본.json
```

- 검수 기준은 `gemini_review.py` 안의 `CRITERIA` 블록입니다. 디노 채널의 기준(담백한 정중체, 질문형 뼈대, 「시청자가 가져갈 것」 먼저)이 들어 있으니 자기 채널 말투로 고쳐 쓰세요.
- 검수 결과는 참고입니다. 제미나이가 기준과 반대로 권한 사례가 스크립트 머리말에 적혀 있습니다 — 반영할지는 사람이 정합니다.

## 3. 타입캐스트 API — 무료 플랜(조건 확인)

- **무료 API 플랜이 있습니다.** 매달 15,000크레딧(1글자 = 1크레딧)이고, 결제 정보 없이 시작하며, 동시 요청은 2개까지입니다. 디노의 교육숏츠 나레이션 한 편은 약 650자라 무료로 한 달 스무 편 남짓입니다.
- **중요 — 무료 플랜으로 만든 음성은 상업적으로 쓸 수 없고 출처 표기가 필요합니다.** 수익을 내는 채널에 올리려면 유료 플랜(Lite — 월 $15, 200,000크레딧)이 필요합니다. 표기 방법은 타입캐스트의 출처 표기 안내([typecast.ai/guideline](https://typecast.ai/guideline/))를 따릅니다.
- 웹 편집기(Typecast Studio)의 무료 플랜은 API와 별개입니다(평생 3,000크레딧, API 사용 불가).
- **받는 법:** [studio.typecast.ai/developers/api](https://studio.typecast.ai/developers/api)에 로그인해 API 키를 만듭니다.
- **넣는 법(둘 중 하나):** 환경변수 `TYPECAST_API_KEY`, 또는 파일 `~/.deno/typecast_api_key.txt`(키 한 줄).
- **목소리 고르기:** 타입캐스트 API 문서의 목소리 목록([List Voices](https://typecast.ai/docs/api-reference/voices/list-voices))에서 목소리 ID(`tc_…`)를 골라 `--voice-id`로 넘깁니다. 무료 플랜에서 쓸 수 있는 목소리는 콘솔에서 확인하세요(제작자 미확인). 기본값 `--voice piljae`는 디노 채널 목소리(필재, 빠르기 1.2) 예시입니다.

```bash
python typecast-tts/typecast_narration.py --piece productions/<작품> --voice-id tc_… --tempo 1.0 --dry   # 글자 수(크레딧)만 먼저
python typecast-tts/typecast_narration.py --piece productions/<작품> --voice-id tc_… --tempo 1.0
```

- 작품 폴더의 `post/caption_script_manifest.json`(편의 「실행 명세」)을 읽어 `renders/tts_typecast_<목소리>/narration.wav`와 `narration_timing.json`(구간·문장 시각)을 만듭니다. 이미 받은 문장은 다시 부르지 않습니다(크레딧 절약).
- 쉼 규칙표(`RULE` — 문장 사이 0.35초, 질문 뒤 0.55초 등)는 디노가 귀로 정한 값입니다. 자기 목소리·말투에 맞게 숫자를 고쳐 쓰세요.

## 사실 확인

2026-09-27에 공식 페이지로 확인했습니다 — 구글 Gemini API 요금표(2026-09-24 갱신본), 타입캐스트 API 요금표·API 소개 페이지. 요금과 조건은 바뀔 수 있으니 쓰기 전에 공식 페이지를 다시 확인하세요.
