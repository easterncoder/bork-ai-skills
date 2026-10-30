# Offline validation

Use Node.js 22 or newer from a maintained LTS line. `node --version` must report a supported version. Node 20 fails explicitly before registering tests. Tests use CommonJS and Node built-ins, with no package installation, build step, PHP or Python interpreter.

From the repository root, run every suite or one named suite:

```sh
node tests/run.js
node tests/run.js test_batch
```

From any other working directory, replace `/path/to/repository` with the checkout's absolute path. The runner and fixture imports resolve from their own files, and child Node commands use the same Node binary:

```sh
node /path/to/repository/tests/run.js
node /path/to/repository/tests/run.js test_batch
```

Each suite below accepts the same individual command, substituting its name for `test_batch`.

| Skill | Suite | Original scenarios |
| --- | --- | ---: |
| bork-doitall | test_batch | 22 |
| bork-doitall | test_environment | 14 |
| bork-doitall | test_hc | 10 |
| bork-doitall | test_layout | 11 |
| bork-doitall | test_layout_demand | 8 |
| bork-doitall | test_layout_demand_hosts | 3 |
| bork-doitall | test_layout_hosts | 2 |
| bork-doitall | test_screen | 8 |
| bork-doitall | test_terminal | 4 |
| bork-doitall | test_tmux | 14 |
| bork-review | test_evidence | 11 |
| bork-review | test_node_runtime | 8 |
| bork-review | test_workflow | 8 |

Scenario names remain the original test method names. Tests preserve isolated repositories, fake GitHub responses and fake coding executables; they never contact GitHub or start a coding agent. SSH-signature tests generate a disposable key and ignore personal Git configuration. Terminal tests create private tmux sockets, Screen directories and procfs records, then stop only their own resources.

Git and a POSIX shell are required. Linux runtime locking uses util-linux `flock`; its kernel-lock scenario explicitly skips if unavailable. Real tmux cases skip when `tmux` is unavailable. Screen cases require GNU Screen and Linux procfs. Attached Screen and detached frontend cases also require a C compiler (`cc`) and the system `forkpty`/`libutil` headers and library; the small broker provides only a private pseudo-terminal. Frontend discovery also uses `ps`. The signing success case skips if `ssh-keygen` is unavailable. Shell quoting exercises installed `sh`, PowerShell (`pwsh` or `powershell`) and `cmd.exe` variants; absent optional shells are not exercised.

Two visual host cases skip by default. Opt in only on a host with GNU Screen, Linux procfs, `cc`, `hc`, `herdr-app` and `Xvfb` installed:

```sh
BORK_TEST_LIVE_HOSTS=1 node tests/run.js test_layout_hosts
```

The visual fixtures allocate private sessions, displays and application state. They exercise concurrency 1/2/3, worker binding, restart reconciliation and cleanup with harmless Node/shell commands. Evidence paths print in their output and are intentionally retained for inspection. They do not use the user's terminal sessions. Missing optional prerequisites produce explicit skips. The ordinary run reports explicit skips for opt-in cases.

Demand lifecycle acceptance uses private tmux automatically (`test_layout_demand`). It exercises both role orders, three simultaneous groups, arbitrary turnover, repeated passes, capacity admission/wake and interrupted known-ID reflow. Run the additional installed-host production cases with:

```sh
BORK_TEST_LIVE_HOSTS=1 node tests/run.js test_layout_demand_hosts
```

These cases require the corresponding host binaries, retain private evidence, and include three-group turnover. App additionally binds an actual harmless hc worker, restarts its frontend, reconciles the binding and removes the finished view. Screen's guarded display traversal can take several minutes. Legacy fixed-layout cases remain in `test_layout_hosts`.
