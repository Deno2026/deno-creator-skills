---
slug: stable-audio-3-prompting
title: Stable Audio 3 Medium 프롬프팅 가이드 + 에이전트 매뉴얼 — LLM에 그대로 넣는 영어 지시문과 하지 말 것
kind: prompting
tags: stable audio, stable audio 3, 배경음, bgm, 음악, 연주곡, 앰비언트, 효과음, sfx, 프롬프트, 프롬프팅, prompting, llm, 지시문, 무보컬, tracktype, bpm, 실수
models: Stable Audio 3 Medium
execution: local
version: 1
summary: Stable Audio 3 Medium(증류판) 프롬프트를 쓰는 LLM용 영어 지시문 전문 + 에이전트가 부르는 순서와 실수 목록. Stability 공식 프롬프팅 가이드(모드별 TrackType 태그, 장르·악기·분위기·BPM 네 요소, 공식 예시)에 디노 규칙(구조·길이 문장, 부정문 금지, 여유 길이, 후보 2~4개)을 [Deno]로 표시해 합쳤다. 하지 말 것 — 가사·보컬, 부정문, 스텝·CFG 변경, 한국어, 태그 누락, 딱 맞춘 길이, 380초 초과, 아티스트명, 한 판만, 바로 최종본.
---

# Stable Audio 3 Medium 프롬프팅 가이드 + 에이전트 매뉴얼

아래 영어 문서가 이 꾸러미의 본문이다. **LLM 채팅에 통째로 붙이거나 시스템 프롬프트로 두고** 어떤 음악이 어디에 필요한지 말하면 그 LLM이 바로 쓸 Stable Audio 3 프롬프트를 돌려준다. 에이전트가 직접 프롬프트를 쓸 때도 같은 규칙을 따른다.

- 근거: Stability AI 공식 프롬프팅 가이드(`stable-audio-3` 저장소 `docs/guides/prompting.md`, 2026-09-27 읽음)·모델 표(medium 최대 380초)·추론 문서(8스텝·CFG 1.0 기본)와 디노가 귀로 채택한 판 두 개. 공식 규칙은 **[official]**, 디노 규칙은 **[Deno]**로 표시했다.
- 워크플로(그래프·모델·길이 사다리·검수)는 꾸러미 `stable-audio-3-bgm`. 이 문서는 「모델이 잘 따르는 문장 모양」과 「하지 말 것」만 준다.
- 어떤 음악을 어디에 깔지, 어느 후보를 고를지는 사용자가 정한다.

## 부르는 순서 — 로컬(내 ComfyUI)

1. **쓰임새·길이·템포를 사용자와 정한다.** 어디에 까는가(인트로·본편 밑·전환·효과음), 편집 길이는 몇 초인가(+ 여유 1~2초), 빠른가 느린가(BPM 숫자).
2. **프롬프트를 아래 가이드대로 쓴다.** 첫 줄 태그(`TrackType: Music, VocalType: Instrumental.` — 악기 단독은 `TrackType: Instrument,`, 효과음은 `TrackType: SFX,`) → 장르·용도 → 악기 2~4개(질감 한 마디씩) → 분위기 → BPM → 시작·전개·끝과 길이 문장 → 믹스 질감. 영어, 한 문단, 40~120단어. 태그는 스크립트가 붙여 주지 않으니 직접 쓴다.
3. **그래프에 넣는다.** `stable-audio-3-bgm`의 API 그래프에서 프롬프트(`3.text`)·길이(`5.seconds`)·후보 수(`5.batch_size`)·시드(`6.seed`)·저장 이름(`8.filename_prefix`)만 바꾼다. 스텝·CFG·샘플러는 그대로(8스텝·CFG 1.0·lcm·simple).
4. **후보를 여러 개 뽑는다.** 방향이 다른 프롬프트 3~4개(시드 고정) 또는 같은 프롬프트 `batch_size` 2~4(시드 다름). 한 판만 뽑아 「이게 결과입니다」 하지 않는다.
5. **잰 값과 함께 보인다.** 파일별 길이·최대/평균 음량·(가능하면) 계측 BPM·한 줄 설명. 「좋다/나쁘다」는 말하지 않는다 — 판정은 사용자.
6. **고른 뒤 처리.** 원본은 그대로 두고 편집에서 자르고 페이드한다. 최대 음량이 0dBFS(풀스케일)로 나오므로 편집에서 게인·리미터. 재사용할 원본은 별도 창고에 복사해 둔다.
7. **다시 뽑을 때는 한 요소만 바꾼다**(악기·BPM·분위기 중 하나). 여러 개를 한꺼번에 바꾸면 무엇이 효과였는지 모른다.

## 하지 말 것 — 실수 목록

