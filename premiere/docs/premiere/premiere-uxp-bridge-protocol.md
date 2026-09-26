# Premiere UXP Bridge Protocol

이 문서는 `servers/premiere-uxp-mcp`와 `extensions/deno-premiere-uxp` 사이의 파일 브리지 규약을 정의한다. 작업 실행 정책은 `AGENTS.md`, 해당 workflow, 현재 capability registry가 소유한다.

## 1. 전송 원칙

- 요청은 등록된 command 이름과 JSON object 인자만 담는다.
- UXP 패널은 handler registry와 schema가 일치하는 command를 직렬 실행한다.
- 요청·상태·응답은 UTF-8 JSON이며 공개 전 임시 파일에 완전히 쓴 뒤 원자적으로 rename한다.
- MCP timeout 뒤 write는 재전송하지 않고 현재 Premiere 상태와 response 파일을 read-back한다.
- UXP와 CEP bridge는 서로 다른 디렉터리와 process lock을 사용한다.

## 2. Bridge 디렉터리

UXP 논리 경로는 다음과 같다.

```text
plugin-data:/bridge
```

manifest는 `localFileSystem: "plugin"`을 사용한다. Native path는 다음 패턴에서 실제 존재·활동 상태로 탐색한다.

```text
%APPDATA%\Adobe\UXP\PluginsStorage\PPRO\<version>\{Developer,External}\com.deno.premiere.uxp\PluginData\bridge
```

자동 탐색을 고정할 때는 하나의 exact path를 전달한다.

```text
PREMIERE_UXP_BRIDGE_DIR=<absolute path>
node servers/premiere-uxp-mcp/index.mjs --bridge-dir <absolute path>
node servers/premiere-uxp-mcp/call-tool.mjs ping --bridge-dir <absolute path>
```

CEP bridge는 `%LOCALAPPDATA%\Temp\premiere-mcp-bridge`를 사용한다. 각 bridge는 자기 파일만 읽고 정리한다.

## 3. 파일과 소유권

`sequence`는 20자리 10진수 문자열이고 `id`는 UUID다.

| 단계 | 파일 이름 | 소유자 |
| --- | --- | --- |
| 대기 | `req_<sequence>_<id>.json` | MCP server |
| 실행 | `run_<sequence>_<id>.json` | UXP panel |
| 상태·응답 | `res_<sequence>_<id>.json` | UXP panel |
| 기록 중 | `.tmp_<kind>_<sequence>_<id>_<nonce>` | 기록 주체 |

MCP server가 완성된 `req_`를 발행하면 UXP panel이 이를 `run_`으로 원자 rename해 실행 소유권을 얻는다. 실행 중과 완료 상태는 `res_`에 원자 발행하고 완료 후 `run_`을 정리한다.

## 4. Request envelope

```json
{
  "protocolVersion": 1,
  "id": "2d9ec3c4-786f-47c3-a467-d2549b70726d",
  "sequence": "00001721577234567890",
  "status": "pending",
  "command": "get_sequence_structure",
  "args": {},
  "createdAt": "2026-07-21T14:20:00.000Z",
  "timeoutMs": 30000,
  "maxRuntimeMs": 21600000,
  "client": {
    "name": "deno-premiere-uxp-mcp",
    "version": "0.1.0"
  }
}
```

필수 계약:

- `protocolVersion`은 `1`이다.
- `status`는 `pending`이다.
- `command`는 `^[a-z][a-z0-9_]*$` 형식이다.
- `args`는 JSON object다.
- 파일명과 본문의 `sequence`, `id`가 일치한다.
- 최대 request 크기는 UTF-8 JSON 2 MiB다.

## 5. Response envelope

```json
{
  "protocolVersion": 1,
  "id": "2d9ec3c4-786f-47c3-a467-d2549b70726d",
  "sequence": "00001721577234567890",
  "command": "get_sequence_structure",
  "status": "running",
  "ok": null,
  "progress": {
    "message": "트랙을 읽고 있습니다.",
    "percent": 40,
    "current": 2,
    "total": 5
  },
  "data": null,
  "error": null,
  "createdAt": "2026-07-21T14:20:00.000Z",
  "startedAt": "2026-07-21T14:20:00.120Z",
  "updatedAt": "2026-07-21T14:20:01.000Z",
  "completedAt": null
}
```

| `status` | `ok` | 결과 |
| --- | --- | --- |
| `pending` | `null` | request 대기 |
| `running` | `null` | `progress`, `updatedAt` 갱신 가능 |
| `done` | `true` | `data`에 command 결과 |
| `error` | `false` | `error`에 `code`, `message`, 선택적 `details` |

Response는 사용자에게 필요한 오류 정보만 반환하고 내부 stack trace, source path, 실행 코드는 포함하지 않는다.

## 6. 순서·timeout·정리

- MCP process는 단조 증가 `sequence`를 발급하고 Premiere command를 단일 lane에서 직렬 처리한다.
- UXP panel은 `req_`를 파일명 순서로 claim한다. polling cadence와 backpressure는 현재 extension code가 소유한다.
- `timeoutMs`는 상태 갱신이 없는 최대 시간이며 기본 30초, `ping`은 5초다.
- `maxRuntimeMs`는 절대 실행 상한이며 기본 6시간이다.
- 장시간 command는 `running` heartbeat를 갱신한다.
- 시작 시 bridge 전용 `req_`, `run_`, `res_`, `.tmp_` 중 24시간이 지난 파일만 정리한다.

## 7. 실행 권한과 read-back

- 읽기 command는 직접 실행한다.
- 일반 timeline write는 `--allow-write`를 사용한다.
- project lifecycle, project item 삭제, export/encode, relink/offline, global preference는 `--allow-write --allow-dangerous`를 사용한다.
- `local-unverified` command의 bounded diagnostic call은 `--allow-experimental`을 사용한다.
- `ported-caveat` command는 official handler로 실행하고 target/result를 read-back한다.
- Production wrapper가 있는 컷·Level·caption·overlay 작업은 wrapper의 checkpoint 계약을 사용한다.

쓰기 결과 확인은 해당 작업에 필요한 최소 범위로 한다. 컷은 target V/A와 batch duration, Level은 대상 값, caption은 active track과 cue, overlay는 placement와 non-target track을 확인한다. 최종에는 project/sequence identity와 요청 결과를 한 번 read-back한다.

## 8. 공식 API 제약

- TrackItem stable node ID getter가 없어 handler는 track/source/start 기반 synthetic ID를 사용한다. Timeline 구조가 바뀌면 현재 ID를 다시 읽는다.
- Video/audio track lock getter가 없어 `locked`/`isLocked`는 `null`이다.
- Component parameter는 localized display name을 사용할 수 있으므로 현재 runtime alias를 읽어 property를 찾는다.
- Transition creation은 official `matchName`을 사용한다.
- Caption text/timing/track 생성은 검증된 CEP imported-SRT route를 사용한다. Caption font, size, Track Style 복사는 공식 API가 제공하지 않는다.
- `get_work_area`와 `undo`는 현재 registry의 두 unavailable command다.

개별 command의 공식 API 근거와 지원 route는 `premiere-uxp-tool-coverage.md`의 해당 행과 `servers/premiere-uxp-mcp/capabilities.json`에서 확인한다.

## 9. 개발 검증

```powershell
npm run premiere:uxp:check-types
npm run premiere:uxp:lint
npm run premiere:control:self-test
npm run premiere:capabilities:check
```

`@adobe/premierepro@26.3.0`, manifest host version, vendored `docs/reference/premierepro.d.ts`, handler registry, schema, write policy, capability registry를 같은 변경에서 맞춘다.
