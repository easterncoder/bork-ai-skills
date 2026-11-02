---
name: bork-review
description: Perform adversarial code review of a PR with evidence-backed findings against its base and linked issue in the coordinated bork-review/bork-fix loop.
---

# BORK Review

Apply the shared [profile contract](../bork-doitall/references/profile.md) before starting. Preserve any supplied profile in nested calls; default to `generic`.

## Coding Principles

Apply these principles within this skill's planning, implementation, review, or fix role, without relying on AGENTS.md to supply them:

- **DRY (Don't Repeat Yourself):** Avoid duplicated logic by extracting reusable functions, classes, or modules.
- **SoC (Separation of Concerns):** Keep functions, classes, and features focused on a single responsibility and isolate unrelated behavior.
- **KISS (Keep It Simple):** Do only what the task or plan calls for. No extra abstractions, refactors of untouched code, or helpers and wrappers added only for tests. Keep diffs small; DRY and SoC never justify growing a PR beyond its scope.
- **YAGNI (You Aren't Gonna Need It):** Build only what current requirements need. Do not add features, extension points, or abstractions for hypothetical future use.
- **No bloat:** Do not introduce or request unnecessary code, dependencies, configuration, abstractions, helpers, wrappers, or tests. Every addition must directly support an in-scope requirement or demonstrated regression. Prefer the smallest clear solution using existing project patterns; do not grow the change for speculative reuse, optional cleanup, or review preferences.

## Goal and Shared Contract

Review the active PR adversarially: actively try to falsify its correctness claims, verify concrete failure paths, record blocking findings and external-finding dispositions, and coordinate with `bork-fix` until clean or blocked.

Before starting, read [the shared coordination contract](references/coordination.md). Follow its lifecycle ownership, atomic handoffs, retained records, and context rules. Under `bork-goodcode`, use the supplied run directory and never initialize or clean up independently. When invoked standalone, read [owner lifecycle](references/owner-lifecycle.md) for initialization and cleanup. Read [review context](references/review-context.md) for collection; fixers do not load that reference.

## Loop

For a doitall run, read [extra instruction routing](../bork-doitall/references/instruction-routing.md) and load the brief's `instruction_paths` before reviewing. Run as a worker owned by goodcode through its recorded Herdr, tmux or native driver. Treat scoped acceptance criteria as product intent, carry applicable constraints into findings, and record instruction dispositions in `review.json`. Own findings and dispositions, not source edits, pushes or target phase changes. Report any interactive blocker to goodcode with the exact prompt and saved evidence path.

On resuming your recorded role with status `reviewing`, reconcile the current pass, HEAD, and any completed work first, then continue the interrupted phase. Do not enter the normal wait loop and wait on your own unfinished phase. Block if ownership or mutation results are ambiguous.

1. Wait for `coded`, `good`, or `blocked` within your active turn. On `blocked`, report the recorded blocker and stop. On `good`, acknowledge completion and follow the contract's cleanup rules.
2. Verify run, branch, and expected HEAD, then atomically publish `reviewing`.
3. Gather or refresh relevant PR and linked-issue context using the shared contract. Resolve and record the base SHA; use the recorded base repository and resolved base SHA, without assuming `origin` identifies the base. Verify branch and PR identity against the session. In orchestrated mode the local branch is the recorded temporary branch, while API context comes from the explicit PR URL and recorded base repository. Local HEAD may be ahead of the remote while fixes await a push.
4. Check the PR for merge conflicts under Merge Conflicts below before anything else. If it conflicts, publish the conflict handoff and skip the rest of this pass. Otherwise evaluate check/run failures and saved automation evidence under the shared contract, then choose scope using Review Scope below. Establish the scope from the issue and PR requirements, including explicit user constraints and approved clarifications. Inspect surrounding behavior only to verify those requirements or regressions introduced by this PR. Focus on correctness, regressions, security, data loss, release blockers, and missing required coverage, plus verifiable low-impact defects and violations of the project's coding standards. Exclude nits, style preferences, optional refactors, and non-blocking suggestions. Apply [quality checks](references/quality-checks.md): pattern and consumer search, the pre-push sweep, and test quality (would the test still pass with the fix reverted, or is it tautological). Check reuse only when duplication violates an applicable requirement or causes a concrete in-scope defect; do not require optional refactoring. Report only what the code proves, naming the input or state that reaches it and what breaks; never raise a finding from a comment, docblock or PR description, and treat zero findings as a good outcome.
4a. Inspect companion PRs only when the issue or PR requirements identify coordinated work, or a changed contract has a verified dependency on it. Compare only the interactions needed for this PR's requirements and compatibility. Report a missing companion change only when it demonstrably prevents this PR from meeting those requirements or causes a regression; do not audit the companion independently or assume every new endpoint or hook needs a consumer now.
4b. When goodcode's worker prompt sets `bot_rehearsal`, follow Bot Rehearsal below.
5. Evaluate external findings independently under External Change Requests below. Record their provenance and explicit dispositions, including reasons no change is needed. Verify newly fixed findings against changed code and relevant validation before accepting them. Carry forward unaffected prior conclusions by record reference. Preserve prior findings and outcomes in the run history.
6. Verify branch, HEAD, and resolved base SHA have not changed during review. If they changed, publish an operational blocker rather than handing off stale findings.
7. Save this pass's `review.json`, then atomically replace `.review`. If actionable blocking findings remain, publish `reviewed` and wait for the next `coded`. If no required findings remain unresolved and the PR merges cleanly with its base, publish `good`, save your completion acknowledgment, and follow the shared completion rules.

## Review Scope

Limit review findings and required fixes to the issue and PR requirements, explicit user constraints, and concrete regressions introduced or exposed by implementing them. Every finding must identify the unmet requirement or the PR change that causes the regression, with evidence. A shared file, subsystem, dependency, or general connection to the PR is insufficient. Apply this boundary to every severity, external request, quality check, companion PR, and follow-up pass. Mergeability with the selected base is a delivery requirement under Merge Conflicts below; resolving conflicts does not authorize unrelated behavioral changes.

Apply the Adversarial Review Method below within the chosen scope on every source-review pass, including fixes. Evidence reuse still applies; challenge the changed behavior and invalidated assumptions without repeating unaffected coverage.

- First pass in a run: review the full PR unless a supplied baseline passes [evidence reuse](references/reuse.md). An accepted baseline permits exact/delta source coverage while every new finding and current check failure is still evaluated. Save `reviewed_head`, `base_sha`, context revision, coverage, and unresolved finding IDs.
- Later passes, including after a push: inspect the diff from the last completed review HEAD, affected callers/contracts/tests, unresolved findings, and new or changed external evidence. A cycle boundary alone does not require a full review. Apply runtime invalidation rules; broaden to the full PR if the baseline is missing/not an ancestor, the base or product intent changes materially, or cross-cutting changes invalidate prior coverage.
- On no code/context/check changes, carry forward established coverage and conclusions rather than rereading files. Still verify current branch/HEAD/base and resolve all required findings before `good`.
- Treat changed lines as the starting point, not the review boundary. Follow affected callers, callees, public contracts, state transitions, persistence paths, configuration, migrations, and tests when the change can alter their behavior or assumptions.
- Search for parallel implementations and other consumers when a changed invariant, API, schema, hook, or shared helper may require coordinated updates. Inspect relevant repository conventions when they are needed to distinguish a defect from an intentional pattern.
- Review the complete relevant function or execution path when needed to judge a delta. Include nearby unchanged code only when the PR interacts with it, depends on it, exposes an existing defect through a new path, or makes that defect materially more likely.
- Use the issue and PR requirements as the product boundary. Existing behavior and callers establish compatibility expectations, not permission to add features or fix adjacent defects. Require only the smallest correction needed to meet the requirements or prevent a demonstrated PR regression.
- Do not expand into unrelated subsystem audits, speculative hardening, general technical debt, pre-existing defects unaffected by the PR, or changes whose only value is cleanup. A finding must explain its concrete connection to the PR and why resolving it belongs in this change.
- Complete the credible review field before handing off. Do not stop after the first finding when the same review pass can identify other blocking issues and reduce another reviewer cycle.
- Save the chosen scope, expansion reasons, inspected paths, and any explicit exclusions once in `review.json` so later passes can reuse the coverage safely.

## Adversarial Review Method

Treat the implementation, tests, PR narrative, prior approvals, and fixer explanations as claims to investigate. Seek realistic counterexamples to the intended behavior. Adversarial describes the scrutiny of the code, not the tone toward its author, and does not require finding a defect.

1. Establish the behavioral contract from the issue, applicable instructions, existing callers, and base behavior. Identify what must remain true, who can invoke the changed path, what data it accepts or persists, and which compatibility guarantees it relies on.
2. Identify the assumptions that could invalidate that contract. Prioritize changed trust boundaries, permission checks, data writes, shared contracts, and failure handling. Trace the actual entry point through validation, authorization, state changes, side effects, and response rather than judging isolated hunks.
3. Try concrete counterexamples appropriate to the path: missing or malformed input, boundary values and PHP type coercion, unauthorized or cross-owner access, old stored data, repeated or out-of-order requests, partial failures, retries, and concurrent execution. Investigate only scenarios supported by actual callers, runtime behavior, or deployment conditions; do not turn a generic checklist into speculative findings.
4. Compare the counterexample against the base and all affected consumers. Check whether guards, framework behavior, overrides, transactions, or downstream validation already prevent it. Establish how the PR causes, exposes, or materially worsens the failure, subject to the existing external-change-request rules.
5. Attempt to disprove each candidate finding before reporting it. Look for the strongest code-backed explanation that the behavior is intentional or safe, then resolve it against the contract and reachable execution path. Drop disproven candidates. For surviving findings, provide the triggering input or state, path and relevant file/line, expected versus actual behavior, impact, and concrete required fix. Use a focused reproduction or existing test when practical; a complete code trace can establish a defect when execution is unavailable. State what was executed and what remains unverified.
6. Challenge coverage as well as implementation: determine whether tests exercise the failing path and assert observable behavior, and whether they would fail if the claimed fix were reverted. Re-review fixes for bypasses, partial repairs, parallel call sites, and new regressions instead of accepting the fixer's explanation as proof.

Record the material assumptions challenged, evidence, validation limitations, and reasons for dismissing significant candidates in the existing `review.json` reasoning and coverage records. Keep rejected hypotheses out of the blocking handoff. Before publishing `good`, confirm that credible counterexamples in scope have been resolved or disproven and disclose any remaining validation limitations. Do not invent findings, impose a finding quota, or widen into unrelated audits to make a review appear adversarial.

## Merge Conflicts

Conflicts are checked first in every pass, ahead of source review, check failures and any wait for GitHub or bot reviews.

- Read `mergeable` and `mergeStateStatus` for the explicit PR URL. When GitHub reports `UNKNOWN`, re-read after short waits for up to about a minute before recording a limitation. Confirm locally, without touching the worktree or index, with `git merge-tree --write-tree --name-only <head> <resolved-base-sha>`; a nonzero exit or listed conflicted paths means a conflict. If the two disagree, trust the local result against the resolved base SHA and record both.
- A conflict is a blocking finding with severity `high`, always the first finding of the pass. List the conflicted files and the base SHA. The required fix is to merge the resolved base branch into the PR branch, never rebase or force-push, keep the intended behavior of both sides, rerun validation for the touched areas, and record a signed merge commit.
- When a conflict exists, hand off right away with `reviewed`. Do not review the pre-merge tree in depth: the merge changes the code under review, and GitHub does not run pull_request workflows or bot reviews on a conflicting PR, so waiting on them cannot succeed. Include blocking findings already identified without extending the pass.
- The pass after the merge commit has a new base SHA, so apply the runtime invalidation rules: review the conflict resolution hunks and base-introduced interactions first, then the usual scope.
- A PR that is only `BEHIND` its base with no conflict is not a finding. Never publish `good` while the PR conflicts with its base.

## External Change Requests

Evaluate external requests under the same Review Scope boundary as your own findings. Include a request in the blocking handoff only when verified evidence ties it to an unmet issue or PR requirement or a concrete regression introduced or exposed by this PR. External reviewer authority, severity, shared code, or a slight connection to the PR does not expand the requirements.

For valid, important requests outside that boundary, record a non-blocking out-of-scope disposition in `review.json`, explaining the unmet scope test and suggested separate follow-up. This includes related pre-existing defects that the PR neither exposes nor worsens. Do not add them to the fix handoff or require them before `good`. Investigate ambiguous scope against the requirements and code; if required context is unavailable, report an operational blocker instead of assuming authorization to expand the PR. Continue rejecting invalid findings with evidence and distinguishing optional suggestions from actual defects.

## Bot Rehearsal

Only when the worker prompt sets `bot_rehearsal`, load the checklist and conditions from the supplied profile. Apply the ordinary evidence and scope rules to every candidate finding; a rehearsal does not widen source scope or count as an external review request. Save output outside the repository and verify every finding before handoff. Record any profile-requested bot-depth caveat as a report note, not a source blocker.

## Review Output

Use stable sequential finding IDs (`F001`, `F002`, and so on) across the run. Include run ID, cycle, pass, branch, reviewed HEAD, base SHA, and the durable review record path in `.review`, followed by findings in this form:

```md
# Review

- id: F001; severity: high; file: path:line; impact: blocking risk; fix: concrete required change
```

Use `critical` for data loss, security exposure, or release blockers; `high` for common-path functional breaks or high-risk regressions; `medium` for required correctness or coverage gaps; `low` for a small-impact defect or violation of an applicable requirement introduced by the PR. A misleading name, stale docblock, or nearby standards violation is not automatically a finding; it must pass Review Scope with a demonstrated requirement or regression link. Include `low` findings in the fix handoff and require them fixed before `good`. Never include preferences or non-blocking suggestions. Full provenance and dispositions belong in `review.json` under the shared contract.

Use the [TLDR report](references/reporting.md) for user-facing output; full findings remain in durable records and the fix handoff. For a clean pass, write a concise clean summary after saving the durable record. For unavailable required context or other operational failures, save a blocker record and publish `blocked`; do not route the failure to the fixer as a source-code finding.

## Safety

- Do not edit source files or create commits during review.
- Never stage or commit coordination files or run records.
- Stay in the loop until `good`, `blocked`, or a reported inconsistency. Keep waits inside the active turn.
