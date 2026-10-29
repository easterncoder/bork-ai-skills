# GNU Screen execution

Screen is selected after verified Herdr and tmux membership and before native execution. A partial, stale or unverifiable Screen context blocks selection even when another driver has capacity. Installation alone does not establish membership. Pass `expected_environment: "screen"` when the user reports Screen. Existing approvals retain their recorded driver; legacy selection records without Screen context treat it as inactive.

## Discovery and context

Probe the installed `screen --version`, `screen --help` and local manual. Require the documented `-S`, `-p`, `-Q` and `-X` interfaces, `number`/`windows` queries, `hardcopy -h`, `stuff`, `quit`, and `zombie` retention. Membership uses inherited `STY` (exact PID.name) and `WINDOW` (numeric window), verifies `screen -S <STY> -p <WINDOW> -Q number`, and proves the Screen server and its window child are ancestors of the caller. GNU Screen has no window PID query; the helper therefore requires local procfs to match the ancestral child's initial `STY`/`WINDOW`. Unavailable procfs or unreadable process environment blocks verification, including on other platforms. Never infer membership from `TERM` or unrelated session listings.

The existing unique same-user Codex frontend recovery also carries only `STY`, `WINDOW` and optional `SCREENDIR`, alongside the other documented terminal keys. It retains PID/start-time/cwd identity and rechecks the frontend before later commands. Run `php <skill>/scripts/environment.php screen -Q number` or `... screen -X <command> <arguments>` from the saved discovery cwd. The wrapper binds the exact caller session/window and inherits the recovered socket directory. It grants no new mutation permission.

A custom `SCREENDIR` is recorded as `socket_dir`; preserve it in every launcher and lifecycle input so a detached backend cannot address another socket directory. Default Screen sockets remain local to the same user. Do not bridge environments or copy unrestricted environments into records.

## Launch and navigation

Use the same immutable launch/job JSON contract as tmux: `role` is `master`, `review` or `fix`, `cwd` is the isolated worktree, `job` names an immutable JSON file containing absolute CLI `argv` and unique `exit_record`, and `session_name` is unique. Set `socket_dir` when discovery recorded it. Invoke `php <skill>/scripts/screen.php launch <absolute-launch-json>`. Screen executes PHP and the shared runner directly, so this launch does not interpolate a shell command. The provider retains its exact model, effort, host and normal permissions.

The launcher checks names before creation, exclusively creates `<launch-json>.screenrc`, starts `screen -dmS` with `zombie kr`, and returns the exact `session` (PID.name), `pane` (`"0"`), `role`, config and optional socket directory. Record launch intent first and identity immediately afterward. A failure or uncertain response requires inspection of the planned name, config and job before retrying. Never duplicate a role. Retain the generated configuration as owned evidence outside disposable worktrees. Doitall session naming follows the tmux target naming convention; goodcode uses separate review and fix names.

Navigate with `screen -r <PID.name>` or `screen -x <PID.name>`; set the recorded `SCREENDIR` first when applicable. These attach controls require a real terminal. Detach with Screen's configured detach key (default Ctrl-A then D). Report the exact session/window, navigation and prompt immediately when attention is needed.

## Lifecycle and resume

Lifecycle JSON contains the recorded `session`, `pane` and optional `socket_dir`. Use `screen.php inspect` to query windows; `capture` additionally takes an absolute durable `output` path and writes `hardcopy -h`; `interrupt` sends terminal Ctrl-C via `stuff`; `close` quits only the recorded owned session. Capture creates its output asynchronously, so verify the file exists and retain its contents before closing. Do not interrupt or close an unrelated session. The shared runner survives SIGINT when PHP pcntl is available so it can publish the child's exit evidence; verify pcntl for Screen capacity. Terminal Ctrl-C follows the application's normal signal behavior and does not guarantee exit. Verify the worker and descendants stopped with process/exit evidence before closing.

A retained zombie window or exit code alone never proves phase success. Require role acknowledgments, expected HEAD/coordination state, immutable job identity and durable phase results. Poll with bounded foreground waits, preserving approval slots. On stopped success or failure, retain scrollback, exit evidence, provider IDs and diagnostics before closing the owned session. Verify the exact session is gone; preserve unexpected resources and report cleanup blockers.

Resume through recorded session/window/socket identities and reconcile possible mutations first. For another provider turn, use its documented resume controls in a fresh immutable job and unique exit record, after verifying the prior CLI and descendants stopped. Close the old owned session after retaining diagnostics, then launch a fresh session; never use Screen's zombie resurrection key to replay a job. A missing session requires reconciliation from retained records before replacement. Driver changes require the existing revised-plan approval gate.

Maintainers: `python3 -m unittest discover -s skills/bork-doitall/scripts/tests -p 'test_screen.py' -v` exercises real membership, copied context rejection, concurrent roles, collision refusal, output retention, interruption and cleanup without an AI CLI or GitHub request.
