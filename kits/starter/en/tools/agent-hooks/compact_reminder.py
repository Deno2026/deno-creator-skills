"""Reminds the agent to re-read the source documents right after the conversation is compacted.
Used by both the Codex hook (.codex/hooks.json) and the Claude Code hook (.claude/settings.json) — SessionStart, matcher "compact".
Prints the JSON both tools read (hookSpecificOutput.additionalContext), ASCII-escaped so non-ASCII text survives any shell encoding.
The rule itself lives in AGENTS.md; this file only sends the reminder. (DenoMCP starter kit)"""

import json
import sys

REMINDER = "[Compaction notice] The conversation was just compacted; the documents read earlier survive only as a summary. Before the next action, re-read AGENTS.md and the documents docs/agent/routes.json lists for the current task in full, plus the state file of any work in progress. Do not continue from the summary alone."


def main() -> int:
    payload = {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": REMINDER}}
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
