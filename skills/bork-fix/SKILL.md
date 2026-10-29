---
name: bork-fix
description: Fix blocking findings from bork-review, validate, and commit in the coordinated PR fix loop.
---

# BORK Fix

Apply the shared [profile contract](../bork-doitall/references/profile.md) before starting. Preserve any supplied profile in nested calls; default to `generic`.

## Goal and Shared Contract

Fix only blocking findings from `bork-review`, validate them, create a signed commit, and hand control back for review.

Before starting, read [the shared coordination contract](../bork-review/references/coordination.md). Follow its lifecycle ownership, atomic handoffs, retained records, and context rules. Use the supplied run directory under `bork-goodcode`; standalone, wait for the review owner's initialization. Never initialize a run or delete coordination files yourself.

## Loop

For a doitall run, read [extra instruction routing](../bork-doitall/references/instruction-routing.md) and load the brief's `instruction_paths` before fixing. Run as a worker owned by goodcode through its recorded Herdr, tmux or native driver. Apply scoped constraints to the reviewer's blocking handoff and record instruction dispositions in `fix.json`. Own source fixes and validation for blocking findings, not review judgments, pushes or target phase changes. An extra instruction alone does not authorize unrelated edits; return unmet requirements outside the handoff for reviewer assessment. Report any interactive blocker to goodcode with the exact prompt and saved evidence path.

On resuming your recorded role with status `coding`, reconcile the current pass, HEAD, and any completed work first, then continue the interrupted phase. Do not enter the normal wait loop and wait on your own unfinished phase. Block if ownership or mutation results are ambiguous.

1. Wait for `reviewed`, `good`, or `blocked` within your active turn. On `good`, save your completion acknowledgment and exit. On `blocked`, report the recorded blocker and stop.
2. Consume the supplied runtime brief, `.review`, and the referenced findings from durable `review.json`; reuse the owner's resolved identity and cached product intent. Verify run, cycle, pass, branch, reviewed HEAD, and base SHA against the current repository and active run. Missing or empty findings, non-actionable handoffs, or mismatched context are operational blockers. Do not edit against stale findings.
3. Atomically publish `coding`. Inspect the worktree and preserve unrelated changes. Reuse the review context snapshot, refreshing relevant context only as the shared contract requires.
4. Fix only the blocking findings in this handoff. Respect PR and linked-issue intent. Do not perform optional refactors, nits, or unrelated cleanup.
   Apply [quality checks](../bork-review/references/quality-checks.md) to the fix: search for the same defect at other call sites and fix those too, run the pre-push sweep over touched code, and delete or correct any comment the fix made untrue. A new test must fail with the fix reverted.
5. Validate with the narrowest relevant tests or checks available, using the project's declared commands on touched files only. If a finding cannot be fixed safely, save a blocker record and publish `blocked`. Do not make a partial commit; preserve and describe any uncommitted work.
6. Recheck branch, pre-fix HEAD, base SHA, and phase ownership. Stage only intended changes, using hunks where unrelated changes share files. Inspect the staged diff and exclude coordination files and records.
7. Create one signed Conventional Commit for the fix pass using the explicit doitall `commit_email` from its brief when supplied, otherwise the identity required by applicable user/repository instructions, falling back to local Git `user.email` (block if unavailable), and the repository's existing signing setup. Use a concise title describing the actual fix, with at most five factual body bullets and no co-authorship mention. Use runtime `verify-commits` for the new range, retain its result, and ensure the commit contains only the intended changes.
8. Save `fix.json` mapping finding IDs to the commit and validation, then atomically publish `coded` with the new expected HEAD recorded. Leave `.review` available for the reviewer. Repeat the loop.

Use the [TLDR report](../bork-review/references/reporting.md) for user-facing updates and completion. Keep full validation and finding-to-commit mappings in `fix.json`.

## Safety and Recovery

- Do not push.
- Never stage or commit `.status`, `.review`, or run records.
- If access, validation, signing, or coordination prevents a safe handoff, record an operational blocker and publish `blocked` while you own the phase. Follow the shared contract if a problem is discovered while waiting.
- If no code change is needed despite a blocking handoff, record the evidence and block for reviewer reassessment. Do not create an empty commit or silently mark the finding fixed.
- If interrupted after committing, reconcile HEAD and the intended commit before completing its record and handoff. Never blindly create a duplicate commit. Stop if commit provenance is ambiguous.
