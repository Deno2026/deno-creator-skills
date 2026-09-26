---
slug: h3-prompt-six-fields
title: MiniMax H3 프롬프트 — 공식 6칸 작법과 대사 문법
kind: prompting
tags: 미니맥스, h3, 프롬프트, 대사, 립싱크, 6칸, subject_definitions, detailed_description, 작법, 소리 배타 선언
models: MiniMax H3 Ref2VA
execution: both
version: 2
summary: H3 참고→영상 프롬프트를 공식 6칸(subject_definitions·summary·retention_analysis·detailed_description·overall_soundscape·non_diegetic_music)으로 쓰는 법, 샷 시각·대사 태그·화자 8항목·립싱크 밀도·긍정문 원칙·대사 없는 판의 소리 배타 선언·참고물 번호, 큐잉 전 검사 항목과 합격 예시 한 편.
---

# MiniMax H3 프롬프트 — 공식 6칸 작법

H3는 여섯 칸을 **이 순서·이 이름 그대로** 받는다. 칸을 빼거나 이름을 바꾸면 이행이 흐트러진다.
`summary: / style: / scene: / characters: / shots: / audio:` 같은 다른 이름의 칸은 2026-08-22 검사 실패로 폐기했다 — 그 형식으로 쓰지 않는다.

```text
subject_definitions:
<Subject 1> is a Korean woman in her early twenties in <Picture 1>: [얼굴·머리·안경·의상처럼 끝까지 고정할 특징]. <Picture 1> defines S1's identity.
<Picture 2> is the location reference for the whole clip: [장소의 고정 요소 열거].

summary:
[reference generation] A 15-second single-shot photoreal comedy short, horizontal 16:9, in which <Subject 1> … [사건 한 문단].

retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - [무엇이 그대로인지]; only her expression and body movement change.
<Picture 2> (appears in [Shot 1]…): fully_preserved - [고정 소품·조명].

detailed_description:
[화풍·화면비·카메라·빛을 1~2문장]
[Shot 1] [시각 없이] 구도·인물 위치·행동·소리.
[Shot 2] At 00:04.000, [새 정보]. At 00:05.500 … At 00:07.000 …
[Shot 3] At 00:10.000, [반전과 마무리].

overall_soundscape:
[환경음·동작음·비언어 소리만 1~4문장. 대사·음악은 여기 안 쓴다]

non_diegetic_music:
N/A
```

## 규칙

- **summary는 대괄호 과제 선언으로 시작한다**: `[reference generation]`(참고물로 새 생성), 필요하면 `[reference generation + audio reference]`.
- **첫 샷은 시각 없이 `[Shot 1]`**, 다음 샷부터 `[Shot N] At MM:SS.mmm`. 샷 안의 박자는 `At 00:05.500 …`처럼 문장으로 이어 쓴다. 컷은 인물·공간·상태·시점·시간에 **새 정보가 생길 때만**; 거리·각도만 바뀌면 카메라 움직임으로 쓴다.
- **긍정문으로 쓴다.** "no shaky camera", "no extra people", "without a cut" 같은 부정형은 모델이 거꾸로 읽는 일이 있고, 금지어를 쌓을수록 그 대상을 오히려 부른다. 막아야 할 것은 원하는 상태를 서술해서 막는다 — "The camera holds this exact front position for the entire clip", "Only these two people are in the room for the whole clip".
- **길이 감각**: `detailed_description`은 영어 350~500단어 안팎이 공식 예시의 밀도다. 채우려고 반복하지 말고 샷마다 새 정보를 넣는다. 정체성은 사진이, 사건은 샷 문장이 맡는다 — 얼굴·복장 세부를 문장으로 길게 다시 쓰는 것은 비용만 든다.
- **참고물 번호는 넣은 순서다.** 이미지는 `<Picture 1>`, `<Picture 2>`(접수 때 넣은 순서), 오디오는 `<Audio 1>`, 등장인물은 `<Subject N>`. 넣지 않은 번호를 부르지 않는다. 참고물마다 `subject_definitions`에서 임무(누구의 얼굴인지, 어느 장소인지)를 정한다.
- **대사가 하나도 없는 판은 `overall_soundscape`를 배타 선언으로 쓴다.** 소리를 느슨하게 두면 모델이 엉뚱한 언어의 말을 지어낸다. 문형은 아래 「대사가 없는 판」.