| 실수 | 왜 | 대신 |
|---|---|---|
| 가사·보컬·가수를 시킨다 | 이 모델은 알아들을 수 있는 목소리를 못 만든다(공식). 무의미한 목소리 질감만 섞인다 | 노래는 다른 도구. 여기서는 `VocalType: Instrumental` |
| 부정문으로 막는다(`no drums`, `without vocals`) | CFG 1.0에서는 부정 프롬프트 칸이 무효고, 본문의 「no X」는 X를 오히려 부른다 | 원하는 악기·분위기를 긍정문으로 |
| 스텝·CFG·샘플러를 바꾼다 | 증류판은 8스텝·CFG 1에 맞춰져 있다. 스텝을 올려도 좋아지지 않는다(공식 추론 문서) | 다르게 나오게 하려면 프롬프트나 시드 |
| 한국어로 쓴다 | 학습 메타데이터가 영어(Freesound·AudioSparx) | 영어 한 문단. 사용자에게는 한국어로 설명 |
| 태그를 빼먹는다 | `TrackType: Music, VocalType: Instrumental`이 품질·일관성에 유리(공식) | 첫 줄에 태그를 직접 쓴다 |
| 길이를 딱 맞춰 요청한다 | 출력은 ±0.05초, 마무리 화음·여운이 잘릴 수 있다 | 편집 길이 + 1~2초, 끝은 편집에서 |
| 380초를 넘긴다 | 공식 학습 최대 380초(medium). 그 너머는 돌긴 하지만 학습 범위 밖 | 긴 음악은 구조를 문장으로 적고 380초 안에서 |
| 아티스트·곡 이름을 넣는다 | 학습 메타데이터 방식이 아니고 저작권상 부적절 | 장르·악기·질감으로 풀어 쓴다 |
| 한 판만 뽑아 끝낸다 | 같은 프롬프트도 매번 다르다(공식). 고르는 것은 사용자 | 후보 2~4개 |
| 생성물을 바로 최종본에 얹는다 | 자르기·페이드·볼륨은 편집 몫 | 원본 보존 + 편집에서 다듬기 |
| 결과를 듣지도 않고 「완성」 | 길이·무음·클리핑은 잴 수 있다 | ffprobe 길이, 음량, 구간 RMS를 적어 보고 |

## 잰 값으로 보고하는 법 (판정은 사용자)

- 길이(ffprobe `format=duration`), 평균·최대 음량(ffmpeg `volumedetect`), 10초 구간 RMS(끝까지 소리가 있는지), 계측 BPM(두 방법이 수렴하는지).
- 실행 시간·워커·시드·프롬프트 원문을 프로젝트 상태 문서에 남긴다.

---

# Stable Audio 3 Medium — Prompting Guide for LLM Agents

Paste this whole file into an LLM (or read it as an agent) and it will write prompts for **Stable Audio 3 Medium** running in ComfyUI with the Deno graph (8 steps · CFG 1.0 · lcm · simple). The rules below come from Stability AI's official prompting guide for Stable Audio 3 (repo `docs/guides/prompting.md`) plus Deno's accepted results; where the two differ, the official rule is marked **[official]** and Deno's practice **[Deno]**.

## 1. What this model does and does not do

- Generates **stereo 44.1 kHz audio from one text prompt**: instrumental music, ambient beds, solo instruments/stems, and sound effects. One prompt → one clip (or several candidates with `batch_size`).
- **No intelligible vocals** [official]. It may produce unintelligible vocal-like textures. Do not write lyrics, do not ask for a singer; if a user wants a song with words, this is the wrong tool.
- Trained on Freesound + AudioSparx recordings **with their metadata**, so prompts that read like that metadata (tags + a descriptive paragraph) work best [official].
- Official maximum length is **380 seconds** for `medium` [official]; results are better when the duration fits what the prompt describes. Longer clips generate in ComfyUI (Deno ran 1000 s) but sit outside the trained range [Deno].
- Randomness is built in: the same prompt gives a different clip each run unless the seed is fixed [official].

## 2. Choose the mode, then the tag line

Start the prompt with AudioSparx-style tags, then write the paragraph.

| Mode | Opening tags | Notes |
|---|---|---|
| Music (background music, intro, ambient) | `TrackType: Music, VocalType: Instrumental.` | Tends to produce higher quality, more coherent output [official]. This is Deno's default for every BGM prompt [Deno]. |
| One instrument / stem / duo | `TrackType: Instrument,` (+ `Format: Duo,` for two) | Maximizes the chance of an isolated instrument [official]. |
| Sound effect / one-shot / sample | `TrackType: SFX,` | More semantically reasonable effects; keep the duration short [official]. |

