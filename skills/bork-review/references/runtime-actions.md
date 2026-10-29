# Runtime Action Schemas

Load the relevant action section when using it; do not read helper implementation during ordinary runs.

## CLI Contract

Invoke `node <absolute-helper-path>` with one JSON object on stdin, preferably through a prepared input file or a structured process API. Never interpolate untrusted values into shell command text. Output is one JSON object: `ok: true, result: {...}` or `ok: false, event: blocked, error: ...` with nonzero exit. Helpers do not interpret findings, grant authorization, post messages, push, delete worktrees, or prove semantic prerequisites.

| action | Additional input fields | Result / use |
| --- | --- | --- |
| `inspect` | `repo` | Local paths, branch, HEAD/tree, status fingerprint and entries |
| `guard` | `repo`, `branch`, `head` | Reject stale branch/HEAD before acting |
| `write` | `path`, `data` | Atomic JSON publication; destination directory must exist |
| `lock` | `path`, `token`, `operation`: `acquire` or `release` | Exclusive directory lock; release requires the same token |
| `transition` | `repo`, `branch`, `head`, `session`, `run_id`, `role`, `from`, `to` | Serialized role-owned status handoff after session/Git checks |
| `wait` | `path`, `wanted` array, optional `seconds` (0..50), `allow_missing` | Terminal/desired event or `waiting`; no background process |
| `delta` | `previous`, `current` JSON file paths | `changed` entries and `removed` IDs, or `unchanged` |
| `verify-commits` | `repo`, `base`, `head`, optional `email` | Signature and author checks for only `base..head` |
| `worktree-create` | `repo`, `branch`, `path`, `base` | Create from resolved commit; Git rejects occupied branches/paths |
| `cleanup-check` | `repo`, `branch`, `head` | `preserve` with entries, or `removable_locally` |

For `transition`, session must include matching `run_id` and `worktree`. Save required records, expected new HEAD, and `.review` before publishing status. Role `owner` initializes `missing` or advances `good` to `coded`; review owns `coded`/`reviewing`, fix owns `reviewed`/`coding`. Their active phases can publish `blocked`. Owner-only abnormal recovery after stopping peers uses the shared contract rather than a normal transition. Reject tracked coordination files at initialization. The helper's short `.status.lock` is distinct from the run lock; ignore it locally too and never remove an ambiguous live lock. Helpers cannot prove workers stopped, coverage is sufficient, or publication succeeded: the lifecycle owner must establish those prerequisites.

Run `wait` in a foreground tool call with a timeout allowing its bounded wait to finish. On `waiting`, repeat it without reloading context or diagnosing the same unchanged state. `allow_missing` is only for a fixer awaiting initial standalone setup. For bot waits, refresh scoped remote snapshots every 30 seconds and compare normalized entries with `delta`; unchanged results only advance the saved quiet-period clock. Emit progress at the host's required cadence; do not rereason about unchanged bot feedback. `unchanged` never establishes bot completion or replaces required pending-check rules.

Use `cleanup-check` after removing only recorded disposable artifacts. A locally removable worktree still requires verified remote publication, stopped workers, and the skill's other cleanup conditions. Signature verification is mechanical only; record scope/Conventional Commit checks separately. Keep verified SHA lists so later phases check new commits only, unless signing trust/configuration changed.

Maintainers can run `python3 <skill>/scripts/tests/test_workflow.py` for isolated behavior checks. Python is a test-only dependency; the runtime needs Node.js 22+ and Git. The positive SSH-signature fixture additionally uses `ssh-keygen` when available. No tests access GitHub.

For explicit doitall runs, the owner resolves the required author email once from applicable user/repository commit instructions, falling back to local Git author configuration/environment (for example `git var GIT_AUTHOR_IDENT`) when no explicit email is required, records it as `commit_email`, and passes it as `email` to `verify-commits`. Do not infer Git commit email from a GitHub login or change the user's configuration. Other invocations keep the existing email default.

