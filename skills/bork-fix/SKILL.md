---
name: bork-fix
description: Fix blocking findings from bork-review, validate, and commit in the coordinated PR fix loop.
---

# BORK Fix

Apply the shared [profile contract](../bork-doitall/references/profile.md) before starting. Preserve any supplied profile in nested calls; default to `generic`.

## Coding Principles

Apply these principles within this skill's planning, implementation, review, or fix role, without relying on AGENTS.md to supply them:

- **DRY (Don't Repeat Yourself):** Avoid duplicated logic by extracting reusable functions, classes, or modules.
- **SoC (Separation of Concerns):** Keep functions, classes, and features focused on a single responsibility and isolate unrelated behavior.
- **KISS (Keep It Simple):** Do only what the task or plan calls for. No extra abstractions, refactors of untouched code, or helpers and wrappers added only for tests. Keep diffs small; DRY and SoC never justify growing a PR beyond its scope.
- **YAGNI (You Aren't Gonna Need It):** Build only what current requirements need. Do not add features, extension points, or abstractions for hypothetical future use.
- **No bloat:** Do not introduce or request unnecessary code, dependencies, configuration, abstractions, helpers, wrappers, or tests. Every addition must directly support an in-scope requirement or demonstrated regression. Prefer the smallest clear solution using existing project patterns; do not grow the change for speculative reuse, optional cleanup, or review preferences.
- **Requirement scope:** Limit planning, implementation, and fixes to the issue and PR requirements, explicit user constraints, approved clarifications, and concrete regressions introduced or exposed by the change. Each edit must satisfy an in-scope requirement or correct a demonstrated regression using the smallest necessary change. A shared file, subsystem, dependency, or external review request does not expand scope. Leave adjacent cleanup, optional refactors, speculative hardening, and unaffected pre-existing defects for separate work; record material discoveries without adding them to this implementation.

## Goal and Shared Contract

Fix only blocking findings from `bork-review`, validate them, create a signed commit, and hand control back for review.

Before starting, read [the shared coordination contract](../bork-review/references/coordination.md). Follow its lifecycle ownership, atomic handoffs, retained records, and context rules. Use the supplied run directory under `bork-goodcode`; standalone, wait for the review owner's initialization. Never initialize a run or delete coordination files yourself.

## Loop

For a doitall run, read [extra instruction routing](../bork-doitall/references/instruction-routing.md) and load the brief's `instruction_paths` before fixing. Run as a worker owned by goodcode through its recorded Herdr, tmux or native driver. Apply scoped constraints to the reviewer's blocking handoff and record instruction dispositions in `fix.json`. Own source fixes and validation for blocking findings, not review judgments, pushes or target phase changes. An extra instruction alone does not authorize unrelated edits; return unmet requirements outside the handoff for reviewer assessment. Report any interactive blocker to goodcode with the exact prompt and saved evidence path.

On resuming your recorded role with status `coding`, reconcile the current pass, HEAD, and any completed work first, then continue the interrupted phase. Do not enter the normal wait loop and wait on your own unfinished phase. Block if ownership or mutation results are ambiguous.

1. Wait for `reviewed`, `good`, or `blocked` within your active turn. On `good`, save your completion acknowledgment and end the cycle turn under the shared completion contract. On `blocked`, report the recorded blocker and stop.
2. Consume the supplied runtime brief, `.review`, and the referenced findings from durable `review.json`; reuse the owner's resolved identity and cached product intent. Verify run, cycle, pass, branch, reviewed HEAD, and base SHA against the current repository and active run. Missing or empty findings, non-actionable handoffs, or mismatched context are operational blockers. Do not edit against stale findings.
3. Atomically publish `coding`. Inspect the worktree and preserve unrelated changes. Reuse the review context snapshot, refreshing relevant context only as the shared contract requires.
4. Fix only the blocking findings in this handoff that meet the requirement scope above. Each finding must identify an unmet issue or PR requirement or a concrete PR regression. A verified merge conflict with the selected base is an in-scope delivery requirement under the reviewer's Merge Conflicts rules; limit resolution to preserving the intended behavior of both sides. If that link is missing or the requested fix expands scope, preserve the evidence and block for reviewer reassessment before editing; do not silently drop or implement the finding. Do not perform optional refactors, nits, or unrelated cleanup.
   Apply [quality checks](../bork-review/references/quality-checks.md) to the fix: search for the same defect at other call sites, but edit them only when covered by the handoff and requirement scope; return additional candidates to the reviewer. Run the pre-push sweep over touched code, and delete or correct any comment the fix made untrue. A new test must fail with the fix reverted.
5. Validate with the narrowest relevant tests or checks available, using the project's declared commands on touched files and affected tests by default, plus any broader validation explicitly required by applicable user or repository instructions. If a finding cannot be fixed safely, save a blocker record and publish `blocked`. Do not make a partial commit; preserve and describe any uncommitted work.
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
