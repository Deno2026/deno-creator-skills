# 한국어 자막 강제정렬

작성 원고가 이미 확정된 한국어 내레이션을 최종 영상의 **원본 mixed audio**에
강제정렬하고, 발화 어절 경계를 읽기 좋은 표시 구절로 묶어 영상 프레임에 고정하는
로컬 CLI다.
Whisper가 받아쓴 글자를 그대로 쓰거나 음량 임계값으로 초성을 추측하지 않는다.

## 선택한 방법

기본 엔진은 Montreal Forced Aligner(MFA) 3.4.2와 `korean_mfa` acoustic,
dictionary, G2P 모델이다. MFA가 작성 원고의 발음열을 실제 음성에 강제로 맞춘 뒤,
이 도구가 한국어 형태소로 나뉜 word tier(`사람 + 은`, `개수 + 를`)를 발화 원고의
공백 단위인 어절로 재결합한다. 일반 문장은 원고의 철자와 문장부호를 복원하고,
기술 용어는 아래 `caption_overrides`로 원래 표기를 화면에 복원한다.

## 발화 원고와 화면 자막은 분리한다

TTS·H3가 정확히 읽도록 쓰는 문자열과 시청자가 읽어야 하는 표기는 서로 다른
권위다. 발화·MFA 정렬에는 `spoken_text`, 최종 SRT에는 `display_text`를 사용한다.

```json
{
  "beats": [
    {"spoken_text": "비에프 십육이나 지지유에프를 고릅니다."}
  ],
  "caption_overrides": [
    {
      "spoken_text": "비에프 십육",
      "display_text": "BF16",
      "preserve_suffix": true,
      "expected_matches": 1,
      "own_card": true
    },
    {
      "spoken_text": "지지유에프",
      "display_text": "GGUF",
      "preserve_suffix": true,
      "expected_matches": 1
    }
  ]
}
```

위 예제는 음성에 `비에프 십육이나 지지유에프를`을 정렬하지만 화면에는
`BF16이나 GGUF를`을 표시한다. 여러 발화 어절이 기술 표기 하나를 이룰 때는 첫
어절 시작부터 마지막 어절 종료까지 **한 표시 카드**로 합친다.

- `preserve_suffix: true`는 `십육이나 → BF16이나`, `지지유에프는 → GGUF는`처럼
  마지막 발화 어절의 한국어 조사와 문장부호를 원래 표기에 붙인다.
- 긴 override를 먼저 적용해 `다이내믹 브이램 → Dynamic VRAM`과
  `브이램 → VRAM`이 겹치지 않게 한다.
- override가 한 번도 대응되지 않거나, 서로 겹치거나, `expected_matches`와 실제
  대응 횟수가 다르면 실패한다. 발음 표기가 최종 자막에 남은 상태로 통과시키지 않는다.
- `own_card`(기본 `true`)는 그 표기가 **혼자 한 카드**를 쓸지 정한다. `INT8`·`ComfyUI`처럼
  한두 번 나오는 기술 표기는 기본값 그대로 두어 또렷하게 보여 준다. 편 전체에서 자주
  나오는 낱말은 `false`로 두어 앞뒤 어절과 묶는다 — 예: 스킬 편(2026-09-16)은
  `에이아이 → AI`가 다섯 번 나와 기본값에서는 한 어절 카드가 여섯 장 생기고 첫 3초가
  `요즘`(0.21초) → `AI를,`(0.54초)로 덜컹거렸다. `false`로 바꾸자 `요즘 AI를,` 한 장
  0.75초가 됐다. `false`여도 발화 정렬과 표기 복원은 그대로다.
- 일반 문장만 있는 기존 `beats[].phrase` 입력은 그대로 지원한다.

이 선택은 역할을 다음처럼 구분한다.

- Whisper는 원고가 없을 때의 **받아쓰기**에는 유용하지만, 생성 토큰의 시각을 그대로
  확정 자막 경계로 쓰지 않는다.
