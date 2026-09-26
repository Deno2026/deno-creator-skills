# How to use this workshop

A workshop for making video and images together with AI agents (Claude Code, Codex, ...). The DenoMCP starter kit sets the structure
and the order of work; what to make and how it should look is yours to decide. The agent asks you at every fork.

## Say things like this to your agent

- "What can I do with DenoMCP?" — what is available right now
- "What Deno skills are there?" / "Bring in the education-shorts package" — list and install production methods (packages)
- "Let's make one on my topic" — creates a production folder and starts by asking your purpose and direction
- "Any Deno updates?" — compares the packages you installed with the current versions and shows what changed
- "Write down the state and wrap up" — for long work, save the state file and continue in a fresh session

## Folders

- `AGENTS.md` — the skeleton the agent follows (order, where it asks you, hard limits)
- `docs/agent/routes.json` — which documents to read first per task type
- `skills/` — installed packages and the ledger (`deno-kit.json`)
- `productions/` — one folder per work (`BRIEF.md` purpose and direction, `STATE.md` progress, `renders/` generated files)
- `_scratch/` — temporary files

## Once

- The first time you open an agent here, it asks once whether to trust the hook (Codex, Claude Code). Confirming lets the agent re-read the documents after a long conversation is compacted.
- If Python is not installed, you can leave out `.codex/hooks.json` and `.claude/settings.json`.
