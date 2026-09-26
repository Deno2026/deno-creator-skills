# vendor/premiere-pro-mcp — 무엇을 왜 고쳤나

원본: npm `premiere-pro-mcp` 1.1.1 (MIT, © 2025 Premiere Pro MCP Contributors, https://github.com/ppmcp/premiere-pro-mcp). 원 라이선스 파일은 `premiere-pro-mcp/LICENSE`에 그대로 있다. 이 폴더의 사본은 아래 패치를 적용한 상태이며, 같은 변경을 `premiere-pro-mcp-1.1.1-deno.patch`(원본 대비 unified diff)로도 둔다. 원본을 새로 받아 적용하려면 `npm pack premiere-pro-mcp@1.1.1` → 풀기 → `git apply premiere-pro-mcp-1.1.1-deno.patch`.

`servers/premiere-uxp-mcp/paths.mjs`가 이 폴더를 기본 `PREMIERE_MCP_ROOT`로 잡는다(환경변수로 바꿀 수 있다). MCP SDK·zod는 키트 루트 `package.json` 의존성으로 설치돼 여기서 함께 해석된다.

| 파일 | 변경 | 이유 |
| --- | --- | --- |
| `cep-plugin/CSXS/manifest.xml` | CEF 파라미터 `--enable-nodejs`, `--mixed-context` 추가 | 패널이 Node 파일 API로 명령 파일을 읽고 쓰려면 필요. 없으면 브리지가 침묵한다 |
| `cep-plugin/main.js` | Node 모듈을 `require` 또는 `window.cep_node.require`로 안전하게 얻고, 임시 폴더를 `os.tmpdir()/premiere-mcp-bridge`로 잡으며(저장 키 `mcp_bridge_temp_dir_v2`), Node가 없을 때 안내를 남김 | 패널 컨텍스트에 따라 `require`가 없어 파일 API가 죽던 문제. 임시 폴더는 `paths.mjs`의 기본값과 같은 규칙 |
| `cep-plugin/CSInterface.js` | `evalScript(script, callback)`에 콜백이 없을 때의 방어 | 콜백 없는 호출에서 예외가 나던 문제 |
| `dist/bridge/script-builder.js` | 효과·속성을 이름으로 찾을 때 한국어 UI 이름(모션·비율 조정·불투명도 등)도 검색(`__findComponentOnClip`, `__findPropertyOnComponent`) | 한국어 Premiere에서 영어 이름만 찾으면 실패 |
| `dist/tools/transitions.js` | Premiere 26.3에서 전환 추가: `getVideoTransitionByName` → 컷 지점의 클립 확인 → 기본 추가 뒤 시작·끝·길이 보정(`defaultAddThenAdjustStartEnd`, `durationMatched`) | 26.3에서 전환 API 동작이 달라져 기존 경로가 실패 |
| `dist/tools/export.js` | `capture_frame`에 `Sequence.exportFramePNG`가 없을 때 프로그램 모니터 창을 `PrintWindow`로 캡처하는 대안(`capturePremiereWindowToPng`) | 일부 판에서 프레임 내보내기 API가 없음 |
| `dist/tools/keyframes.js`, `timeline.js`, `track-targeting.js` | 위 변경에 맞춘 보조 수정(속성 탐색·트랙 대상 지정·타임라인 조회) | 같은 원인 |

검증: `npm run premiere:mcp:env`가 패널 설치·플래그·각 패치의 존재를 확인한다.