## Brief construction

Use `brief.json` with `schema_version: 1`, `run_id`, `mode`, `role`, `worktree`, `branch`, `head`, `base_sha`, `base_repository`, `head_repository`, `pr_url` or `issue_url`, `session_path`, `cycle`, `pass`, `context_path`, `review_path`, `previous_review_path`, `instruction_paths`, and `validation_path`. Goodcode worker briefs carry the selected `execution_driver` and `cli_profile`, also recorded in their owner session. Doitall briefs additionally carry the batch `execution_driver`, `master_agent_id` when native, `cli_profile` and `master_pane` for Herdr or tmux, with the terminal driver's session identity retained in the batch records, `commit_email`, and optional `base_override`. Include `review_mode` for review/fix briefs. Fields inapplicable to a role may be null. All file paths are absolute. Owner supplies known values; never ask the worker to infer them. At handoff the publisher updates its role-owned record; owner creates the next brief from those records rather than rediscovering facts. A missing field is filled once by its owner, with source evidence recorded. The first worker may gather missing product context for the owner, then save it for reuse.

Invoke `brief` with `session`, destination `path`, and `data` containing the current role/phase fields. It copies only the documented brief fields, rejects changes to saved target identity, and requires resolved HEAD/base/branch/repositories. `baseline_path` and `worker_session_id` are optional additions. Supply fresh cycle/pass/head and current record paths from verified records, never stale session defaults. New run IDs and worktree paths require a new session, not an overlay.

## Append-only bookkeeping

`record` takes `path`, stable attempt `id`, and object `data`. It adds the outcome under a lock, returns `unchanged` for an identical retry, and rejects overwriting an earlier outcome. Use separate IDs for intent and verified result, including run/cycle/SHA/thread or bot identity. Remote reconciliation is still required after uncertain replies, requests or pushes. This action does not send messages or verify semantic claims.

## Review reuse

`reuse-review` takes `repo`, `previous` baseline file, and `current` identity/context file. See [reuse](reuse.md) for fields and acceptance. It returns `reuse_candidate`, `delta_candidate`, or `full_review` plus a reason and evidence path. A candidate never marks a review clean.

## Snapshot collection

`snapshot` accepts `spec` (absolute source-spec JSON path), new `path` for the snapshot, optional `previous` complete snapshot, and optional `seconds` (1..40, default 20). It invokes `gh api --paginate --slurp`, preserving full raw pages in `<path>.raw.json` and a complete normalized map at `path`. Failed/partial fetches never replace prior evidence. It returns only `event`, `changed_ids`, `removed_ids`, count, hash and path. Read changed entries by ID from disk. Do not cat entire snapshots or logs by default.

Source specs are fixed per collection and contain:

- `host`, `repository` (`owner/repo`), `endpoint`, `items_path` (JSON key array), and optional `id_path` (default `["id"]`). Identity, body, author, timestamps, resolution and SHA/status fields must be retained in the query where relevant.
- REST: repository-relative endpoint such as `repos/OWNER/REPO/issues/123/comments?per_page=100`. Only GET is used; `items_path: []` handles top-level arrays. For a single PR object use `single: true`, `single_id: "pr"`.
- GraphQL: `endpoint: "graphql"`, explicit read-only `query` with `$owner` and `$name` bound to the recorded repository, and optional scalar `variables` (for example integer `number`). For pagination declare `$endCursor: String`, use `after: $endCursor`, and select `pageInfo { hasNextPage endCursor }`. `connection_path` locates this one connection; `items_path` locates its `nodes`. Do not include multiple independently paginated connections in a query. Nested truncated connections are rejected: collect their contents separately. Every selected connection must include pageInfo; the helper cannot detect intentionally omitted pagination metadata.

Example REST spec:

```json
{"host":"github.com","repository":"OWNER/REPO","endpoint":"repos/OWNER/REPO/issues/123/comments?per_page=100","items_path":[],"id_path":["id"]}
```

