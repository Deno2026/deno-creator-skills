"""대화 압축 직후 에이전트에게 문서를 원문으로 다시 읽으라고 알린다.
코덱스(.codex/hooks.json)와 클로드 코드(.claude/settings.json)의 SessionStart(compact) 훅이 함께 쓴다.
두 도구가 공통으로 읽는 JSON(hookSpecificOutput.additionalContext)을 내보내며, 한글이 셸 인코딩에 깨지지 않도록 ASCII 이스케이프로 출력한다.
규칙 본문은 AGENTS.md가 소유하고 여기서는 알림만 낸다. (DenoMCP 스타터 킷)"""

import json
import sys

REMINDER = "[압축 알림] 방금 대화가 압축돼 앞에서 읽은 문서는 요약만 남았다. 다음 행동 전에 AGENTS.md와 docs/agent/routes.json에 적힌 지금 작업의 문서를 원문으로 다시 읽고, 진행 중인 작업의 상태 파일이 있으면 그것도 다시 읽는다. 요약에 남은 기억으로 이어가지 않는다."


def main() -> int:
    payload = {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": REMINDER}}
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
