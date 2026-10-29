# Shared visible layout

The logical tree is coordinator on the left across the full height, then one horizontal band per concurrency slot. Each band contains its master on the left and its reviewer above its fixer on the right. Concurrency remains 1 by default and at most 3. The coordinator uses about 22% of the available width; workers divide the remainder. The planner requires at least 35 columns and 6 rows per worker, including room for separators.

## Driver behavior

All visual adapters implement the same role tree. Installed capabilities, exact caller membership and usable geometry must pass before creation. No adapter opens a shared app, upgrades a driver or substitutes separate sessions when a visual layout cannot fit. Ordinary shells occupy empty slots; agents start only for real tasks.

| Driver | Geometry and lifecycle | Verification |
| --- | --- | --- |
| tmux | Existing coordinator window, detached nested splits, returned pane IDs, stable role claims and owned-leaf cleanup | Private real concurrency 1/2/3, focus, unrelated panes, launcher, turnover, resize refusal and cleanup. |
| Herdr TUI | Existing tab, documented pane rectangles, explicit target/ratio/no-focus controls, zero-cell logical separators | Private real concurrency 1/2/3 and cleanup; command fixtures cover target identity. |
| hc without visual host | Existing headless terminal lifecycle | Explicit headless preflight, no app launch or implicit driver switch. |
| hc with Herdr App | Complete public `doc.get` tree, explicit pane splits and weighted sizes, live terminal cells, stable placeholders showing owned hc terminals | Private real concurrency 1/2/3, claims/releases, hc launch/display, app restart reconciliation and cleanup. |
| GNU Screen | Exact attached display tty, saved full layout, ordered region traversal, unique window PTY sizes, same-session placeholder windows | Private real concurrency 1/2/3, display discovery, focus, unrelated region, claim/release and saved-layout cleanup. |

App logical weighted rectangles prove topology separately from actual terminal cells, which include headers and padding. The journal retains the original root scale and rendered cells; resize drift pauses new claims. App 0.1.7 briefly focuses a newly split pane; a `finally` restores and checks original focus on success and error. Atomic zero-transient-focus creation is unavailable. Swapped hc terminals are view state: after App restart explicitly reconcile each owned hc launch to reapply its saved slot binding. The complete document retains placeholder identities across restart.

Screen requires unique displayed windows before interpreting PTY sizes as region sizes. Shared windows, blank regions and ambiguous display membership refuse mutation. Linux procfs discovers display ttys; other platforms need an explicitly verified display tty and a supported identity check. Automatic discovery writes a unique status-message nonce on the owning display without changing focus. Every control is confirmed without resubmission. Two owned layouts preserve the original full arrangement and focus. A preexisting saved layout differing from its live arrangement, or saved layouts with no active pointer, requires explicit reconciliation; backups remain durable rather than overwriting user layouts. Saved layout recovery survives helper restart and detach/reattach while the same Screen server exists; server death requires reconciliation.

Real provider trust prompts, provider crash recovery and every operating system/version combination remain untested. Existing prompt/result/descendant contracts remain mandatory. Private fixture success does not authorize touching unrelated live resources. Earlier reports that App and Screen lack equivalent geometry APIs are superseded by these implemented public read/control paths.

## Helper interface

Use `php <skill>/scripts/layout.php <action> <absolute-input.json>`. All mutations use a journal lock and atomic JSON replacement. Keep the journal outside disposable worktrees. The helper never authorizes a launch or proves a provider result.

