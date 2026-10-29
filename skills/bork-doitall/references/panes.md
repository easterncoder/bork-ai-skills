# Agent Execution

## CLI Profile

Resolve the invoking host's native delegation capabilities and, for fallback only, its installed terminal CLI from verified host identity and local help. Select one driver for the entire batch before the plan preview and persist it as `execution_driver` in `plan.json`.

Prefer `native` when the host can run coordinator → master → goodcode → review/fix, with three delegation levels and at least `1 + 4 * max_concurrency` simultaneous agent slots in the same session. Prify substitutes for goodcode and its children, so this is the peak. Launch one native master per target from a compact brief. Keep the coordinator in the invoking session and use native agent IDs and results for monitoring. No tmux process, session, pane or terminal CLI is required for this driver.

If native capacity or depth is insufficient, select `tmux` only if the same host has a usable terminal CLI, tmux, two delegation levels and four simultaneous slots within each master CLI session. Launch one tmux master session per target; its prify/goodcode and goodcode's review/fix remain native subagents. If neither driver is available, report the capability blocker. Do not switch drivers during a batch, silently change the approved concurrency, switch hosts or use Fable as fallback.

Goodcode selects worker models and reasoning effort under its own [effort tiers](../../bork-goodcode/references/effort-tiers.md) policy. Master and prify use the host's configured defaults. Do not forward credentials or permission-bypass flags. Use normal local authentication and permissions. A pending approval still occupies the target slot.

Use role briefs instead of personas: the coordinator owns batch scope, scheduling and final status; each master owns one target's phase gates and promotion; prify creates the draft PR; goodcode owns review cycles and fixes; review reports findings; fix changes code for blocking findings. Give each agent only its target identifiers, authority, required skill and durable record paths. Escalate decisions outside that role to its parent agent.

For native mode, spawn masters through the host's documented agent mechanism. For tmux fallback, build and record the CLI argument array once from local help. Each master brief explicitly loads the absolute `SKILL.md`, target brief, role and result path. Do not rely on slash-command discovery across hosts. All native subagents receive compact task briefs and paths to durable records, not the full batch transcript. Use a fresh or minimal context when the host supports it. Reuse verified role-bound subagent sessions across cycles when supported by [worker session reuse](../../bork-review/references/reuse.md); otherwise start fresh from compact records. Reconcile an interrupted run before resuming or replacing an agent. Never replay uncertain mutations.

Inspect the agent tree through the host's agent interface. Codex CLI exposes `/agent`; Claude Code exposes its agent panel. In native mode the coordinator's agent tree contains every target master. In tmux fallback, attach to a master's session to inspect that master's tree. The exact controls depend on the installed host.

## Scheduler and Fallback Launcher

Before each launch, apply [extra instruction routing](instruction-routing.md) and include the target's instruction paths in its brief. The master forwards role-specific paths to each subagent and verifies coverage. Record intent and a unique result path before spawning a native master; save its returned agent ID immediately. The master does the same for each prify and goodcode child, using a distinct path for draft and ready goodcode. Reconcile each uncertain spawn and result before trying again; a vanished agent or lost final message never justifies a duplicate child.

`php <skill>/scripts/tmux.php schedule <absolute-input-json>` requires PHP CLI 8+ but does not invoke tmux; use it for read-only previews with either driver. During execution, call [batch runtime](batch-runtime.md) `reserve` for atomic scheduling and blocker persistence. The `launch` and internal `run` actions are only for tmux fallback and require POSIX tmux and the selected executable. The helpers return compact JSON and a nonzero exit on failure. They never call GitHub, delegate work, merge PRs, delete worktrees, or infer phase success.

