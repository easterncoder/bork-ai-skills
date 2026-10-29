# Shared Review and Fix Contract

Read once per worker session and reuse across resumed cycles. This contract defines role ownership, atomic handoffs and durable evidence.

## Role Loading and Ownership

Read [portable runtime](portable-runtime.md) once. Only lifecycle owners read [owner lifecycle](owner-lifecycle.md); only reviewers read [review context](review-context.md). Load the [action schemas](runtime-actions.md) for the helper actions you need, not as mandatory startup context.

Goodcode owns orchestrated initialization, cycle boundaries and cleanup. Standalone review owns them; standalone fix waits for initialization. Standalone workers discover `active.json` under the absolute `git rev-parse --path-format=absolute --git-path bork-review-loop` directory; only standalone review initializes it. `.status` and `.review` live at the repository root. One worker per role; only fix edits/commits source. Workers consume the supplied absolute run directory and brief, verify identity, and never overwrite active runs or remove coordination files in orchestrated mode. Keep records outside disposable worktrees and out of commits. On `good`, each worker saves its cycle-specific completion acknowledgment and ends its turn/process. The owner verifies both acknowledgments and stopped workers before continuing. Standalone review waits for the fix acknowledgment before cleanup, unless explicitly review-only.

## Atomic Handoffs

`.status` contains exactly one of `coded`, `reviewing`, `reviewed`, `coding`, `good`, or `blocked`.

| Owner | Transition | Required before publishing |
| --- | --- | --- |
| Lifecycle owner | New cycle to `coded` | Session, cycle, and starting HEAD recorded |
| Review | `coded` to `reviewing` | Expected run, branch, and HEAD verified |
| Review | `reviewing` to `reviewed` | Review record and actionable `.review` saved |
| Fix | `reviewed` to `coding` | Review run, cycle, pass, branch, and HEAD verified |
| Fix | `coding` to `coded` | Signed commit verified and fix record saved |
| Review | `reviewing` to `good` | Clean review and dispositions saved |
| Current phase owner | Active phase to `blocked` | Operational blocker record saved |

- Phase ownership includes receipt validation: review owns `coded` and `reviewing`; fix owns `reviewed` and `coding`. The receiving worker may publish `blocked` for an invalid handoff before claiming its active phase.
- Enforce one worker per role. Only the current phase owner publishes its transition. A waiting worker that detects a problem records it and notifies the owner instead of racing the active worker to change status. The lifecycle owner may publish `blocked` after stopping both workers.
- Publish files using a unique temporary file in the destination directory, close it, then atomically rename it over the destination. Publish records first, `.review` second where applicable, and `.status` last. Atomic rename prevents partial reads; ownership prevents competing writers.
- Before every handoff, recheck expected status, run, branch, and HEAD. The only permitted HEAD movement within a cycle is the fixer's recorded commit. Unexpected changes are blockers. Never consume stale findings or reset over them.
- Use the runtime `wait` helper in the worker's active turn; it polls at ten-second intervals and returns within 50 seconds. Repeat without timing out while the peer progresses. Never leave a background poll and end the turn. `good` and `blocked` are terminal for workers, except standalone owner cleanup. Report invalid state rather than waiting on it.
- If a worker exits without its completion acknowledgment and status is not `blocked`, resume the same worker with the current run and pass. Do not take over its role or blindly replay a commit. After interruption, reconcile HEAD, records, and completed mutations before resuming; block if ambiguous.

## Retained Review and Fix Records

Use one numbered pass directory per review. Write structured JSON records and retain every prior pass. Review owns `review.json`, fix owns `fix.json`, and the orchestrator owns follow-up records. Retain previous versions when correcting a record.

- Every record includes run ID, cycle, pass, branch, PR URL, relevant full HEAD/base SHAs, and timestamp. Record the resolved PR base commit as well as its name.
- `review.json` contains blocking findings and a disposition for every external finding evaluated, including ones needing no change. Each finding has a stable run-wide ID, severity if blocking, file/line, impact, concrete fix, original author, source comment/review URL, thread ID/URL if available, and reasoning. Use null provenance for agent-originated findings. Never invent an author or thread. Retain IDs for repeated findings.
- Dispositions are `blocking`, `no_change_needed`, `verified_fixed`, or `pending`. Include reasons and evidence. Re-review earlier fixes before marking them `verified_fixed`; a fixer's claim alone is insufficient. Record validation and limitations even in clean passes. Required unresolved findings prevent a clean result.
- `.review` is the current actionable Markdown handoff. Include run ID, cycle, pass, branch, reviewed HEAD, base SHA, and absolute `review.json` path, followed by blocking findings and IDs. Save the durable record before replacing `.review` with a clean summary.
- `fix.json` maps addressed finding IDs to full commit SHAs, changed files, validation commands/results, and limitations. Include pre-fix and post-fix HEADs. Keep unaddressed findings explicit.
- Operational blocker records include phase, reason, evidence, current HEAD, affected finding IDs if any, and required recovery action. Missing access, unavailable base/context, signing failures, unsafe worktree state, and stale coordination are operational blockers, not code findings.
- Follow-up records map finding IDs to source thread, reviewer disposition, pushed fix SHA, reply ID/URL, resolution result, and bot qualification/request/completion evidence. Preserve earlier outcomes so retries and later cycles avoid duplicate posts.

