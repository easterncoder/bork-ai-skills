# Quality Checks

Shared by review, fix and prify. Apply only to issue and PR requirements and concrete regressions introduced or exposed by the change. These checks never authorize adjacent cleanup, optional refactors, or fixes to unaffected pre-existing defects.

## Pattern and Consumer Search

- Search for the predicate or call shape being corrected. Include other call sites only when the requirements cover them or the PR introduces or exposes a regression there.
- When a shared API, hook, filter, schema or helper changed, search dependent repositories for callers and subclasses. Clone them shallow into scratch, never into the user's checkouts. A missing companion change is a finding only when evidence shows it is required for this PR to meet its requirements or avoid a regression.
- Confirm the method that runs is the one assumed: check overrides, traits and base classes.

## Pre-push Sweep

Check the following only within the requirement scope above. Automated reviewer preferences do not make an item mandatory. Correct only a verified requirement violation or PR regression:

- Raw superglobals and dynamic variable extraction.
- Missing sanitization or escaping; unquoted attributes in generated markup.
- Missing capability, nonce or ownership checks on new paths.
- Dead or unreachable branches; unused parameters.
- Stale docblocks and comments the change made untrue; delete or correct them.
- Brace and indent style on changed lines only when required by applicable project instructions; do not reformat surrounding code.
- Behavior changes that break existing links or stored data.

## Tests

- When the project has a suite, add or update a regression test if existing coverage does not verify the fix, or applicable instructions explicitly require one. Reuse sufficient existing tests instead of adding redundant coverage. A regression test must fail with the fix reverted.
- Reject tests that assert a mock or their own setup, or that are green because the code under test never ran.

## Declared Commands

Read the project's declared commands (`composer.json`, `package.json`, `Makefile`, CI workflow) instead of inventing an invocation. Default to touched files and tests covering the change. Run broader validation when explicitly required by applicable user or repository instructions; otherwise leave the full suite and whole-repo lint to CI. Some repositories ship no linter on purpose.
