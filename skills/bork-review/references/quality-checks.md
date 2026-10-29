# Quality Checks

Shared by review, fix and prify. Apply to the code the change touches; these never widen scope beyond what the PR caused or left half finished.

## Pattern and Consumer Search

- Search for the predicate or call shape being corrected. A fix at one call site routinely leaves the same defect at others; fix those in the same change.
- When a shared API, hook, filter, schema or helper changed, search dependent repositories for callers and subclasses. Clone them shallow into scratch, never into the user's checkouts. Absence of a needed companion change is itself a finding.
- Confirm the method that runs is the one assumed: check overrides, traits and base classes.

## Pre-push Sweep

Check what automated reviewers reliably flag so it does not cost a cycle:

- Raw superglobals and dynamic variable extraction.
- Missing sanitization or escaping; unquoted attributes in generated markup.
- Missing capability, nonce or ownership checks on new paths.
- Dead or unreachable branches; unused parameters.
- Stale docblocks and comments the change made untrue; delete or correct them.
- Brace and indent style against the surrounding file.
- Behavior changes that break existing links or stored data.

## Tests

- A bug fix needs a test only when the project has a suite. The test must fail with the fix reverted; one that passes either way is worse than none.
- Reject tests that assert a mock or their own setup, or that are green because the code under test never ran.

## Declared Commands

Read the project's declared commands (`composer.json`, `package.json`, `Makefile`, CI workflow) instead of inventing an invocation. Run them on touched files and the tests covering them only; CI owns the full suite and whole-repo lint. Some repositories ship no linter on purpose.
