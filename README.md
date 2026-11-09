# BORK: Bork of Remarkable Knowledge

A collection of skills for GitHub issue and pull request workflows, available as standalone skill folders or as a plugin.

| Skill | Purpose |
| --- | --- |
| `bork-batch` | Group related issues for execution. |
| `bork-doitall` | Coordinate the issue/PR workflow through implementation and review. |
| `bork-prify` | Implement one issue and publish a draft PR. |
| `bork-goodcode` | Coordinate review, fixes, E2E/browser testing, pushes, and ready-PR feedback. |
| `bork-review` | Review within the coordinated review/fix loop. |
| `bork-fix` | Fix and validate the loop's blocking findings. |
| `bork-test` | Run focused E2E and browser acceptance checks with retained evidence. |
| `bork-ghreview` | Perform one PR review, with confirmation before posting. |

## Install without the plugin

The plugin is optional. You can install the skill folders directly in your agent's skills directory. Keep all eight BORK folders together because the workflows call each other and use relative sibling links.

For a shared installation, authenticate GitHub access to the repository, then clone it into a permanent location and link its skills into `~/.agents/skills`:

```bash
read -r -p "GitHub repository (OWNER/REPO): " bork_repository
gh repo clone "$bork_repository" bork-ai-skills
cd bork-ai-skills
mkdir -p ~/.agents/skills
ln -s "$PWD"/skills/bork-* ~/.agents/skills/
```

These commands do not overwrite existing entries. If BORK is already installed there, reuse that installation or deliberately replace its links. Keep the clone at the same path while using these symlinks. To update the linked skills, run `git pull --ff-only` in the clone.

Codex and Grok Build discover `~/.agents/skills` directly. Other hosts can share the same files through symlinks from their own discovery directories:

| Host | Global skills directory |
| --- | --- |
| Claude Code | `~/.claude/skills/` |
| Antigravity App and standalone IDE | `~/.gemini/config/skills/` |
| Antigravity CLI | `~/.gemini/antigravity-cli/skills/` |

For example, if Claude Code does not already reach the shared skills through an existing symlink:

```bash
mkdir -p ~/.claude/skills
ln -s ~/.agents/skills/bork-* ~/.claude/skills/
```

You can also copy all eight folders instead of linking them, but copied installations require separate updates. For a project-scoped installation, Codex and Antigravity support `<project>/.agents/skills/`; Claude Code uses `<project>/.claude/skills/`.

