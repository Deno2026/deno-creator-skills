# 오디오 편집과 정돈

## 1. 요청 해석

- `통파일 컷`, `알아서 컷`, 통파일을 주며 `컷편집`: 무음 컷과 문장 단위 다듬기(했던 말 다시 하기·중복된 말·재시작·실패 테이크)를 **한 번에** 끝낸다 — [통파일 한 번에 컷](#3-통파일-한-번에-컷--무음--문장-단위-다듬기). 발화 경계는 실제 무음에 두고 애매한 발화는 보존한다.
- `오디오만 보고 컷편집`, `파형만`, `소리 유무만`: 실제 침묵 구간만 기준으로 편집한다. transcript·문장 의미·반복·실패 테이크 추론은 쓰지 않는다.
- `오디오/볼륨 맞춰줘`, `전체 오디오 밸런스`: 구간별 체감 음량을 맞추고 순간적으로 튀는 피크만 리미터로 제한한다. 컷·기존 효과·트랙 구조를 보존한다.
- `Level만`, `레벨만`: `볼륨 > 레벨`의 정적 값만 조절한다.
- `컷은 끝`: 현재 edit을 잠그고 오디오 범위만 한다.
- `리미터 걸어줘`, `피크 눌러줘`: 전체 밸런스 기본 경로의 리미터 단계만. `BGM 크다/작다`: 그 BGM 역할만 목표에서 다시 맞추고 프로그램 loudness가 ±0.5 LU 안에 머무는지 확인한다.

위 요청은 지목한 범위의 timeline write를 포함한다. 프로젝트 저장은 사용자가 요청한 범위에서만.

## 2. 파형 컷 빠른 경로

1. `premiere:capture-direct-cut-inputs`로 project·sequence와 exact target V/A 한 쌍을 확정한다. 동명 clip은 track과 timeline start로 식별한다.
2. peak waveform의 발화·침묵 경계를 integer frame에 맞춘다.
3. manifest validator를 통과한 목록을 원본 시간 역순으로 적용한다.
4. 기본 20컷씩 처리한다. 각 cut의 exact V/A 두 조각 선택과 ripple removal response를 확인하고, batch 끝에서 target V/A·누적 duration을 읽는다.
5. 마지막에 기존 제외 구간, 비대상 트랙, V/A 정렬, 최종 duration을 확인한다.

안전 불변조건: 정상 timeline clip은 Premiere의 direct Razor/ripple 경로로 편집한다. 파형 경계는 peak 기반으로 잡고 발성 frame을 보존한다. semantic cut은 transcript로 판단하고 edge는 실제 waveform에 둔다. 애매한 발화는 보존한다.

## 3. 통파일 한 번에 컷 — 무음 + 문장 단위 다듬기

녹화 통파일을 넘기며 컷을 맡기면 무음 구간과 반복·재시작을 한 계획으로 합쳐 한 번에 자른다. 원본 시퀀스는 비교·복귀용으로 두고 복제본에 적용한다.

원칙:

- **단어는 받아쓴 그대로여야 한다.** Whisper large-v3는 말더듬·재시작을 한 번으로 정리해 적어 남길 시도와 지울 시도를 구분할 수 없다. 기본 입력은 로컬 Qwen3-ASR(`words --asr`, 재시작을 그대로 적고 영어 단어도 잡는다)이다. 대안으로 Premiere 클립 받아쓰기(`get_clip_transcript` → `map-premiere-target-transcript.mjs` → `--words`)나 타임라인 캡션(`extract-premiere-captions-from-prproj.py` → `--srt`)을 쓴다. 어느 입력이든 Qwen3-ForcedAligner로 어절 시간을 다시 잡는다. Whisper는 영어·숫자 대조에만 쓴다.
- **판단은 전문을 읽고 에이전트가 내린다.** 같은 문장의 마지막 완결 시도를 남기고 앞의 중단된 시도·같은 말 반복·필러 묶음을 지운다. 뜻이 다른 말과 애매한 말은 남긴다.
- **경계는 발화 시작 직전의 무음에 둔다.** 컷 시작은 지울 첫 단어 onset 앞, 컷 끝은 다음에 남길 단어 onset 앞의 무음(10ms RMS -52dB 미만)에서 frame에 맞춘다. 남길 단어의 끝을 기준으로 삼으면 받아쓰기가 놓친 단어가 잘린다. 이음새의 쉼은 지운 시도 앞의 원래 쉼(최대 0.6초)을 유지한다. `plan`이 표시한 무음 없는 연속 발음(`S:no-gap`·`E:no-gap`)은 범위를 한 단어 옮기거나 남긴다.
- **캡션 트랙이 있는 시퀀스에는 ripple 삭제를 쓰지 않는다.** 컷 구간에 걸친 caption item이 ripple을 막아 V/A에 빈 구간이 남는다. 이때는 `premiere:apply-lift-compact`(ripple 없이 들어낸 뒤 V/A clip을 같은 offset으로 각각 옮겨 닫는다)를 쓴다. Premiere API로는 caption track을 잠그거나 지울 수 없으므로 복제본의 옛 caption track은 음소거하고 사용자에게 삭제를 안내한다.

절차(명령은 리포 루트, `E` = `npm run -s premiere:editorial --`):

1. 대상 확인: project·sequence, V1/A1 통파일 clip, caption track 수, 원본 CFR(`ffprobe`, VFR이면 [긴 원본](long-recording.md)).
2. 복제: `npm run premiere:duplicate-sequence -- --expected-sequence "<원본>" --name "<원본> 컷편집" --allow-write`.
3. 기준 오디오와 Whisper 대조본: `npm run premiere:transcribe-timeline -- --expected-sequence "<복제본>" --keep-audio --out-dir tmp/<slug>-cut/transcript` → `timeline-dialogue-16k.wav`.
4. 무음 후보: `premiere:capture-direct-cut-inputs`(통파일 한 clip) → `premiere:propose-waveform-only-cuts -- --clips … --out tmp/<slug>-cut/waveform-cuts.json`.
5. 번호 붙은 단어: `E words --audio <wav> --asr --out words.json --view words-view.txt`.
6. 판단: `words-view.txt` 전문을 읽고 `removals.json`(`[[첫 단어, 끝 단어, 사유], …]`)을 쓴다.
7. 계획: `E plan --words words.json --removals removals.json --audio <wav> --waveform-cuts waveform-cuts.json --out plan.json`. 표시된 컷을 고쳐 다시 계획한다.
8. 미리보기 검증: `E preview --plan plan.json --audio <wav> --words words.json --out-audio preview.wav --out-joins joins.json` → Whisper로 preview.wav 전사 → `E check --joins joins.json --whisper preview-whisper.json --editorial-only`로 모든 편집 이음새를 읽는다.
9. manifest: `node servers/premiere-uxp-mcp/call-tool.mjs get_sequence_structure '{}' --output-json before.json` → `E manifest --structure before.json --plan plan.json --project-name "<x.prproj>" --out manifest.json`.
10. 적용: caption track이 없으면 `premiere:apply-direct-razor-cuts -- --cuts manifest.json`, 있으면 `premiere:apply-lift-compact -- --cuts manifest.json`. 둘 다 `--dry-run` 뒤 `--allow-write`.
11. 링크: `node scripts/repair-premiere-av-links.mjs … --expected-pairs <적용 후 V1 clip 수> --allow-write`.
12. 판정: `get_sequence_structure`로 `after.json` → `E verify --before before.json --after after.json --manifest manifest.json`이 PASS여야 한다. 편집 이음새 목록(시간·걷어낸 말)을 사용자에게 보낸다.

## 4. 전체 밸런스 기본 경로

1. `premiere:export-audio-map`과 현재 sequence structure로 모든 오디오 트랙·clip·source·identity·current raw를 읽고 기존 효과·키프레임을 확인한다. 기존 리미터를 확인해 중복 추가를 피한다.
2. 타임라인에서 실제 사용한 source in/out 구간의 LUFS·true peak를 측정한다. 나레이션은 같은 source라도 구간별 음량 차이를 보정하며 자연스러운 발화 강약을 유지한다. 음악 단독 구간과 주역 삽입음은 foreground, 말 아래 음악은 BGM으로 구분한다.
3. 전체 clip coverage를 확인하고 역할별 목표에 맞는 정적 gain을 계산한다. foreground에는 평상시 소리를 계속 압축하지 않고 순간 피크만 제한하는 `선택적 제한`(Hard Limiter)을 적용한다. 피크 하나 때문에 clip 전체를 낮추거나 지속적인 강한 압축으로 평탄하게 만들지 않는다.
4. 대표 clip에서 효과 추가·parameter 설정·read-back을 확인한 뒤 직렬 batch로 적용한다. 기존 효과와 사용자 키프레임은 보존한다.
5. gain은 `볼륨 > 레벨`에 두고 리미터의 `입력 증폭`은 0 dB로 둔다 — Premiere 클립 체인에서 레벨이 효과보다 **먼저** 적용되므로 천장은 절대값으로 두고 gain을 리미터 안에 넣지 않는다. BGM은 정적 Level로 맞추며 피크 처리가 필요한 경우에만 리미터를 추가한다.
6. batch마다 exact target identity와 설정값을 read-back하고 마지막에 전체 clip 수·start/end·트랙 구조·duration을 비교한다.
7. 변경된 믹스는 검증용 오디오를 로컬로 출력해(`npm run premiere:export-audio-check -- --out tmp/<slug>-audio/mix-check-<n>.wav`) `premiere:verify-program-loudness`로 실제 LUFS·true peak를 확인한다. 기본 판정은 전체 목표 ±1 LU, true peak ≤ −2 dBTP다. 전체 수치가 삽입음 하나의 어긋남을 가릴 수 있으므로 역할별로도 읽는다.

**시작값(예시 — 사용자 청감으로 조정한다):**

| 역할 | 목표 |
| --- | ---: |
| 나레이션 | `-23 LUFS` |
| 주역 삽입·작품 오디오(영화 클립·인용 영상) | 나레이션보다 2 LU 아래 |
| 말 아래 BGM | 나레이션보다 12~14 LU 아래(-36 LUFS 근처). 밝은 신스·촘촘한 리듬 계열은 같은 측정값에서도 말과 더 부딪히므로 3 dB쯤 더 내린다 |
| 대사 장면 BGM(인물이 말을 주고받고 말 사이를 음악이 채우는 장면) | 대사보다 약 6 LU 아래에서 출발. 나레이션 기준(12~14 LU)으로 내리면 말 사이까지 음악이 사라진 것처럼 들린다 |
| 장면 전환 효과음 | 순간 최대(M max)를 나레이션의 momentary p90 근처로 — 거의 안 들리게 누르지 말고 말소리보다 튀지 않게 |
| 프로그램 전체 | `-23 LUFS` |

리미터(`선택적 제한`) 시작값: 최대 진폭 절대값 `-3 dB`, 사전 스캔 `7 ms`, 릴리스 `100 ms`, 채널 연결·트루 피크 제한 활성화, 입력 증폭 0 dB. Adobe effect parameter의 raw 값은 표시 dB와 다르다 — 설치된 Premiere의 `adm/HardLimiter.adm`으로 변환 범위를 확인한다(한 설치본에서 최대 진폭 `(dB + 100) / 100`, 입력 증폭 `(dB + 100) / 150`, 사전 스캔 `(ms - 5) / 15`, 릴리스 `(ms - 40) / 160`이었다). 새 리미터가 keyframe 0개인데 time-varying으로 표시되어 UXP 정적 쓰기가 거절되면 CEP 경로(`node scripts/premiere-mcp-call.mjs set_effect_property --allow-write`)로 값을 쓰고 UXP `list_clip_effects`로 read-back한다. 사용자 automation을 지워 해결하지 않는다.

함정(실측):

- **나레이션은 클립 단위로 측정·보정한다**(`--group-by clip`). 화면 녹화 한 파일을 한 덩어리로 올리면 그 안에 섞인 다른 소리(TTS·시스템 소리)가 튄다. 5초 이상 클립은 자체 측정값을 쓰고 1 dB 미만은 건드리지 않는다.
- **측정할 수 없는 짧은 조각은 이어지는 클립의 레벨을 물려받는다.** 문장 단위 다듬기가 1~10프레임 조각을 남기면 제안 도구가 건너뛰어 그 조각만 꺼진다. 같은 원본에서 끊김 없이 이어지는 앞 클립 → 뒤 클립 → 맞닿은 클립 → 원천 레벨 순으로 가져온다.
- **클립 `오디오 게인`은 audio map에 잡히지 않는다.** 확인 믹스가 전 구간 같은 폭으로 빠지면 저장된 `.prproj`를 풀어 `AudioClip`의 `<Gain>`을 확인하고, 게인은 지우지 않은 채 목표를 게인만큼 옮겨 다시 제안한다.
- 한 역할만 예상보다 크게 낮으면 사용자가 건 오디오 전환(페이드)부터 확인한다 — UXP에는 전환 목록 도구가 없으므로 `.prproj`의 `AudioTransitionTrackItem`을 읽는다.
- 효과음 원본이 작아 `레벨` 상한 +15 dB로 모자라면 나머지를 그 클립 리미터의 `입력 증폭`으로 올린다(천장은 그대로).
- `export-premiere-audio-map`이 특정 project item의 `mediaPath`를 비워 내놓으면 `get_project_item_info`로 실제 경로를 확인해 측정 입력에만 보정한다.

### Level만 요청한 경우

`premiere:export-audio-map` → `premiere:propose-audio-balance` → `premiere:apply-audio-balance`. 이 실행기는 리미터를 추가하지 않으므로 전체 밸런스 기본 경로의 대체물이 아니다.

## 5. 확장 검증

사용자의 A/B·전수조사 요청이나 실제 오류에 맞춰 필요한 검사만 고른다. 프로그램 loudness는 믹스 또는 최종 export가 달라졌을 때 다시 측정한다.