## 대사 문법

- 말하는 인물마다 화자 번호를 붙이고 대사는 태그로 감싼다: `<Subject 1> (S1) says: <d>[Korean] 카메라 껐다! 이제 자유다!</d>`
- **화자 첫 등장 때 8항목**: 인물 유형·나이·성별·화면 안/밖·음높이·음색·말속도·억양. 예: `a Korean woman in her early twenties, on-screen, bright mid-high pitch, clear playful timbre, quick lively cadence`.
- 화면 밖 목소리(노트북 스피커 속 동료, 내레이션)는 `off-screen, heard only through the laptop speaker`처럼 출처를 쓰고, 그 인물의 입이 화면에 없다는 것을 분명히 한다.
- **립싱크 밀도**: 화면 안 인물의 대사는 **6초당 한 줄** 수준을 넘기지 않는다. 그 이상이면 입 모양이 밀린다. 상황 설명은 화면 밖 목소리에 맡기는 것이 안전하다.
- 대사는 `<d>` 태그 안에 한 번만 쓴다. 같은 대사를 서술문으로 반복하지 않는다. 한국어 대사는 번역·음차하지 않고 그대로.
- 영상 끝에서 말이 잘려도 되는 경우는 `<cutoff>` 태그, 컷을 넘어가는 소리는 양쪽 이음새에 `<scenetrans>`.

## 대사가 없는 판

`<d>` 태그가 하나도 없으면 `overall_soundscape`에 이 두 문장을 반드시 넣는다(들릴 소리를 그 사이에 열거):

```text
The entire soundtrack contains only these sounds and nothing else: [환경음·동작음 열거]. No spoken words in any language, no narration, no voice-over, no singing.
```

샷 문장에도 `says`·`asks`·`tells`처럼 말하는 사건을 쓰지 않는다 — 배타 선언이 있어도 화면 밖 목소리를 부른다. `scoffs`·`laughs` 같은 소리 내는 동사 대신 `smirks`·`laughing silently` 같은 보이는 동작을 쓴다.

## 큐잉 전 검사(에이전트가 스스로)

1. 여섯 칸이 정확히 한 번씩, 순서대로 있는가.
2. summary가 `[과제 유형]`으로 시작하는가.
3. 첫 샷에 시각이 없고, 이후 샷에는 `At MM:SS.mmm`이 있는가.
4. 부정형(no/not/never/without/avoid…)이 남아 있는가 → 긍정문으로 바꾼다.
5. 화면 안 화자의 대사가 6초당 한 줄을 넘지 않는가. 각 화자에 8항목이 있는가.
6. `overall_soundscape`에 대사·음악이 섞이지 않았는가. 음악이 없으면 `non_diegetic_music: N/A`.
7. 대사가 없는 판이면 소리 배타 선언 두 문장이 있는가.
8. `<Picture N>`의 N이 실제로 넣은 참고 이미지 수를 넘지 않는가.

디노의 감독실은 이 검사를 `h3_prompt_lint.py`로 돌리고, DenoMCP 접수 창구(게이트웨이 `make_video`)는 같은 코드로 1·2·3·7·8을 접수 때 검사한다 — 어긋나면 접수하지 않고 고칠 점을 돌려준다. 4·5·6은 경고로만 알린다.

## 합격 예시 — 대사 4줄, 가로 16:9, 15초 (2026-09-16 검증판)

화면 안 화자 1명(S1)과 노트북 스피커 속 화면 밖 화자 1명(S2). 참고물은 인물 사진 `<Picture 1>`과 장소 사진 `<Picture 2>` 두 장.

