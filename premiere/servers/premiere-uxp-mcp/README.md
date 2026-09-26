# DENO Premiere UXP MCP

Node stdio MCP가 명령과 인자를 Premiere UXP plugin의 `PluginData/bridge`에 전달한다. bridge directory는 활성 PluginData를 자동 탐색하며, 명시적 고정은 `PREMIERE_UXP_BRIDGE_DIR` 또는 `--bridge-dir <path>`를 사용한다.

## 실행

```powershell
node servers/premiere-uxp-mcp/call-tool.mjs get_premiere_state
node servers/premiere-uxp-mcp/call-tool.mjs <tool> '<json>' --allow-write
```

- 읽기 도구는 바로 호출한다.
- reversible Premiere mutation은 `--allow-write`를 사용한다.
- 저장·삭제·export·AME·relink·global preference처럼 별도 위험 경계가 있는 도구는 사용자의 해당 요청과 `--allow-dangerous`를 사용한다.
- `local-unverified` handler의 live 검증은 `--allow-experimental`을 함께 사용한다.

`live-verified`, `implemented-live-check`, `ported`, `ported-caveat`, `live-read-caveat` handler는 요청 범위에서 호출하고 실제 응답을 read-back한다. 실행 가능 여부와 route는 `capabilities.json`이 제공한다.

## 구성

| 파일 | 역할 |
| --- | --- |
| `extract-upstream-schemas.mjs` | upstream tool schema 추출 |
| `schemas/local-tools.json` | DENO local tool schema |
| `tool-catalog.mjs` | upstream·local schema 병합 |
| `enabled-tools.json` | 설치 package에 등록할 handler 목록 |
| `bridge-client.mjs` | 요청 파일, queue, timeout, cleanup |
| `index.mjs` | MCP surface와 capability policy |
| `call-tool.mjs` | on-demand 호출 client |
| `capabilities.json` | 현재 route·availability·evidence registry |

## 검증

```powershell
npm run premiere:uxp:check-types
npm run premiere:uxp:lint
node servers/premiere-uxp-mcp/self-test.mjs
npm run premiere:capabilities:check
```

새 handler는 schema, 구현, write policy, offline test, capability entry를 한 변경으로 완성한다. live 검증 결과는 capability 상태와 bounded read-back 조건에 반영한다.
