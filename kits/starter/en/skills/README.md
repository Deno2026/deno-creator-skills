# skills — production methods (packages) brought in from DenoMCP

- One package per file: `<slug>.md`, exactly as `deno_knowhow_get` returned it. Record each in `deno-kit.json` (the ledger): name, version, date installed, whole/partial.
- A package gives **purpose and the order of steps**: what the workflow is for, which stages it goes through, and what to decide with the user at each stage.
- The package's "this is how Deno does it" parts are examples. Expression, pacing, mood and numbers are the user's choices; if the user already has their own way, that comes first.
- Attached files (workflow JSON, tool scripts) come from the `files` URLs of `deno_knowhow_get`; keep them under `<slug>/` with the same names. When the version changes, the attachments' sha256 changes too.
- Updates: when the user asks, compare the ledger's versions with the server's and show only what changed; update only what the user picks. When you overwrite a file, bump its version in the ledger too.