Optional extra tags that the dataset understands [official]: `Genre: Funk` (repeat for several: `Genre: Funk, Genre: Jazz`), `Instruments: Guitar, Saxophone, Bass, Piano`.

## 3. Write the paragraph — the four elements [official]

1. **Genre / style** — what kind of music it is, and what it is for (intro, background, trailer).
2. **Instruments** — what is playing and *how each one sounds or feels* (e.g. "close-mic'd electric piano", "syncopated 808 bass").
3. **Mood & energy** — the emotion and atmosphere, in concrete words.
4. **BPM** — state the tempo as a number: "120 BPM".

Deno adds [Deno]:

5. **Structure and length** — say how the clip opens, develops and ends, and name the length ("a complete twenty-second miniature with a clear opening, a central reveal and a final chord"). This keeps the ending inside the requested duration.
6. **Production texture** — one phrase about the mix ("polished wide stereo", "warm tape saturation", "clean studio mix").

Keep it to **one paragraph, roughly 40–120 words**, in English. Say each thing once. Describe what you want to hear; do not list what you do not want (with CFG 1.0 the negative prompt has no effect, and "no drums" still puts "drums" in front of the model).

## 4. Examples

Official examples [official]:

> A triumphant and stylish UK bass-flavoured tech-house tune that evokes feelings of the last tune played in a DJ set. The pumping four-to-the-floor kick is supported by an 808 bass that is syncopated. There are gliding emotional synth leads that build sections to their climax. Playful stabs and chops support the rhythm of the drums in sections. There is a beautiful gospel house piano that plays in the drop, giving the track a euphoric feeling.

> A funky hip hop instrumental with live recorded instrumentation that has the vibe of a 70's TV show theme. The rhythm guitar strums lightly in the background, the lead guitar occasionally delivers jagged flanger-effected chords and phrases, and abstract sounds punctuate the beat with character. A close-mic'd electric piano plays hard with nostalgic supporting chords, flute glides over the beat adding an exciting texture, and the drums are full of swing and old school flavour. The production has a warm, textured sound associated with analogue gear and tape.

> TrackType: Instrument, a sombre solo acoustic guitar track with cavernous reverb and delicate finger picking.

> A blunt, powerful "thud" made by slamming a wooden desk drawer shut. It has a pronounced low-mid body, making it feel heavy, and is given a touch of analog distortion for aggressive character.

Deno's accepted prompts [Deno] — both were chosen by ear from 3–4 candidates:

> TrackType: Music, VocalType: Instrumental. Driving electro bass at 136 BPM for a premium futuristic motion graphics intro. Open directly on a hard kick, crisp snare and an addictive distorted robotic bass riff. Tight sixteenth-note sequenced synths, syncopated electro drum programming and bright laser-like stabs. Evolving filter movement creates tension while the central bass hook stays recognizable. A sudden short rhythmic gap leads to a heavier layered return. Compact 20-second arrangement with a strong final unison hit and a short atmospheric decay. Wide, polished and punchy instrumental production.

> TrackType: Music, VocalType: Instrumental. Cinematic luxury perfume commercial score at 100 BPM. Deep rounded sub bass pulses, intimate solo cello, shimmering glass bells and rich orchestral strings. A sparse mysterious opening develops into an elegant rhythmic crescendo with dramatic low drums and soaring strings, then resolves into a memorable warm final chord with a spacious reverb tail. A complete twenty-second miniature with a clear opening, powerful central reveal and graceful closing cadence. Sensual, dark, opulent and emotionally compelling, polished wide stereo sound.

## 5. Duration, candidates, seed

- Duration: **edit length + 1–2 s of margin**, 5–380 s. The clip comes out within ±0.05 s of the request; the ending is trimmed in the editor, not by the model [Deno].
- Sound effects: 1–5 s; music beds: 20–60 s for intros, longer only when the paragraph describes a longer structure.
- Candidates: generate 2–4 (different seeds via `batch_size`, or 3–4 differently-worded prompts) and let the person choose. Fix the seed only to reproduce a chosen clip.

## 6. Checklist before generating

1. First line has the right `TrackType` (+ `VocalType: Instrumental` for music).
2. Genre, 2–4 instruments with a texture word each, mood, BPM number — each once.
3. The paragraph says how it opens and ends, and names the length.
4. No lyrics, no singer, no negative lists, no artist names.
5. English, one paragraph, 40–120 words.
6. Duration set to edit length + margin, within 5–380 s; count 2–4 if the user will choose.

## 바뀐 점

- v1 (2026-09-27): 첫 판. 디노 지시 「프롬프팅 가이드 찾아서 사용법 매뉴얼도 같이 남겨 놔 — 에이전트들이 실수하지 않도록」. 공식 가이드 원문 기반 영어 지시문 + 순서·실수 목록.