Start a new conversation after installation. Invoke a standalone skill as `$bork-doitall 123` in Codex CLI or `/bork-doitall 123` in Claude Code. Standalone installation has the same [requirements and behavior](#requirements-and-behavior) as the plugin.

## Install with Codex

Authenticate Git access to the repository first. On Codex versions with plugin CLI support:

```bash
read -r -p "GitHub repository (OWNER/REPO): " bork_repository
codex plugin marketplace add "$bork_repository" --ref main
codex plugin add bork@bork-ai-skills
```

Start a new conversation after installation so the host discovers the packaged skills. In the desktop plugin browser, select the `bork-ai-skills` marketplace and install **BORK** if your client uses the UI install flow.

The plugin exposes its bundled skills using the host's plugin namespace. Select the skill from the skill picker; the Markdown files retain the names shown above. Installing the package makes the instructions and helpers available. It does not run an issue workflow or grant GitHub permissions.

If the same BORK skills are already installed individually, use one installation source to avoid duplicate entries. This repository does not replace or remove an existing installation automatically.

## Install with Claude Code

Git must have access to the GitHub repository. In your terminal:

```bash
read -r -p "GitHub repository (OWNER/REPO): " bork_repository
claude plugin marketplace add "$bork_repository"
claude plugin install bork@bork-ai-skills
```

Restart Claude Code after installation. Invoke a bundled skill with its plugin namespace, for example:

```text
/bork:bork-doitall 123
/bork:bork-goodcode 123
```

Claude Code also accepts `/bork-doitall 123` or `/bork-goodcode 123` when no other command uses that name. The namespaced form explicitly selects the plugin's skill.

Inside Claude Code, the equivalent install commands are `/plugin marketplace add OWNER/REPO` and `/plugin install bork@bork-ai-skills`.

## Requirements and behavior

Use a host with terminal access, Git, authenticated GitHub CLI (`gh`), Node.js 22+ from a maintained LTS line, util-linux `flock` on Linux for serialized batch/layout mutations. Signing workflows need a configured signing key and signature verification trust. Standalone goodcode also selects hc, Herdr, tmux, Screen, then native for its concurrent review/fix workers. Doitall selects the active environment: hc first, otherwise Herdr, otherwise tmux, otherwise Screen, otherwise native. It verifies live membership separately from capacity and blocks invalid explicit context or an incapable selected driver without falling back. Herdr requires an inherited Herdr TUI context and a reachable compatible session API; installation alone is insufficient. All terminal drivers require the invoking host's CLI; doitall additionally requires native prify/goodcode child capacity. Terminal membership requires a supported process-ancestry probe (`ps -eo pid=,ppid=` in the shared helper), and launch commands use the destination shell's quoting. Native mode requires the full nested agent capacity documented in the skill. Herdr, tmux and Screen are optional; tmux integration tests require tmux; Screen tests require GNU Screen and Linux procfs. A skills-only plugin does not supply these executables or credentials. The helpers use CommonJS and Node built-ins without npm installation or a build step. See the [runtime dependency and upgrade contract](skills/bork-review/references/portable-runtime.md#runtime-dependencies-and-upgrades) for locking, platform support and coexistence with existing batches.

BORK defaults to the `generic` profile. Supply an absolute Markdown profile path with `PROFILE=/absolute/path/to/profile.md` for organization-specific rules. The package includes no organization profile or wrapper. Profile propagation and retained snapshots are documented in [the profile contract](skills/bork-doitall/references/profile.md).

If you report running inside hc, Herdr, tmux or Screen but the tool process lacks its context, discovery blocks instead of silently selecting another driver. Sandboxes, environment filters and detached tool backends can hide the invoking terminal. The shared helper accepts `expected_environment` to guard this case. On Linux it can recover hc, Herdr, tmux or Screen context from a unique same-user Codex frontend in the current working directory, verify its live pane/socket and shell ancestry, and route later terminal commands through that context. Multiple matching frontends remain blocked; discovery must run outside a sandbox that hides host processes.

Each skill retains its own authorization boundaries. Doitall displays a plan and requires a separate `go`, defaults to `REVIEWER=NONE`, and merges only with approved `DOMERGE`. Prify and goodcode have their documented publication behavior. Ghreview asks before posting its completed review. Review and fix use their coordination contract.

Goodcode invokes `bork-test` after review and fixes converge, before declaring success or removing its worktree. Required E2E/browser checks must pass against the identified implementation; failures return through review and fix, and unavailable required validation blocks completion. Test evidence is retained through `validation.json`. Entry paths that skip goodcode also skip this testing gate and are reported as untested.

## Repository layout

```text
plugin.json                         Portable Agent Plugins manifest
.agents/plugins/marketplace.json    Codex repository marketplace
.claude-plugin/plugin.json          Claude Code compatibility manifest
.claude-plugin/marketplace.json     Claude Code repository marketplace
skills/bork-*/                      Eight skills and bundled references/helpers/tests
```

Keep the skills together: their relative sibling links resolve when installed as adjacent folders, including inside the plugin. Source files were imported from the installed BORK skills; edits in this repository do not automatically update those original copies.

## Validate locally

Run the offline helper suites from the repository root:

```bash
node tests/run.js
```

See [test commands and prerequisites](tests/README.md) for individual suites and running from another directory. No package installation or Python interpreter is needed.

The doitall suite uses isolated tmux sockets and private GNU Screen socket directories. The review suite verifies SSH-signed fixture commits when `ssh-keygen` is available. Neither suite runs an AI workflow or contacts GitHub.

Packaging follows [OpenAI's plugin format](https://developers.openai.com/plugins/build/plugins). The root manifest uses the Agent Plugins schema, and the repository marketplace exposes that root as one installable plugin.

GNU Screen execution uses the same role jobs, terminal runner and recovery gates as Herdr/tmux. See the [Screen contract](skills/bork-doitall/references/screen.md) for capabilities, navigation and lifecycle controls.

The separate [hc execution driver](skills/bork-doitall/references/hc.md) verifies caller terminal/core identity and installed lifecycle capabilities. It launches interactive agents, hidden in headless mode, requires Codex `--no-daemon`, reconciles initial-task delivery and blocked prompts, and distinguishes accepted turns from final owned-process shutdown. `herdr-app` is optional and used only for requested visible UI changes. Offline hc fixtures run with `node tests/run.js test_hc`.


## Releases

`plugin.json` is the source of truth for the release version. Use the release command to update it and the Claude Code manifest together. Dependency and saved-data schema versions are independent of the release version.

Run these commands from the repository root on `main`. First run the [local validation](#validate-locally). The release command requires a clean working tree and index, a configured Git author identity, and working Git commit and tag signing. It uses your existing Git configuration and does not configure signing for you.

Choose the next SemVer version, then create the release locally:

```bash
read -r -p "Next release version: " bork_version
node scripts/release.js "$bork_version"
```

The command validates the version syntax and current manifest agreement, updates both manifests, creates a signed Conventional Commit, and creates a signed tag named exactly after the supplied version. Choose the appropriate version increment yourself. Existing local tags are never moved, and nothing is pushed automatically.

Inspect the release commit and tag:

```bash
git show --stat HEAD
git show --no-patch "$bork_version"
```

Publish the commit and that tag to a configured remote name or repository URL:

```bash
read -r -p "Git remote name or repository URL: " bork_remote
git push "$bork_remote" HEAD:main "refs/tags/$bork_version"
```

This publishes a Git tag; it does not create a GitHub Release or upload release assets.

If signing fails, inspect the working tree and latest commit before retrying. Failed commit signing leaves the manifest changes staged without creating a tag. Failed tag signing leaves the signed release commit in place; after fixing signing, create the missing signed tag on that release commit instead of rerunning the release command. Check that `HEAD` is still the release commit before doing so.

To check manifest agreement and SemVer syntax without making changes:

```bash
node scripts/release.js --check
```

`node tests/run.js` runs the same consistency check before any selected test suites.

## Visible workflow layout

The [shared layout contract](skills/bork-doitall/references/layout.md) defines one coordinator column and up to three master bands, each with reviewer above fixer on the right. Node.js helpers plan from actual geometry, journal ownership and stable role slots, reject uncertain/repeated creation, and remove only owned idle leaves. Tmux layout launches use the coordinator’s existing window; Herdr TUI uses its existing tab. Placeholders are ordinary shell panes, never filler agents.

Private real tmux, Herdr TUI, Herdr App/hc and GNU Screen validation covers concurrency 1/2/3 geometry and owned cleanup. App/hc also verifies stable visible worker binding and restart reconciliation; Screen verifies exact display discovery and saved-layout restoration. Headless hc and existing approved helper inputs remain compatible. No shared app is opened automatically. Provider trust/crash paths and untested platforms remain explicit validation limits. See the contract for focus, geometry and recovery details.

Run `node tests/run.js test_layout` for shared planner and isolated tmux validation.
