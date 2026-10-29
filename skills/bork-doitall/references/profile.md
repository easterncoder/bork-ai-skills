# Review Profiles

Profiles add supplied organization or repository rules to BORK workflows. They are separate from terminal `cli_profile` and never relax the selected skill's authorization, scope, ownership, reviewer, or merge gates.

## Resolution and routing

- Default to `generic`: no organization rules or special bot tags. Do not select a profile from repository owner, reviewer name, or user identity.
- Accept `PROFILE=generic` or `PROFILE=<absolute-readable-Markdown-file>`. An explicit user option overrides an inherited wrapper profile; resolve conflicting explicit options before work. Reject unknown symbolic names or unreadable files rather than dropping their rules.
- Load the supplied profile and apply only its sections relevant to the current role and mode. Pass the resolved profile to all nested BORK calls through scoped `instruction_paths` using [instruction routing](instruction-routing.md); worker brief fields are fixed, so do not add unsupported fields. Include applicable instructions in `context.json` and instruction dispositions in existing records.
- Standalone batch planning preserves the profile in its proposed execution commands. Wrappers may supply their own command spelling for that handoff.

## Approval and persistence

Record the resolved path (or `generic`) as `review_profile`; for a file also record SHA-256 of its exact bytes as `review_profile_sha256` in the plan or session/context. Show the path, hash, and applicable profile additions in doitall's read-only preview. Do not create durable records before its `go`.

After approval, retain an exact regular-file snapshot outside disposable worktrees, record its path as `review_profile_snapshot`, and pass that snapshot to descendants. Before initializing a batch, verify the original file still matches the approved hash. The runtime checks `review_profile` and its hash at initialization; the caller verifies and retains the matching snapshot. Standalone workflows snapshot after their own prerequisites permit run initialization; read-only ghreview and batch can retain the loaded content without creating a run. Never put private profile content in PR bodies, comments, or source commits.

On resume, use the retained snapshot and verify its recorded hash before further work. Missing or changed profile evidence blocks continuation until reconciled; a material change requires whatever renewed approval the destination specifies. Do not infer new rules from a changed installed profile. A legacy plan without a profile keeps its retained approved instructions; if they cannot be established, resolve the profile explicitly and pass the destination's approval gate before new mutations. Unknown legacy named profiles require their original provider's instructions, not an automatic generic fallback.

## Optional hooks

A supplied profile may define read-only preflight, preview additions, PR metadata conventions, selected-reviewer request/re-request behavior, follow-up tags, and a bot rehearsal checklist. Default behavior remains the destination's generic workflow. Set `bot_rehearsal` in a review worker's prompt only when the supplied profile explicitly enables it for that mode/reviewer and provides a checklist. Profile rules add constraints; they do not select a reviewer or enable skipped phases.
