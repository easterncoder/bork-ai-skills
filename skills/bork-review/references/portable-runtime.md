# Portable Runtime and Context Reuse

Read once per agent session. PHP CLI 8.0+, Git and the verified GitHub CLI supply portable mechanics through `bork-review/scripts/workflow.php`. Resolve sibling paths from the installed skill. Helpers never grant authorization or evaluate source correctness. Missing dependencies are blockers; do not silently install substitutes.

## Context and Invalidation

The lifecycle owner discovers repository/PR/issue identity, paths, selected base, remote destinations, instructions, and model capabilities once. Save these in the session and pass them to workers. Consumers verify identity with `guard`; they do not repeat remote/repository discovery merely because their role changed.

Use the owner's `brief.json`; see the `brief` action in [runtime actions](runtime-actions.md) when constructing one. Workers must not rediscover fields already supplied. Missing facts are filled once by their owner with source evidence.

| Evidence | Reuse while | Refresh trigger |
| --- | --- | --- |
| Identity, paths, destinations | Same recorded run | Resume identity mismatch or explicit target change |
| Local instructions | Same files/content | Relevant instruction files change or scope enters another directory |
| Product context | Source IDs and content/update markers match | Changed body/comment/requirement, new finding, incomplete fetch |
| Prior review | Baseline SHA is ancestor; base and intent still match | Relevant code changes, new evidence, changed base, missing baseline |
| Test results | Tested content, command, configuration and environment match | Any relevant input changes; unproven coverage requires validation |
| Model/delegation choice | Capability remains available | Host/model becomes unavailable |

Never use `status_hash` as proof that dirty content, ignored dependencies, or test inputs are unchanged. It detects status entries only. Cache tests against committed content and relevant configuration/environment evidence; for dirty trees save actual relevant content hashes or rerun the narrow checks. Resume always rechecks local/remote identity and unfinished mutations. Push, reply, PR creation and deletion require fresh state checks even when context is cached.

The context owner fetches complete paginated PR/issue/check/thread snapshots at review boundaries and saves normalized JSON maps keyed by stable source IDs. Include body hashes/update markers, author, thread resolution, run SHA and conclusion as applicable. Exclude volatile retrieval timestamps and normalize ordering inside entries. Store fetch timestamps/completeness separately. Compare with `delta`: only changed/new/removed entries need AI interpretation. A partial/error response never replaces a complete snapshot or means there are no changes. Fetch full content only for changed sources when reliable change markers exist; otherwise compare freshly fetched complete bodies. Workers read relevant changed entries and referenced prior findings, not the entire history each pass.


## Compact Evidence and Reports

Keep full snapshots, logs, findings and validation in durable files. Helper output defaults to events, IDs, counts and paths. Read only changed evidence and the complete code paths needed to judge it; never truncate required findings. Successful validation returns a short result plus its log path; failures expose relevant diagnostics, with complete logs retained. Use [reporting](reporting.md) for all five skills.

Use [reuse and validation](reuse.md) when importing evidence between phases. Use [runtime actions](runtime-actions.md) for `snapshot`, `brief`, `record`, `reuse-review`, `automation-poll` and `automation-assess`. Only owners load polling schemas. Save per-phase usage reported by the host (input/output/cached/reasoning tokens when exposed); unknown usage is null, never an estimate. This supports before/after comparisons without extra model calls.
