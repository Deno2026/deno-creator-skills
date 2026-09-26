# Agent guide (DenoMCP starter kit v7)

This repo is a workshop for making video and images together with AI agents (Claude Code, Codex, Hermes, ...).
This file is only the skeleton — the order of work and where to ask the user. What to make and how it should look is the user's decision.

## Reading order

1. This file.
2. `docs/agent/routes.json` — which documents to read first per task type.
3. `skills/` — installed production methods (packages), one file each. The ledger is `skills/deno-kit.json`.
4. For work on a production, its `productions/<title>/BRIEF.md` (purpose and direction) and `STATE.md` (progress).

## DenoMCP (connected MCP server)

- Use DenoMCP only for creative work such as video and images. Use `deno_briefing` to show what it can do.
- Don't announce updates yourself — they are written up on the website (denomcp.com/updates). If the user asks, open them with `deno_whats_new`.
- Show workflows and know-how (packages) as a list with their results; bring in only what the user picks. Never push suggestions or install anything unprompted. Never change the user's existing files without asking.
- When a package is brought in, save it as `skills/<slug>.md` and add one line to `skills/deno-kit.json` (the ledger): name, version, date, whole/partial. When the user asks "any Deno updates?", compare the ledger's versions with `deno_knowhow_get` and show only what changed; update only what the user picks.
- A package gives the purpose and the order of steps. Expression, pacing and mood are the user's choices — the package's "this is how Deno does it" parts are examples, not the standard.
- Before any paid generation (`generate`), run `deno_estimate`, tell the user the estimated credits and balance, and get confirmation.
- Upload references with `upload_asset` and pass asset_id. Download results from the `get_result` URL into `productions/<date_title>/renders/`.
- Execution is either local (the user's own ComfyUI) or commercial (credits). Offer local first when the machine can run it, otherwise commercial.
- When a long conversation is compacted, the documents read earlier survive only as a summary — before the next action, re-read this file and the documents `docs/agent/routes.json` lists for the current task in full (the hooks in `.codex/hooks.json` and `.claude/settings.json` remind you at that moment). Never continue from the summary alone.
- When one unit of work is done, start the next in a new session. For long work, keep the progress in `productions/<title>/STATE.md` so a fresh session can pick it up — quality drops as a conversation grows.

## Way of working

- Direction is decided with the user. Ask first what is being made and why (purpose, what to show, who watches), write it into `BRIEF.md`, then start — and check back at every fork.
- Confirm direction at the cheap stage before the expensive one: show a short, low-resolution check first; go to the full version when the user approves.
- Build and production requests run autonomously: scope → execute → verify → report. Explanation and diagnosis requests are read-only.
- Ask first for anything hard to undo: credits, public exposure, deletion.
- Outputs go to `productions/<date_title>/` (records in Git, generated files in `renders/` and git-ignored); temporary files go to `_scratch/`. The folder template is `productions/README.md`.
- The user judges results. Do not confuse "a file exists" with "the result is good". Editing and publishing are the user's too.

## Hard limits

- Never write keys or tokens into chat, documents or logs.
- Run only the generations the user asked for. Confirm before adding takes or targets.
- Never change this repo's existing files or workflows without asking (appending included).
