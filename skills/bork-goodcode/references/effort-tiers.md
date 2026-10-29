# Effort Tiers

Goodcode picks the models and reasoning effort for `bork-review` and `bork-fix` from a tier chosen for the PR, so small or low-risk PRs do not run at the highest settings. The model ranking and exclusions in Resolve Models still apply; a tier only selects a position in the eligible ranking and an effort level.

## Choose the tier

Compute once per goodcode run from the explicit PR, and cache `effort_tier`, its inputs and the resulting model/effort bindings in `session.json`. Count only meaningful files and lines: exclude lockfiles (`*.lock`, `*-lock.*`), `vendor/`, `dist/`, `node_modules/` and `*.min.js`.

- `high` when any applies: the diff touches payments, billing, checkout, auth, permissions, security, privacy, licensing, encryption or secrets, data migrations or destructive data changes; it changes a shared library or a public API or hook contract used across products; it has 25 or more meaningful files or 1,000 or more changed lines.
- `low` only when all apply: at most 5 meaningful files and 200 changed lines; no `high` area touched; the title type is `docs`, `test`, `chore` or `ci`, or the change is limited to documentation, tests, comments or static text.
- `standard` otherwise, including stacked PRs that do not meet `high`.

The thresholds are starting values, not measured limits. A risky area raises the tier regardless of size. A lowering title type never lowers a tier when a `high` area is touched.

An explicit `effort_override` (`low`, `standard` or `high`) from the brief sets the starting tier instead of the computed one. Escalation below still applies.

## Models and effort per tier

Models come from the ranking in Resolve Models.

| Tier | Review | Fix |
|---|---|---|
| `low` | next-most-recent model, `medium` | next-most-recent model, `low` |
| `standard` | next-most-recent model, `high` | next-most-recent model, `medium` |
| `high` | most recent model, `high` | next-most-recent model, `high` |

If the host exposes only one eligible model, use it for both agents at the tier's effort and report the fallback. If the host exposes no effort control, put the tier's effort in each agent's prompt and report the substitution.

## Escalate

Raise the tier one step (`low` to `standard`, `standard` to `high`) when two completed cycles in a row end without reaching `good`. Apply it from the next cycle, re-resolve the bindings, and record the old and new tier, the cycle and the reason in `session.json`. Never lower the tier within a run. The Loop Guard stops still apply at every tier.

## Report

State the final tier, whether it came from computation or an override, the models and effort used per role, and any escalation in the goodcode result and the final report. Doitall's plan preview carries only an estimate made before the PR diff exists; when goodcode's computed tier differs, report both. A higher computed tier applies at once. A lower one also applies, and the report says the estimate was higher.