- WhisperX는 Whisper 결과에 CTC 기반 forced alignment를 더하는 좋은 범용 경로다.
  여기서는 글자가 이미 확정됐고 Korean MFA가 형태소 분석, 사전, G2P, 음소 경계를 한
  묶음으로 제공하므로 더 통제 가능한 MFA 경로를 기본으로 삼는다.
- CTC/wav2vec 계열은 추후 두 번째 엔진이나 교차 진단에는 쓸 수 있다. 다만 기존
  TorchAudio forced-align API는 현재 폐기 예정 안내가 있어 고정 제작 정본으로
  선택하지 않았다.

온라인 1차 자료:

- [MFA alignment workflow](https://montreal-forced-aligner.readthedocs.io/en/stable/user_guide/workflows/alignment.html)
- [Korean MFA G2P model](https://mfa-models.readthedocs.io/en/latest/g2p/Korean/Korean%20MFA%20G2P%20model%20v3_0_0.html)
- [MFA Korean phone set와 자동 형태소 분석](https://mfa-models.readthedocs.io/en/latest/mfa_phone_set.html)
- [WhisperX 논문](https://arxiv.org/abs/2303.00747)
- [PyTorch CTC forced-alignment 문서와 폐기 안내](https://docs.pytorch.org/audio/stable/tutorials/ctc_forced_alignment_api_tutorial.html)
- [Netflix Subtitle Timing Guidelines](https://partnerhelp.netflixstudios.com/hc/en-us/articles/360051554394-Timed-Text-Style-Guide-Subtitle-Timing-Guidelines)

## 타이밍 원칙

음성 정렬과 화면 표시 단위는 분리한다. MFA는 모든 발화 어절을 정확히 정렬하고,
기본 전달 프로필 `relaxed`는 이미 정렬된 경계만 묶는다. 다음 낱말을 추측하거나 실제
발화 경계를 옮기지 않는다.

1. 최종 mixed audio를 16 kHz, mono, PCM WAV로 변환한다. 보컬 분리기는 초성의 짧은
   transient를 약화할 수 있어 1차 입력으로 쓰지 않는다.
2. MFA phone alignment 결과를 작성 원고의 어절에 100% 대응시킨다.
3. 기본 `--caption-grouping relaxed`는 자연스러운 2~4어절을 한 카드로 묶는다. 최소
   3글자 이상, 보통 5~10글자, 약 0.9~2.0초 체류를 우선하며 문장부호와 실제 쉼을
   넘지 않는다. 짧은 맞장구와 `INT8` 같은 기술 표기는 의미가 흐려지지 않도록 단독
   카드가 될 수 있다. 표기 카드의 단독 여부는 `own_card`로 끌 수 있다.
4. 진단용 `--caption-grouping exact`는 발화 한 어절을 한 카드로 남긴다.
   `caption_overrides`가 여러 발화 어절을 기술 표기 하나로 묶으면 두 프로필 모두
   표시 SRT에서 그 표기를 한 카드로 유지한다.
5. 시작은 발성이 들어 있는 프레임
   `floor((source_word_start - video_first_pts) * fps)`이다.
6. 다음 발화까지 간격이 120 ms 이하면 다음 카드 시작에서 반 프레임 중첩 없이 바로
   바꾼다. 120 ms를 넘으면 현재 단어 끝을 `ceil`한 뒤 실제 빈 구간을 보존한다.
   시각 선행으로 다음 카드 시작이 자연스러운 끝 프레임보다 앞서면 현재 카드 끝을
   다음 시작에 clamp하고 `pause_blank_clamped_to_next_start`로 기록한다.
7. 기본 `--visual-lead-frames 0`이다. 채널 문법 실험이 필요할 때만 1 또는 2를 명시한다.
   사용값은 `alignment.json`과 `qc.json`에 남는다.
8. 진폭, 무음, 보컬 stem으로 시작점을 당기거나 늦추지 않는다.

Netflix의 배포 지침은 첫 오디오 프레임 또는 가능한 한 가까운 1~2프레임을 기준으로
삼는다. 여기서 `--visual-lead-frames 2`는 그 지침이 요구한 값이 아니라, 정확한 첫
음소 프레임을 기준점으로 만든 뒤 채널별 정상 재생 A/B에서 선택하는 별도 인지 보정이다.

MFA의 acoustic frame과 영상 프레임은 유한한 격자이므로 “완벽”은 무한 정밀도가
아니라 **정확한 원고를 음소로 강제정렬하고, 발성이 포함된 첫 영상 프레임에
결정론적으로 고정하며, 대응 실패를 숨기지 않는 것**을 뜻한다.

## 설치

PowerShell에서 한 번 실행한다.

```powershell
# 이 폴더(caption-align)에서
.\bootstrap_mfa.ps1
```

설치기는 이 폴더의 `.runtime/`에만 다음을 둔다.

- micromamba
- Python 3.11 (`python-mecab-ko`는 Python 3.13 Windows wheel이 없어 3.11 고정)
- Montreal Forced Aligner 3.4.2
- `python-mecab-ko==1.3.7`, `jamo==0.4.1`
- FFmpeg/ffprobe와 Korean acoustic, dictionary, G2P 모델

Windows conda 빌드가 `sndfile.dll`만 제공하는 경우 `soundfile`이 찾는
`libsndfile.dll` 이름으로 같은 로컬 DLL을 복사한다. 시스템 PATH, 전역 Python,
보안 설정은 바꾸지 않는다. `.runtime/`은 이 폴더의 `.gitignore`로 제외된다.

## 실행

JSON 원고는 `beats[].spoken_text`, 기존 `beats[].phrase`,
`blocks[].spoken_text/vo_line`, `text`, 문자열 배열을 지원한다. 기술 용어 원래
표기는 최상위 또는 개별 beat의 `caption_overrides`에 둔다. 그 밖의 파일은 UTF-8
plain text로 읽는다.

```powershell
& .\.runtime\env\python.exe .\caption_align.py `
  --media E:\path\final.mp4 `
  --script E:\path\script.json `
  --out-dir E:\path\caption-align-result `
  --mfa-runtime .\.runtime\env `
  --mfa-root .\.runtime\mfa-root `
  --caption-grouping relaxed
```

FPS는 영상에서 읽는다. 오디오 파일처럼 영상 stream이 없다면 `--fps 24` 또는
`--fps 30000/1001`을 명시한다. `relaxed`는 생략해도 적용되는 전달 기본값이고,
한 어절 카드가 필요한 정렬 진단 때만 `--caption-grouping exact`를 명시한다. 채널별
시각 선행 실험은 `--visual-lead-frames 0|1|2`로만 한다.

Windows OpenFST는 MFA가 만드는 깊은 임시경로에 한글 같은 non-ASCII 문자가 있거나,
예상 중첩 경로가 너무 길면 쓰기에 실패할 수 있다. `out-dir`이 120자 이상이거나,
예상 `phones.txt` 경로가 non-ASCII이거나, 그 경로가 UTF-8 180바이트 이상이면 공개
결과는 계속 `out-dir`에 쓰되 MFA 중간 작업장만 ASCII 경로인
`scratch/caption-align-work/<stable-hash>`로 자동 우회한다. 별도 짧은 작업장을
고정하려면 `--work-dir E:\short\caption-work`를 지정한다. 실제 선택 경로·자동 우회
사유·예상 중첩 경로 길이는 `alignment.json`, `qc.json`에 기록된다.

번인이 필요하면 사용자가 지정한 번들 `subtitle_paper_burn.py`만 호출한다. 번들 번인기는 이 폴더의 `subtitle_paper_burn.py`다
(2026-09-27 작품 폴더의 같은 사본에서 옮겨 둠 — 노하우 창고 `education-shorts` 편에도 첨부된다).
이 도구가 자체 FFmpeg 자막 필터를 만들지 않는다.

```powershell
& .\.runtime\env\python.exe .\caption_align.py `
  --media E:\path\final.mp4 `
  --script E:\path\script.json `
  --out-dir E:\path\caption-align-result `
  --mfa-runtime .\.runtime\env `
  --mfa-root .\.runtime\mfa-root `
  --burner .\subtitle_paper_burn.py `
  --burn-out E:\path\final_subbed.mp4 `
  --burn-style bold `
  --burn-font C:\Windows\Fonts\malgunbd.ttf
```

번인 전후 오디오를 48 kHz stereo PCM으로 디코딩해 SHA-256을 비교한다. 다르면
`qc.json`이 실패하고 프로세스도 0이 아닌 코드로 끝난다.

폰트를 지정하지 않으면 burner가 자신의 기본 폰트를 찾는다. 한국어 Windows 영상은
`--burn-font C:\Windows\Fonts\malgunbd.ttf`를 명시하는 것이 안전하다. 필요한 경우
아래 옵션도 번들 burner에 그대로 전달할 수 있다. 지정하지 않은 옵션은 command에
넣지 않으므로 burner 자체 기본값을 유지한다.

- `--burn-fontsize-frac`
- `--burn-bottom-frac`
- `--burn-maxw-frac`
- `--burn-bridge`
- `--burn-tail`
- `--burn-gap`
- `--burn-min-dur`
- `--burn-no-caps` — bold 번인은 라틴 문자를 기본으로 대문자로 바꾼다. `ComfyUI`,
  `Block Swap`처럼 `display_text`의 브랜드 표기를 그대로 화면에 남겨야 하면 켠다.
  끄지 않으면 `COMFYUI`, `BLOCK SWAP`으로 렌더되어 표기 복원이 실패한다.
- `--burn-single-line` — 모든 카드를 한 줄로 강제한다. 가장 긴 카드가
  `--burn-maxw-frac` 안에 들어가도록 전체 글자 크기가 함께 정해지므로
  `--burn-fontsize-frac`은 고정값이 아니라 상한으로 동작한다.

## 결과와 실패 조건

- `alignment.json`: MFA 토큰, 발화 어절 카드, `caption_overrides` 대응 기록,
  한 어절 단위 `exact_display_cards`, 선택한 프로필의 `display_cards`, source PTS,
  프레임 경계
- `captions.srt`: `display_cards`로 만든 번인용 표시 자막. 발음용 한글 대신
  `GGUF`, `BF16` 같은 원래 기술 표기가 들어간다.
- `qc.json`: 자막 묶음 프로필과 묶기 전후 카드 수, 원고 coverage, 미사용 MFA token,
  단조성, 중첩, 프레임 격자, audio/video duration, first PTS, FPS, OOV/G2P,
  엔진/모델 정보
- `logs/`: FFmpeg, MFA, OOV/G2P, 선택적 번인 로그
- `authored.lab`: MFA에 실제로 전달한 문장부호 제거 원고

원고 coverage 100%, 미사용 MFA token 0, 발화·표시 카드 단조 증가, overlap 0,
off-grid 0, display override 전부 대응, 유효 duration/PTS 조건 중 하나라도 실패하면
종료 코드는 0이 아니다. 특히 실제 발화와 작성 원고가 다르거나 기술 표기 대응이
빠지면 억지로 순서를 맞추거나 Whisper 철자로 교체하지 않고 실패한다.

## 제거

다른 작업이 이 runtime을 사용하지 않는지 확인한 뒤 아래 로컬 폴더 하나만 지우면 된다.

```powershell
Remove-Item -LiteralPath .\.runtime -Recurse   # 이 폴더에서
```
