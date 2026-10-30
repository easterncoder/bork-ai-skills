# Shared visible layout

New visual batches use version 2 demand journals. `concurrency` is a ceiling of 1 to 3 targets, not a request for panes. Creation records the coordinator's existing rectangle without opening workers. A claim immediately before a real launch creates exactly that role. Released roles disappear after durable result acceptance and verified worker/descendant shutdown. Surviving pane IDs and processes remain unchanged.

The coordinator stays on the left across the owned height. Active groups appear in stable integer slot order down the right. A master fills its group until review or fix exists, then occupies its left half. One tandem role fills the right half; when both exist, review is above fix regardless of creation order. Removing a role expands its survivor; removing a master collapses the empty group. Never close a master before its tandem children.

Version 1 journals retain the fixed placeholder lifecycle for their entire run. Do not convert a running journal, reinterpret its placements or create a second layout. Explicit `lifecycle: "fixed"` remains available for compatibility fixtures. Unknown versions refuse mutation. Previously approved runs and launches without a journal retain their recorded contract.

## Ownership and capacity

Keep the journal outside disposable worktrees. Every mutation takes its journal lock and writes atomic intent before changing the host. Claims require a unique task identity, target identity, role and stable integer slot. A failed submission retains its claim; inspect the original worker before retrying. A user moving focus does not invalidate placement. A foreign pane appearing, changed ownership, missing pane, geometry drift or uncertain mutation stops new launches without killing workers.

Set the batch plan's `layout_record` before reservation. `batch.js reserve` owns target queue transitions and calls serialized layout admission before marking a target starting. The returned slot is written to the target and forwarded in its brief. Admission reserves logical headroom for both review and fix in every admitted group, including reserved masters not yet launched. Headroom opens no physical panes. This prevents full master occupancy from starving their tandem children.

Insufficient aggregate capacity leaves the target queued with durable `capacity.status: "waiting_capacity"`. Release increments `capacity_generation`, marks waiter wake generations and returns waiting target IDs. The coordinator polls/reserves again on that signal. An impossible single-target review/fix pair returns `blocked` with actual and required dimensions; surface the measured scope decision. Never serialize review/fix to disguise insufficient capacity. Cancel an unlaunched admission only after the corresponding master and descendants are verified stopped. Keep stable slots until release; reuse them for later targets.

Worker minimums are 35 columns by 6 rows. Herdr has zero logical separator cells; the other hosts use one. App admission additionally budgets the measured terminal headers/padding (37 logical columns and 8 logical rows) and independently checks actual rendered cells. Creation itself does not require worst-case concurrency geometry. A narrow coordinator-only journal is valid even when later admission reports a blocker.

## Host composition

| Host | Demand operation |
| --- | --- |
| tmux | Detached split, stable pane-list permutation with detached swaps, then a checksummed measured tree replacing only the original coordinator rectangle. |
| Herdr TUI | Same-workspace temporary-tab staging and reinsertion of existing panes. If focus is owned, keep its ID as the unstaged pivot, then permute IDs using swaps with that pivot as source. No extra worker shells are created. |
| App/hc | Public `doc.get` and versioned `doc.set` CAS reparent retained pane nodes and terminal references. Preserve fresh document metadata, other tabs and foreign leaves. Verify logical rectangles separately from settled rendered cells. |
| GNU Screen | Remove/rebuild owned regions while retaining their windows and shell PIDs, bind existing windows to final regions, and restore measured sizes. Use only the verified attached display tty. |
| Headless hc | Existing terminal lifecycle; no visual tree and no implicit App launch. |

All adapters preserve unrelated panes and operation-entry focus. Herdr checks focus before each step. Screen uses guarded temporary traversal; observed navigation aborts rather than restoring stale focus. No host can atomically exclude a human navigation event between a read and a control. App splits can briefly select the new pane; restore entry focus only if the operation still owns current focus. When a focused owned role closes, select a deterministic surviving owned pane. Never raise a window or switch the user's unrelated tab/session.

## Public helper actions

Use the selected maintained Node binary: `node <skill>/scripts/layout.js <action> <absolute-input.json>`.

