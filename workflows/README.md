# ComfyUI 워크플로 배포판

DenoMCP 노하우 창고의 워크플로 편에 첨부된 정본 파일(ComfyUI UI 워크플로 `.json`, 에이전트용 API 그래프 `.api.json`)이다. 편 본문(`../skills/<slug>.md`)이
무엇을 어떻게 돌리는지 설명하고, 여기 파일은 그 편의 판과 함께 바뀐다. 이 폴더는 `tools/sync-from-denomcp.mjs`가 공개 API(`GET /v1/knowhow/<slug>/files`)에서
받아 적는다 — 손으로 고치지 않는다.

| 편 | 판 | 파일 | 갱신 |
|---|---|---|---|
| [`minimax-h3-tiled-sampler`](../skills/minimax-h3-tiled-sampler.md) | 1 | [`Deno_MiniMax_H3_R2V_16GB_Tiled_Sampler.json`](minimax-h3-tiled-sampler/Deno_MiniMax_H3_R2V_16GB_Tiled_Sampler.json) | 2026-11-06 |
