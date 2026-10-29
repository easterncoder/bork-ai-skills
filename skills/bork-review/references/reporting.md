# Default Reports

All five skills default to a TLDR that can be read at a glance. Use at most four short bullets for a single target, generally:

- Outcome and linked PR (or issue when blocked before publication).
- Validation: pass/fail plus a short limitation if relevant.
- Next action only when blocked; include the exact actionable reason.
- One link to durable details, only when useful.

Do not print commit lists, phase histories, full test commands, routine cleanup paths, model catalogs, or repeated all-clear claims. Keep required evidence in the durable result. Mention retained worktrees or skipped required work only when the user needs to act or understand a limitation. Provide details when asked.

Doitall preserves its exact `Done` line and blank line, then uses one concise row/bullet per target: linked PR, complete/blocked/skipped, validation, and blocker if any. Add at most one batch details link. `Done` means execution ended, not universal success. Persist session attach commands and per-target evidence in the batch result; print attach instructions only for a blocked interactive session or when requested.

Progress updates are one short sentence about a meaningful change. During long waits, use the host's required cadence without repeating unchanged evidence. Report actual measured token savings only when comparable usage data exists.
