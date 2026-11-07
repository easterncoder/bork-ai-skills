---
name: bork-test
description: Run focused E2E and browser acceptance checks against an identified implementation, retain reproducible evidence, and return results to bork-goodcode without editing source.
---

# BORK Test

Validate affected user journeys against the issue/PR requirements. Apply the shared [profile contract](../bork-doitall/references/profile.md), preserving the supplied profile and relevant instruction paths. Use the project's existing tooling and declared commands; do not introduce a test framework or expand the implementation scope.

## Ownership and Inputs

Under `bork-goodcode`, run as an owner-executed skill after both review/fix workers stop, before publication and cleanup. Accept its dedicated worktree, explicit PR identity, reviewed HEAD/base, requirements, scoped instructions, current `validation_path`, and unique absolute result path outside the disposable worktree. Do not initialize a review cycle, change `.status` or `.review`, edit tracked source/tests/configuration, commit, push, promote, or post externally. Goodcode owns the lifecycle; only `bork-fix` changes source after reviewer verification.

Standalone invocation uses an explicitly identified checkout/commit and test environment. Preserve existing changes; identify actual dirty inputs when present. Report results without claiming review completion or authorization for fixes. Store evidence in a task-owned directory outside disposable worktrees and never stage it.

## Choose Coverage and Environment

1. Read repository instructions, scoped acceptance criteria, relevant code, existing tests, package scripts and CI configuration. Map affected journeys to observable expected behavior. Select the narrowest meaningful existing E2E coverage and browser acceptance checks. Include relevant roles/permissions, persistence, and negative paths where the changed behavior requires them. Honor required repository/user coverage without adding an unrelated audit.
2. Assess automated E2E and browser acceptance separately. Backend changes may need API/CLI E2E tests while browser checks are `not_applicable`; explain the scope reason. Changes affecting a browser journey require browser acceptance. Existing automated browser E2E coverage may satisfy both when its assertions cover the actual acceptance criteria. Screenshots or a page loading successfully alone do not establish behavioral correctness.
3. Use a disposable local environment or an explicitly authorized test environment. Verify it runs the supplied worktree/source or an identified build of the tested commit. Record how this mapping was verified; a URL, branch name, or matching local HEAD is insufficient. Do not test against an unrelated existing development server or assume a staging deployment matches. Isolate mutable databases, fixtures, accounts, uploads and service state from the original checkout and production. Use sandbox integrations for affected payments/messages or other external effects; ordinary browser access does not authorize real transactions or outbound messages.
4. Use the available project test runner and suitable browser tool, loading the applicable browser skill before tool use. If required tools, credentials, fixtures, or verified environment access are missing, record `blocked` with the exact prerequisite and recovery action. Missing tooling does not make a scenario `not_applicable`. Do not silently install a new framework, weaken checks, or change product source to make setup work.

## Execute and Retain Evidence

- Record branch, full tested HEAD/base, actual source content, requirement references, environment/build identity and intended scenarios before execution. Verify tracked source and HEAD remain unchanged afterward. A tool that rewrites tracked files invalidates the clean gate; report it and preserve the changes for owner reconciliation rather than resetting them.
- Run selected automated E2E commands and browser journeys. Assert observable outcomes such as saved state after reload, correct authorization, expected validation errors, or the relevant API/UI result. Capture full command logs and useful sanitized screenshots/traces or request evidence for failures. Record exact steps, role/fixture state, expected/actual outcomes, exit results, and browser/tool/runtime versions. Do not expose credentials, tokens, or private test data in retained or reported artifacts.
- For a failure, distinguish a reproducible product symptom from an infrastructure or test setup problem. Check relevant baseline behavior when needed and practical to distinguish pre-existing defects from PR regressions. Report candidates with evidence and the unmet requirement or changed path; leave final scope and finding IDs to `bork-review`. Never edit source or weaken assertions. Retain every failed attempt; an unexplained intermittent success does not erase a failure. Stop blind retries and report ambiguous failures as blocked.
- Reuse individual passing checks only under [validation handoff](../bork-review/references/reuse.md), after verifying current coverage and all relevant source/configuration/dependency/service/database/fixture inputs. Unknown inputs require a fresh run. A changed base or runtime invalidates affected evidence. Do not rerun unrelated suites solely because a new review pass started.
- Stop owned servers/browser sessions and clean up only explicitly recorded disposable fixtures/artifacts. Preserve failure evidence and unknown files. Record cleanup limitations so goodcode cannot remove a worktree still used by an owned process.

## Result and Handoff

Atomically write the result at the supplied path before returning. Include explicit PR/repository/worktree identity, run/cycle when orchestrated, timestamp, tested HEAD/base and source input hashes, served build provenance, relevant environment/configuration/dependency/fixture evidence, scenario requirements, commands or browser steps, tool versions, expected/actual results, log/artifact paths, reuse decisions, instruction dispositions, candidate defects, blockers/recovery actions, and owned process/fixture cleanup outcomes. Never record secrets.

Use `passed`, `failed`, `blocked`, or `not_applicable` for each scenario and the overall result. Overall `passed` requires every required scenario to pass and required cleanup to succeed. Use `failed` for an observed product acceptance failure with actionable reproduction evidence; use `blocked` for unavailable or inconclusive required validation or cleanup. Overall `not_applicable` requires an explicit scope explanation for both E2E and browser checks with no required coverage omitted. Keep all other scenario outcomes visible when the overall result is blocked.

Append checks and the test result path to the durable `validation.json` using its [existing evidence contract](../bork-review/references/reuse.md); preserve earlier attempts. Store artifacts outside the worktree. Report a concise outcome, coverage, evidence path, and any blocker. Goodcode independently accepts the gate, routes failures to review/fix, or blocks the run. A test result alone never declares the PR clean.
