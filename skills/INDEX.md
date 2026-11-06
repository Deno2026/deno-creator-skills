# 노하우 창고 편 목록

DenoMCP 노하우 창고(에이전트 도구 `deno_knowhow_search`·`deno_knowhow_get`, 공개 API `GET /v1/knowhow`)에 있는 편을 그대로 옮긴 목록이다.
편 하나가 파일 하나(`<slug>.md`)이며 머리 블록의 `version`이 창고의 판이다. 편의 첨부 파일(워크플로 JSON·도구 스크립트)은 워크플로 편이면 `../workflows/<slug>/`,
그 밖의 편이면 `<slug>/`에 같은 이름으로 있다. 이 목록·편·첨부는 `tools/sync-from-denomcp.mjs`가 만든다 — 손으로 고치지 않는다.

## 워크플로 (1)

| 편 | 판 | 제목 | 요약 | 첨부 | 갱신 |
|---|---|---|---|---|---|
| [`minimax-h3-tiled-sampler`](minimax-h3-tiled-sampler.md) | 1 | MiniMax H3 타일 샘플러 — 16GB VRAM에서 15초 1080p 영상 | 16GB 그래픽카드에서 MiniMax H3로 15초 1920×1088 영상을 만드는 ComfyUI 워크플로. 작게 그린 뒤 잠재 공간에서 두 배로 키우고, 마지막 한 스텝을 조각(타일)으로 나눠 다시 그립니다. | [`Deno_MiniMax_H3_R2V_16GB_Tiled_Sampler.json`](../workflows/minimax-h3-tiled-sampler/Deno_MiniMax_H3_R2V_16GB_Tiled_Sampler.json) | 2026-11-06 |