- `plan`: `concurrency`, `area: {x,y,width,height}`, optional active/requested `topology: {"1":["master","review"]}`, `driver` and `reserve_pair`. Returns only actual/requested placements. It opens nothing.
- `preflight`: `driver`, verified `coordinator`, `concurrency`, `context`, optional topology. Verify installed controls and actual geometry before the preview. tmux context selects exactly one socket. Herdr uses verified inherited membership and optionally its explicit recorded session. Screen records exact session, socket directory and display tty. App records the existing core/session, app home and active coordinator tab. Headless hc returns explicit nonvisual support.
- `create`: same input plus unique `record`, `run_id` and existing absolute `cwd`. Recheck after approval. Create only the empty demand journal.
- `admit`: `record`, `target_id`, optional stable `slot`. Durably reserve pair headroom, or return `waiting_capacity`/`blocked`. It is idempotent for the same target. It does not launch or create panes.
- `cancel-admission`: `record`, `target_id`, `master_stopped` and `descendants_stopped` true. Only for an admission whose master has no live resource.
- `claim`: `record`, role, integer slot, target ID, unique task ID and hc child `run_id`. Create the imminent role and verify the complete arrangement before submission. A capacity result without a pane ID must never be submitted to a launcher.
- `verify`: `record`. Verify ownership, actual geometry and identities without mutation.
- `inspect`: `record`. Return saved journal and live snapshot without changing focus or replaying mutations.
- `reconcile`: `record`. Resume a pending known-ID reflow in a fresh helper. Never split another worker or resubmit its task. A lost split response without a durably returned ID requires explicit host/ownership inspection; the helper refuses to guess. Keep all pending evidence. For changed user geometry or ambiguous identities, stop and reconcile rather than erase intent.
- `release`: `record`, placement such as `review:1`, matching task ID, regular durable terminal `result_path`, and `results_verified`, `worker_stopped`, `descendants_stopped` true. The caller establishes those facts. Verify the role's original idle shell or dead process before closure. Retain resource/result history. Repeated acceptance is idempotent only for the same removed task and result path.
- `cleanup`: `record`, accepted results and stopped descendants, with every role and admission released. Verify the original coordinator and foreign rectangles, then mark the empty journal cleaned. Keep the coordinator alive.

A pending journal blocks ordinary claim/release. Each host step retains its name, completed steps, before snapshot, desired plan, task identities and returned IDs. Reconcile known leaves from actual host state; never blindly replay a split or assume an interrupted close failed. A host server dying does not prove any worker result. App restart may lose transient hc view bindings; reapply saved owned bindings with `hc.js reconcile` before accepting rendered geometry.

## Consumers and phase ownership

Pass the same `layout_record`, stable `slot`, `target_id` and unique `task_id` through every master and goodcode handoff. tmux launch claims then respawns only the returned pane. Herdr launch creates/claims then verifies the foreground shell before submitting the shared runner. Screen launch claims one same-session window; per-role close never quits the shared session. Accept results, stop workers and native descendants, then release the physical role.

For App/hc, launch and bind the owned hc terminal in the claimed pane. On v2 `hc.js cleanup`, also supply the durable `result_path`: after capturing output and verifying the terminal stopped, cleanup releases its visible role and only then removes the owned hc terminal. A subsequent exact matching layout release is idempotent. V1 cleanup still restores its retained placeholder. Never remove a terminal while its live view is still referenced or leave a new idle view for a future role.

Goodcode owns review/fix claims and releases after each accepted, stopped pass. Later passes recreate those roles using new task identities. Keep the master and coordinator alive. The coordinator releases a target's master only after adopting its terminal result and verifying all descendants stopped, then reevaluates capacity. It owns final empty-journal cleanup. Do not retain future-role panes to represent provider sessions; provider session IDs and evidence remain durable independently of visible pane IDs.

## Validation

`node tests/run.js test_layout_demand` exercises the production planner and private tmux lifecycle, stable IDs/PIDs, insertion/finish permutations, repeated passes, foreign focus/geometry, capacity, tiny-host blockers and helper restart. Existing `test_layout` and live fixed fixtures explicitly exercise the v1 compatibility contract. Private installed-host probes and production fixtures retain their exact versions, commands, failures, final geometry and shutdown evidence in workflow validation records. A successful probe alone is not production acceptance. Provider trust prompts, real coding agents and untested host versions are not implied by harmless shell fixtures.
