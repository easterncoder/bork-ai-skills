---
name: bork-review
description: Perform adversarial code review of a PR with evidence-backed findings against its base and linked issue in the coordinated bork-review/bork-fix loop.
---

# BORK Review

Apply the shared [profile contract](../bork-doitall/references/profile.md) before starting. Preserve any supplied profile in nested calls; default to `generic`.

## Goal and Shared Contract

Review the active PR adversarially: actively try to falsify its correctness claims, verify concrete failure paths, record blocking findings and external-finding dispositions, and coordinate with `bork-fix` until clean or blocked.

Before starting, read [the shared coordination contract](references/coordination.md). Follow its lifecycle ownership, atomic handoffs, retained records, and context rules. Under `bork-goodcode`, use the supplied run directory and never initialize or clean up independently. When invoked standalone, read [owner lifecycle](references/owner-lifecycle.md) for initialization and cleanup. Read [review context](references/review-context.md) for collection; fixers do not load that reference.

## Loop

For a doitall run, read [extra instruction routing](../bork-doitall/references/instruction-routing.md) and load the brief's `instruction_paths` before reviewing. Run as a worker owned by goodcode through its recorded Herdr, tmux or native driver. Treat scoped acceptance criteria as product intent, carry applicable constraints into findings, and record instruction dispositions in `review.json`. Own findings and dispositions, not source edits, pushes or target phase changes. Report any interactive blocker to goodcode with the exact prompt and saved evidence path.

On resuming your recorded role with status `reviewing`, reconcile the current pass, HEAD, and any completed work first, then continue the interrupted phase. Do not enter the normal wait loop and wait on your own unfinished phase. Block if ownership or mutation results are ambiguous.

1. Wait for `coded`, `good`, or `blocked` within your active turn. On `blocked`, report the recorded blocker and stop. On `good`, acknowledge completion and follow the contract's cleanup rules.
2. Verify run, branch, and expected HEAD, then atomically publish `reviewing`.
3. Gather or refresh relevant PR and linked-issue context using the shared contract. Resolve and record the base SHA; use the recorded base repository and resolved base SHA, without assuming `origin` identifies the base. Verify branch and PR identity against the session. In orchestrated mode the local branch is the recorded temporary branch, while API context comes from the explicit PR URL and recorded base repository. Local HEAD may be ahead of the remote while fixes await a push.
4. Check the PR for merge conflicts under Merge Conflicts below before anything else. If it conflicts, publish the conflict handoff and skip the rest of this pass. Otherwise evaluate check/run failures and saved automation evidence under the shared contract, then choose scope using Review Scope below. Use the PR, issue, and relevant conversation as product intent, not as a file or acceptance-criteria boundary. Inspect enough surrounding behavior to find credible reviewer-blocking problems in one pass. Focus on correctness, regressions, security, data loss, release blockers, and missing required coverage, plus verifiable low-impact defects and violations of the project's coding standards. Exclude nits, style preferences, optional refactors, and non-blocking suggestions. Apply [quality checks](references/quality-checks.md): pattern and consumer search, the pre-push sweep, and test quality (would the test still pass with the fix reverted, or is it tautological). Also check reuse: an existing helper that should have been used, or a second source of truth for one rule. Report only what the code proves, naming the input or state that reaches it and what breaks; never raise a finding from a comment, docblock or PR description, and treat zero findings as a good outcome.
4a. Check companion PRs from the PR body, linked issue, author and branch name (`gh search prs --owner <org> --state open --head <branch>`). Changes often ship as a set such as core plus add-on. Compare both sides for agreed names, shapes, types, error handling and merge order, and report findings against a companion in this review. A change that implies a companion that does not exist, such as an endpoint or hook nothing consumes, is itself a finding.
4b. When goodcode's worker prompt sets `bot_rehearsal`, follow Bot Rehearsal below.
5. Evaluate external findings independently under External Change Requests below. Record their provenance and explicit dispositions, including reasons no change is needed. Verify newly fixed findings against changed code and relevant validation before accepting them. Carry forward unaffected prior conclusions by record reference. Preserve prior findings and outcomes in the run history.
6. Verify branch, HEAD, and resolved base SHA have not changed during review. If they changed, publish an operational blocker rather than handing off stale findings.
7. Save this pass's `review.json`, then atomically replace `.review`. If actionable blocking findings remain, publish `reviewed` and wait for the next `coded`. If no required findings remain unresolved and the PR merges cleanly with its base, publish `good`, save your completion acknowledgment, and follow the shared completion rules.

