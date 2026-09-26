# Premiere Servers

| 경로 | 역할 |
| --- | --- |
| `premiere-control-mcp/` | 전체 capability를 UXP·CEP·Remotion wrapper로 연결하는 통합 MCP |
| `premiere-uxp-mcp/` | Adobe UXP bridge 명령과 capability registry를 제공하는 MCP |

일반 작업은 `docs/agent/workflows/premiere-control.md`가 선택한 on-demand wrapper를 실행한다. 현재 기능 상태는 `servers/premiere-uxp-mcp/capabilities.json`과 실제 호출 read-back으로 확인한다.