```text
subject_definitions:
<Subject 1> is a Korean woman in her early twenties in <Picture 1>: clear youthful skin, dark hair in a loose bun, clear round glasses, an oversized heather-gray hoodie and black leggings. <Picture 1> defines S1's identity — face, hair, glasses and outfit.
<Picture 2> is the location reference for the whole clip, already framed in landscape: a cozy small home office with a light wood desk running across the lower third, an open laptop showing a softly blurred grid of small video-call tiles, a ring light on a stand, a ceramic mug, a small plant, a bookshelf filling the background and morning window light from the left edge.

summary:
[reference generation] A 15-second single-shot photoreal comedy short, horizontal 16:9, in which <Subject 1> sits at the <Picture 2> desk in a work video call, announces out loud that her camera is off, throws a huge over-the-top chair dance, and gets caught when a colleague's voice from the laptop tells her the camera is still on — she freezes, squeaks one word, and slowly sinks below the desk.

retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - face, hair, glasses, hoodie and leggings stay identical throughout; only her expression and body movement change.
<Picture 2> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - desk, laptop, ring light, mug, plant, bookshelf and window light keep the same positions, and the laptop screen keeps its blurred call grid.

detailed_description:
Photorealistic live-action look, horizontal 16:9, one locked medium-wide shot at eye level from in front of the desk: the desk runs across the lower third of the frame, <Subject 1> sits at center with the bookshelf behind her and the window at the left edge, shallow depth of field, soft morning window light plus a warm ring-light glow on her face, natural skin and fabric texture. The camera holds this exact front position for the entire clip and every beat is seen from the front.
[Shot 1] <Subject 1> sits in the office chair facing the laptop, framed from the waist up with the laptop, ring light and mug in the same frame, listening with a polite blank face and slow nods. A male colleague's voice (S2) — a Korean office worker in his forties, off-screen, heard only through the small laptop speaker, mid-low pitch, flat tired timbre, slow monotone meeting cadence — says: <d>[Korean] 그럼 다음 안건은 이번 분기 매출 보고인데요.</d> She reaches forward, taps one key on the laptop with an exaggerated flourish, leans way back, and <Subject 1> (S1) — a Korean woman in her early twenties, on-screen, bright mid-high pitch, clear playful timbre, quick lively cadence — says with a huge grin and both fists pumped: <d>[Korean] 카메라 껐다! 이제 자유다!</d>
[Shot 2] At 00:04.000, the framing holds and the dance explodes: both arms shoot straight up, her shoulders pump hard, her head whips side to side so the bun flops loose, and she mouths along silently with her eyes squeezed shut in bliss. At 00:05.500 she throws big alternating punches at the ceiling and rocks her hips so the whole chair wobbles. At 00:07.000 she kicks off the desk and the chair spins one full turn with her arms out like airplane wings, then she slams back to face the laptop and does a wild seated shimmy with both hands flapping. At 00:08.500 she half-stands, swings her hips side to side in wide sweeps with finger-guns pointed at the ceiling, hair strands flying and glasses sliding down her nose, bigger and sillier every second.
[Shot 3] At 00:10.000, mid-hip-swing, the colleague's voice (S2) says through the laptop speaker: <d>[Korean] 저기… 수진 씨, 카메라 켜져 있어요.</d> She freezes instantly with both arms up and her mouth wide open, eyes going huge behind the crooked glasses. At 00:12.000 her head turns to the laptop in slow motion and she spots the small camera light glowing. At 00:12.800 <Subject 1> (S1) says in a tiny cracked voice: <d>[Korean] …네?</d> At 00:13.200 she sinks straight down in the chair, slowly and stiffly, until only her glasses and the top of the bun peek over the desk edge, and holds there until the end while one hand rises above the desk to give a tiny apologetic wave.

overall_soundscape:
Quiet apartment room tone with a faint laptop fan; the laptop speaker sounds small and tinny; chair creaks, hoodie fabric rustle and a chair-wheel squeal during the spin; one loud keyboard tap; a long slow chair creak as she sinks.

non_diegetic_music:
N/A
```

## 검증 이력(Deno)

| 날짜 | 내용 | 결과 |
|---|---|---|
| 2026-08-22 | 6칸 구조 확정, 게이트웨이식 "summary/style/scene…" 형식은 검사 실패로 폐기 | 이후 전 판 6칸 |
| 2026-09-16 | 대사 4줄(화면 안 2·화면 밖 2, 6초당 한 줄 규칙) 16:9 15초 — 위 합격 예시 | 4줄 모두 전사 확인, 립싱크는 사람 판정 |
| 2026-09-26 | 대사 없는 판의 소리 배타 선언을 필수 검사로(없으면 중국어·영어 말을 지어낸 판 넷) · DenoMCP 접수 창구가 이 편을 `prompt_guide`로 그대로 주고 접수 때 같은 검사를 한다 | v2 |