- `plan`: `concurrency` plus `area: {x,y,width,height}`. Read-only logical definition, rectangles and ordered splits.
- `preflight`: `driver`, verified `coordinator` pane, `concurrency`, and `context`. tmux context is exactly one of `socket_path` or fixture-only `socket`. Herdr uses the already verified inherited session. hc without `visual_host` returns explicit headless support; hc with a visual host inspects App capability. Screen context records exact `session` (`PID.name`), optional `socket_dir`, and verified `display_tty` or origin `window_tty` for nonce discovery. App context records its explicit hc `session` and optional `app_home`, with an existing active coordinator pane.
- `create`: same input plus unique `record`, `run_id` and existing absolute `cwd`. Recheck capabilities and live geometry after approval. Precreate ordinary shell panes as placeholders (tmux uses `/bin/sh` with no startup profile). No agents are started to fill empty slots. The original coordinator subtree is the only split target; surrounding user panes remain outside it.
- `inspect`: `record`. Read live identity, geometry and pending intent alongside the saved journal. An incomplete or uncertain operation blocks automatic retry. Reconcile its before-snapshot, returned IDs, actual topology and ownership manually; do not create a duplicate tree or erase the pending operation to make progress.
- `claim`: `record`, `role` (`master`, `review`, `fix`), integer `slot`, `target_id`, unique `task_id`, and for hc the child launch `run_id`. Verify focus, resource ownership, surrounding panes and logical rectangles and rendered usable cells. Claim exactly once before submission. A failed or uncertain submission keeps the claim; inspect the original job/result/occupant before any replacement.
- `release`: `record`, `placement` such as `review:1`, matching `task_id`, regular durable terminal `result_path`, and `results_verified`, `worker_stopped`, `descendants_stopped` all true. The owner establishes these facts through the existing lifecycle contract before calling. Keep the placement as a placeholder for the next cycle or target; retain task history. Do not kill or close the role pane during ordinary per-target cleanup.
- `cleanup`: `record`, `results_verified` and `descendants_stopped` true, with every claimed role already released. Close only journaled idle owned leaves in reverse creation order, preserving coordinator and surrounding resources. Verify the coordinator's original rectangle is restored. A pending close or changed ownership requires reconciliation, not a blind retry.

After resize, inspect the original tree. Geometry drift pauses new claims rather than silently rebuilding or selecting another topology. Finish accepted workers safely and reconcile whether the same tree can be restored; otherwise block with required geometry. Never kill active workers to fit a screen.

## Launch integration

For tmux batches, pass `layout_record`, `slot`, `task_id`, `target_id` with the normal immutable job/launch fields to `tmux.php launch`. Supply the exact same socket selector as the journal. It claims and respawns the returned role pane in the existing window. `session_name` remains accepted for compatibility but does not create a new session in layout mode. Keep the returned pane ID for process/result verification; do not use session-wide kill commands.

For Herdr TUI batches, use `php scripts/herdr.php launch <launch.json>` with `layout_record`, `slot`, `task_id`, `target_id`, `role`, `job`, `cwd`, and explicit destination `shell`. It claims the role pane and submits the shared runner only after confirming its foreground shell. Result acceptance, native descendants, interruptions and prompts still follow the Herdr contract. Release the role after its stopped-process evidence is accepted.

For App/hc, pass the same journal, integer slot and task/target identity to `hc.php launch`, using the identical core/session. It launches through hc, verifies terminal ownership, then shows that terminal in the claimed placeholder and restores focus. The journal records the child run identity and visible terminal; hc labels the terminal with its run and task identities. `hc.php reconcile` reapplies the binding after App restart; cleanup restores the ordinary placeholder before removing only the owned hc terminal. Release only after verified shutdown.

For Screen, `screen.php launch` with the journal claims an idle shell window and submits the shared runner there. It creates no separate session. Per-role `close` refuses to quit the shared session; accept the stopped result and release the slot. Only final layout cleanup removes owned windows and restores the saved arrangement.

A coordinator creates the tree once after `go`; its masters and goodcode children receive the same journal plus their stable integer slot. The coordinator owns final tree cleanup after every target master and descendant has stopped. Goodcode owns role claims/releases and never removes the tree. Target turnover reuses the same concurrency slot. Standalone goodcode and previously approved batches without a journal keep their existing launch contract.

## Evidence

Installed manuals and matching source establish the interfaces: Herdr TUI `pane layout`/`pane split`, hc JSON-RPC `doc.get` and `terminal.get`, App public `pane.split`/`layout.resize`/`terminal.show`, and Screen `layout save/select/dump`, `focus`, `resize`, `windows` flags and exact display tty routing. Screen dump omits sizes and assignments, so the adapter combines it with unique-window traversal and opaque saved layouts. App 0.1.7 source confirms `layout.resize` searches actual tab nodes.

Run the ordinary suite with `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s skills/bork-doitall/scripts/tests`. Run opt-in live-host fixtures with `BORK_TEST_LIVE_HOSTS=1 python3 skills/bork-doitall/scripts/tests/test_layout_hosts.py`. These fixtures use only private environments and harmless shell/PHP jobs; they never run an AI CLI or contact GitHub. Validation handoffs must separately record tested drivers, live versions, untested provider behavior and owned-fixture shutdown evidence.
