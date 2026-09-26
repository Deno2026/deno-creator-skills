# skills — 노하우 창고 편(꾸러미)

Deno MCP 노하우 창고(Deno Skill)에 있는 편을 파일로 그대로 둔 자리다. 창고와 같은 내용, 같은 판 번호. 편 목록은
[`INDEX.md`](INDEX.md), 기계가 읽는 목록은 [`INDEX.json`](INDEX.json)(slug·판·요약·파일 해시).

## 쓰는 법

- **에이전트가 Deno MCP에 연결돼 있으면** `deno_knowhow_search`로 찾고 `deno_knowhow_get`으로 본문을 읽는다. 이 폴더는 같은 것을 파일로 보는 길이다.
- **연결 없이 쓰려면** 필요한 편을 내 리포의 `skills/<slug>.md`로 복사하고, 스타터 킷 장부 `skills/deno-kit.json`에 slug·판·들인 날을 한 줄 적는다.
  편의 첨부 파일(워크플로 JSON·도구 스크립트)은 워크플로 편이면 [`../workflows/<slug>/`](../workflows/), 기법 편이면 여기 `<slug>/` 폴더에 같은 이름으로 있다 —
  연결돼 있으면 `deno_knowhow_get`의 `files` 주소에서 같은 파일을 받는다.
  나중에 판이 바뀌었는지는 여기 `INDEX.json`의 `version`과 장부를 비교하면 된다.
- 편이 주는 것은 **목적과 진행 순서**다. 「디노는 이렇게 한다」 상자는 예시일 뿐이고, 표현·호흡·수치 같은 취향은 사용자가 정한다.

## 파일 모양

머리 블록(`slug`·`title`·`kind`·`tags`·`models`·`execution`·`version`·`summary`) 다음에 본문(마크다운). `kind`는 workflow(진행 순서),
technique(기법), prompting(프롬프트 작법), recipe 넷 중 하나다. `execution: local`은 내 PC의 ComfyUI로 돌리는 편이다.

## 동기화

이 폴더는 [`tools/sync-from-denomcp.mjs`](../tools/sync-from-denomcp.mjs)가 공개 API(`GET /v1/knowhow`)를 받아 적는다. GitHub Action이 매시 돌리므로
창고에 새 편이 오르거나 판이 바뀌면 한 시간 안에 따라온다. 여기 파일을 직접 고치지 않는다 — 다음 동기화가 되돌린다. 내용에 대한 제안은 이슈로 남긴다.
