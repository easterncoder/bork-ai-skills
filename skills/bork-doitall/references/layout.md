# Shared visible layout

The logical tree is coordinator on the left across the full height, then one horizontal band per concurrency slot. Each band contains its master on the left and its reviewer above its fixer on the right. Concurrency remains 1 by default and at most 3. The coordinator uses about 22% of the available width; workers divide the remainder. The planner requires at least 35 columns and 6 rows per worker, including room for separators.

## Implementation and acceptance status

This is a partial implementation. Do not describe Screen or Herdr App visual acceptance as complete.

| Driver | Implemented behavior | Validation / remaining acceptance |
| --- | --- | --- |
| tmux | Shared planner, actual geometry preflight, nested detached splits in the coordinator's existing window, stable claims, launcher integration, owned-leaf cleanup | Isolated real tmux tests cover concurrency 1/2/3, focus, unrelated panes, launch, slot turnover and resize refusal. Real provider prompt/restart/crash behavior remains untested. |
| Herdr TUI | Documented pane-layout geometry, ratio/no-focus nested splits in the existing tab, stable claims and runner submission after foreground-shell verification | A response-fixture test checks snapshot identity, explicit split target, returned ID and no-focus/ratio arguments. Live TUI layout, split rounding, prompt handling, turnover, resize and cleanup remain untested. |
| hc without visual host | Existing terminal lifecycle remains available; explicit headless preflight | Visual layout is absent by design. No app launch or driver switch. |
| hc with Herdr App | Read-only capability adapter and explicit refusal before visual mutation | BLOCKED: installed App `commands`, `ls`, `status` and generated `herdr.d.ts` expose no complete pane-geometry snapshot or background split control. Core terminal rows/columns do not prove placement. |
| GNU Screen | Read-only installed-version capability adapter and explicit refusal for layout launches | BLOCKED: Screen 4.09.01 remote queries do not expose complete attached-display region identity, sizes, focus and window assignments. Its manual explicitly says `layout dump` omits sizes and assignments. |

For unsupported visual capability, surface the precise blocker. Do not silently create separate sessions, change topology, upgrade a multiplexer, invent an API, or claim a capability rejection is successful layout support. Legacy launch inputs remain compatible so an approved active run can finish under its recorded contract. These compatibility paths are not the new layout implementation.

## Helper interface

Use `php <skill>/scripts/layout.php <action> <absolute-input.json>`. All mutations use a journal lock and atomic JSON replacement. Keep the journal outside disposable worktrees. The helper never authorizes a launch or proves a provider result.

- `plan`: `concurrency` plus `area: {x,y,width,height}`. Read-only logical definition, rectangles and ordered splits.
- `preflight`: `driver`, verified `coordinator` pane, `concurrency`, and `context`. tmux context is exactly one of `socket_path` or fixture-only `socket`. Herdr uses the already verified inherited session. hc without `visual_host` returns explicit headless support; hc with a visual host inspects App capability. Screen returns its concrete visual blocker.
- `create`: same input plus unique `record`, `run_id` and existing absolute `cwd`. Recheck capabilities and live geometry after approval. Precreate ordinary shell panes as placeholders (tmux uses `/bin/sh` with no startup profile). No agents are started to fill empty slots. The original coordinator subtree is the only split target; surrounding user panes remain outside it.
- `inspect`: `record`. Read live identity, geometry and pending intent alongside the saved journal. An incomplete or uncertain operation blocks automatic retry. Reconcile its before-snapshot, returned IDs, actual topology and ownership manually; do not create a duplicate tree or erase the pending operation to make progress.
- `claim`: `record`, `role` (`master`, `review`, `fix`), integer `slot`, `target_id`, unique `task_id`. Verify focus, resource ownership, surrounding panes and actual rectangles. Claim exactly once before submission. A failed or uncertain submission keeps the claim; inspect the original job/result/occupant before any replacement.
- `release`: `record`, `placement` such as `review:1`, matching `task_id`, regular durable terminal `result_path`, and `results_verified`, `worker_stopped`, `descendants_stopped` all true. The owner establishes these facts through the existing lifecycle contract before calling. Keep the placement as a placeholder for the next cycle or target; retain task history. Do not kill or close the role pane during ordinary per-target cleanup.
- `cleanup`: `record`, `results_verified` and `descendants_stopped` true, with every claimed role already released. Close only journaled idle owned leaves in reverse creation order, preserving coordinator and surrounding resources. Verify the coordinator's original rectangle is restored. A pending close or changed ownership requires reconciliation, not a blind retry.

After resize, inspect the original tree. Geometry drift pauses new claims rather than silently rebuilding or selecting another topology. Finish accepted workers safely and reconcile whether the same tree can be restored; otherwise block with required geometry. Never kill active workers to fit a screen.

## Launch integration

For tmux batches, pass `layout_record`, `slot`, `task_id`, `target_id` with the normal immutable job/launch fields to `tmux.php launch`. Supply the exact same socket selector as the journal. It claims and respawns the returned role pane in the existing window. `session_name` remains accepted for compatibility but does not create a new session in layout mode. Keep the returned pane ID for process/result verification; do not use session-wide kill commands.

For Herdr TUI batches, use `php scripts/herdr.php launch <launch.json>` with `layout_record`, `slot`, `task_id`, `target_id`, `role`, `job`, `cwd`, and explicit destination `shell`. It claims the role pane and submits the shared runner only after confirming its foreground shell. Result acceptance, native descendants, interruptions and prompts still follow the Herdr contract. Release the role after its stopped-process evidence is accepted.

A coordinator creates the tree once after `go`; its masters and goodcode children receive the same journal plus their stable integer slot. The coordinator owns final tree cleanup after every target master and descendant has stopped. Goodcode owns role claims/releases and never removes the tree. Target turnover reuses the same concurrency slot. Standalone goodcode and previously approved batches without a journal keep their existing launch contract.

## Evidence

Installed manuals are the authority. Herdr TUI's `pane layout` response schema includes rectangles and focus, and `pane split --help` includes explicit target, ratio and `--no-focus`. The adapter requests the retained child's ratio and verifies returned geometry; that ratio interpretation and split rounding remain unverified against a live TUI. Tmux `list-commands` documents detached `split-window`, pane identity and lifecycle commands. GNU Screen's local `screen(1)` documents `at <tty>%`, nested `split`, `focus`, `resize`, `layout save` and its limited `-Q` command set. These Screen mutation primitives alone cannot establish a complete safe region snapshot. App geometry inferred from a screenshot or hc terminal size is insufficient to prove tree ownership and placement.

Run `PYTHONDONTWRITEBYTECODE=1 python3 skills/bork-doitall/scripts/tests/test_layout.py`. Tests use harmless PHP jobs and a private tmux socket; they never run an AI CLI, contact GitHub or control the user's core/app.