Example thread query fields: `data.repository.pullRequest.reviewThreads` is `connection_path`; append `nodes` for `items_path`. Each thread needs its stable ID/resolution plus separately complete comments and provenance. API query selection is the owner's responsibility; a valid helper result cannot prove omitted product context is irrelevant. Maps are key-normalized; positional lists and API update markers are preserved. Fetch timestamps remain outside the evidence hash. Avoid volatile counters in polling queries when they are irrelevant to the fixed scope, but never drop required state or bodies to save tokens.

## Automation polling (owners only)

Use `automation-poll` with `scope`, `state`, and an existing snapshot `directory`. It fetches every configured source within a 45-second total budget, atomically retains the complete poll, and returns compact changes. One owner writes a given state. Call it every 30 seconds with bounded foreground waits and progress at the host cadence. On `changed`, inspect only changed entries plus referenced scope, then call `automation-assess`. On unchanged polls, the helper reuses the assessment and advances its quiet clock without model reinterpretation. A fetch/access failure is a blocker, never quiet evidence.

A scope is immutable JSON:

```json
{"mode":"follow_up","head":"FULL_SHA","sources":{"pr":"/abs/pr-spec.json","checks":"/abs/checks-spec.json","reviews":"/abs/reviews-spec.json"},"signals":{"required-ci":{"kind":"check"},"qualified-bot":{"kind":"review"}}}
```

`signals` lists every expected required check and qualifying bot, even when absent from current API output. Use `review` only for a bot with an explicit completion signal; use `quiet_review` only after establishing no such signal exists. With no bots the helper still requires two minutes of quiet after terminal checks. Sources must freshly expose PR head/draft state, scoped check/rerun statuses, and relevant review/comment bodies. Keep required-check discovery and bot qualification in the owner, and save evidence supporting each scope entry. Source specs themselves are immutable for the scope; changing them requires a reconciled new scope.

Promotion uses `mode: "promotion"`, exactly one `review` signal for the verified selected reviewer, integer UTC `promotion_time`, and unique `event_id`. Preserve both across resumes. A historical completed draft review is ineligible. The owner must establish correlation to this ready event or an already active review of the promoted SHA before attaching `event_id` to the signal.

`automation-assess` takes the same `scope` and `state`, plus `assessment` pointing to JSON containing:

- The last poll's `evidence_hash`, actual refreshed `head`, boolean `draft`, and `activity_hash` computed only from normalized in-scope evidence. Unrelated optional bot activity must not reset quiet time.
- `signals`, keyed exactly like the scope. An absent signal remains pending. Each present signal has `head`, `status` (`missing`, `pending`, `terminal`, `blocked`), evidence paths/URLs, boolean `started`, and optional `failed`. Promotion signals also have the correlated `event_id` and evidenced integer UTC `started_at` for started/completed work. Missing, future, or post-deadline first starts block; an evidenced already active review may predate promotion.
- An explicit review signal needs `completed_review: true` to become terminal. A completed review requesting changes is completed feedback, not infrastructure failure. Review failure/cancellation without a result is `blocked`. Required failed checks are terminal with `failed: true`; the next reviewer must evaluate them.

Only assess complete, fresh snapshots. The helper rejects mismatched hashes, SHA mismatches and assessments more than 60 seconds after their poll. It requires all expected signals, explicit review completions and quiet periods where applicable; it never treats silence as bot completion. `skipped_draft` follows goodcode's draft rules; in doitall's ready gate it blocks the ready-workflow requirement. `complete` carries failed-check IDs as review feedback. No-start after ten minutes blocks promotion; known started pending work has no runtime timeout. Retain the saved state/evidence in the run records. The helper performs no requests, replies, pushes, promotions or source fixes.

Maintainers also run `python3 <skill>/scripts/tests/test_evidence.py` for offline paginated API, evidence-reuse and automation-gate fixtures. No live GitHub requests are made.