## Review Scope

Apply the Adversarial Review Method below within the chosen scope on every source-review pass, including fixes. Evidence reuse still applies; challenge the changed behavior and invalidated assumptions without repeating unaffected coverage.

- First pass in a run: review the full PR unless a supplied baseline passes [evidence reuse](references/reuse.md). An accepted baseline permits exact/delta source coverage while every new finding and current check failure is still evaluated. Save `reviewed_head`, `base_sha`, context revision, coverage, and unresolved finding IDs.
- Later passes, including after a push: inspect the diff from the last completed review HEAD, affected callers/contracts/tests, unresolved findings, and new or changed external evidence. A cycle boundary alone does not require a full review. Apply runtime invalidation rules; broaden to the full PR if the baseline is missing/not an ancestor, the base or product intent changes materially, or cross-cutting changes invalidate prior coverage.
- On no code/context/check changes, carry forward established coverage and conclusions rather than rereading files. Still verify current branch/HEAD/base and resolve all required findings before `good`.
- Treat changed lines as the starting point, not the review boundary. Follow affected callers, callees, public contracts, state transitions, persistence paths, configuration, migrations, and tests when the change can alter their behavior or assumptions.
- Search for parallel implementations and other consumers when a changed invariant, API, schema, hook, or shared helper may require coordinated updates. Inspect relevant repository conventions when they are needed to distinguish a defect from an intentional pattern.
- Review the complete relevant function or execution path when needed to judge a delta. Include nearby unchanged code only when the PR interacts with it, depends on it, exposes an existing defect through a new path, or makes that defect materially more likely.
- The linked issue and acceptance criteria are the minimum product contract, not an exhaustive defect list. Report additional blockers when they are caused or exposed by the PR, undermine its intended behavior, or are reasonably likely to block approval of this PR.
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

Fix valid external change requests in the current PR whenever they have even a slight concrete connection to its purpose, behavior, implementation, affected code, dependencies, or tests. Include these requests in the fixer's blocking handoff and require verified fixes before publishing `good`. This rule takes precedence over the general scope exclusions for external change requests: being pre-existing, outside changed lines, absent from acceptance criteria, or larger than expected does not justify deferral when the request is related to the PR.

Reserve out-of-scope tracking issues for valid, important requests that are wholly unrelated to the PR. Record explicit evidence explaining that lack of connection in `review.json`. If relevance is uncertain, investigate and default to fixing in the PR when any concrete connection exists; do not use a tracking issue to bypass uncertainty or an implementation blocker. Continue rejecting invalid findings with evidence and distinguishing optional suggestions from actual change requests.

## Bot Rehearsal

Only when the worker prompt sets `bot_rehearsal`, load the checklist and conditions from the supplied profile. Apply the ordinary evidence and scope rules to every candidate finding; a rehearsal does not widen source scope or count as an external review request. Save output outside the repository and verify every finding before handoff. Record any profile-requested bot-depth caveat as a report note, not a source blocker.

## Review Output

Use stable sequential finding IDs (`F001`, `F002`, and so on) across the run. Include run ID, cycle, pass, branch, reviewed HEAD, base SHA, and the durable review record path in `.review`, followed by findings in this form:

```md
# Review

- id: F001; severity: high; file: path:line; impact: blocking risk; fix: concrete required change
```

Use `critical` for data loss, security exposure, or release blockers; `high` for common-path functional breaks or high-risk regressions; `medium` for required correctness or coverage gaps; `low` for a verifiable defect or standards violation of small impact, such as a missing edge-case guard, a misleading name, or a docblock that contradicts the code, limited to changed lines or code they directly affect. Include `low` findings in the fix handoff and require them fixed before `good`. Never include preferences or non-blocking suggestions. Full provenance and dispositions belong in `review.json` under the shared contract.

Use the [TLDR report](references/reporting.md) for user-facing output; full findings remain in durable records and the fix handoff. For a clean pass, write a concise clean summary after saving the durable record. For unavailable required context or other operational failures, save a blocker record and publish `blocked`; do not route the failure to the fixer as a source-code finding.

## Safety

- Do not edit source files or create commits during review.
- Never stage or commit coordination files or run records.
- Stay in the loop until `good`, `blocked`, or a reported inconsistency. Keep waits inside the active turn.