`schedule` accepts `{"max_concurrency":1,"targets":{"id":{"status":"queued","depends_on":[]}}}`. The normalized target map may contain any number of supplied roots and verified sub-issues. `max_concurrency` defaults to `1` and accepts integers from `1` to `3`; values above `1` require an explicit user request. It returns active count, launch IDs up to remaining slots, waiting IDs, and a `blocked` map. Each blocked entry names either `dependency_blocked` with the immediate prerequisite or `dependency_cycle` with cycle IDs. The batch runtime applies this same scheduler when reserving. Re-run `reserve` after terminal state changes; a graph with no launch or active nodes must have every queued target classified as waiting on an active prerequisite or blocked.

For tmux fallback, `launch` accepts `role: master`, an existing absolute `cwd`, an absolute immutable `job` JSON path, and a unique `session_name`. The job contains `argv` (absolute executable followed by individual arguments) and a unique `exit_record` path. An exit record is process evidence only, never a skill result. Optional `socket` selects a named tmux server and must stay consistent for the batch. Worker roles are rejected by the helper.

For fallback, use `do-<repo>-<kind><number>` for session names, for example `do-wlm-i123` or `do-wlm-p456`. Choose a lowercase repository abbreviation of 2 to 8 letters or digits and reuse it throughout the batch. `i` identifies a canonical issue target; `p` identifies a canonical PR target. Omit batch IDs, timestamps, titles and agent names. If the name belongs to another run, append the smallest available suffix starting with `-2`. Persist the name and keep it through all phases. On resume, reuse the recorded session after reconciling a partial launch.

For fallback, prepare separate immutable job and launch files per attempt. Save launch intent before invoking the helper and returned session/pane IDs immediately afterward. If launch fails midway, inspect the named session before retrying. Never reuse an exit-record path.

## Lifecycle and Recovery

Each active target has one master agent. The master delegates prify if needed, then draft goodcode if the PR is draft, and ready goodcode unless approved `NOREVIEWER` skips it. Goodcode owns its worktree and review/fix subagents. The master owns phase transitions and promotion; the batch coordinator owns queue state. Do not launch a second master for the same target while the first remains active.

Record native agent IDs, role/model bindings, run directories, phase intent, acknowledgment and final results in durable records. A child agent's final message or disappearance is insufficient without its required durable result. On a blocker, safely stop and reconcile active descendants before ending the master or releasing the slot. Keep a master available when it awaits user input.

In native mode, use the master's agent ID and host status/result mechanisms for bounded waits and resume. Reconcile its durable target result and possible mutations before marking it terminal. A final message or vanished agent alone never proves target success.

In tmux fallback, use the returned master pane ID for inspection and cleanup. Poll `#{pane_dead}` and role records with bounded waits. For an owned dead master pane, capture scrollback, `#{pane_dead_status}`, its unique exit record and job identity; reconcile its durable target result and possible mutations; then close the pane even for blocked or failed outcomes. A dead or vanished pane or successful CLI exit alone never proves target success. Never close an unrelated tmux pane/session.

For fallback, save a `tmux attach-session -t <session>` command, with the selected socket when applicable, while the session exists. After any master exits, retain diagnostics in durable records.

## Surfacing Interactive Attention

An interactive blocker is a question, confirmation or permission prompt addressed to the operator in a master or descendant's status, or a live agent that has produced no progress beyond its expected step. Documented automatic waits, such as the selected reviewer gate, are excluded.

At the first detection, the master reports a child blocker to the coordinator with the target, role, agent ID and exact prompt. The coordinator immediately messages the user with that prompt and the host's agent navigation path; for tmux fallback, include the master attach command and pane ID. It also inspects master status for direct prompts. Continue independent targets and avoid repeated notifications for the same unanswered prompt. Do not treat a child waiting for approval as ordinary silent progress.

Maintainers: run `python3 <skill>/scripts/tests/test_batch.py` for offline transition and interruption tests, and `python3 <skill>/scripts/tests/test_tmux.py` for isolated queue and real-tmux smoke tests. They launch harmless local fixtures, never an AI or GitHub action. Python is only a test dependency.
