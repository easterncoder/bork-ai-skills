# BORK: Bork of Remarkable Knowledge

A private collection of skills for GitHub issue and pull request workflows, available as standalone skill folders or as a plugin. Version 0.1.1.

| Skill | Purpose |
| --- | --- |
| `bork-batch` | Group related issues for execution. |
| `bork-doitall` | Coordinate the issue/PR workflow through implementation and review. |
| `bork-prify` | Implement one issue and publish a draft PR. |
| `bork-goodcode` | Coordinate review, fixes, pushes, and ready-PR feedback. |
| `bork-review` | Review within the coordinated review/fix loop. |
| `bork-fix` | Fix and validate the loop's blocking findings. |
| `bork-ghreview` | Perform one PR review, with confirmation before posting. |

## Install without the plugin

The plugin is optional. You can install the skill folders directly in your agent's skills directory. Keep all seven BORK folders together because the workflows call each other and use relative sibling links.

For a shared installation, authenticate GitHub access to this private repository, then clone it into a permanent location and link its skills into `~/.agents/skills`:

```bash
gh repo clone easterncoder/bork-ai-skills
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

You can also copy all seven folders instead of linking them, but copied installations require separate updates. For a project-scoped installation, Codex and Antigravity support `<project>/.agents/skills/`; Claude Code uses `<project>/.claude/skills/`.

Start a new conversation after installation. Invoke a standalone skill as `$bork-doitall 123` in Codex CLI or `/bork-doitall 123` in Claude Code. Standalone installation has the same [requirements and behavior](#requirements-and-behavior) as the plugin.

## Install with Codex

Authenticate Git access to this private repository first. On Codex versions with plugin CLI support:

```bash
codex plugin marketplace add easterncoder/bork-ai-skills --ref main
codex plugin add bork@bork-ai-skills
```

Start a new conversation after installation so the host discovers the packaged skills. In the desktop plugin browser, select the `bork-ai-skills` marketplace and install **BORK** if your client uses the UI install flow.

The plugin exposes its bundled skills using the host's plugin namespace. Select the skill from the skill picker; the Markdown files retain the names shown above. Installing the package makes the instructions and helpers available. It does not run an issue workflow or grant GitHub permissions.

If the same BORK skills are already installed individually, use one installation source to avoid duplicate entries. This repository does not replace or remove an existing installation automatically.

## Install with Claude Code

Git must have access to this private GitHub repository. In your terminal:

```bash
claude plugin marketplace add easterncoder/bork-ai-skills
claude plugin install bork@bork-ai-skills
```

Restart Claude Code after installation. Invoke a bundled skill with its plugin namespace, for example:

```text
/bork:bork-doitall 123
/bork:bork-goodcode 123
```

Claude Code also accepts `/bork-doitall 123` or `/bork-goodcode 123` when no other command uses that name. The namespaced form explicitly selects the plugin's skill.

Inside Claude Code, the equivalent install commands are `/plugin marketplace add easterncoder/bork-ai-skills` and `/plugin install bork@bork-ai-skills`.

## Requirements and behavior

Use a host with terminal access, Git, authenticated GitHub CLI (`gh`), PHP 8+, and Python 3 for the offline tests. Signing workflows need a configured signing key and signature verification trust. Standalone goodcode also selects Herdr, tmux, Screen, then native for its concurrent review/fix workers. Doitall selects the active environment: Herdr first, otherwise tmux, otherwise Screen, otherwise native. It verifies live membership separately from capacity and blocks invalid explicit context or an incapable selected driver without falling back. Herdr requires an inherited Herdr TUI context and a reachable compatible session API; installation alone is insufficient. All terminal drivers require the invoking host's CLI; doitall additionally requires native prify/goodcode child capacity. Terminal membership requires a supported process-ancestry probe (`ps -eo pid=,ppid=` in the shared helper), and launch commands use the destination shell's quoting. Native mode requires the full nested agent capacity documented in the skill. Herdr, tmux and Screen are optional; tmux integration tests require tmux; Screen tests require GNU Screen and Linux procfs. A skills-only plugin does not supply these executables or credentials.

BORK defaults to the `generic` profile. Supply an absolute Markdown profile path with `PROFILE=/absolute/path/to/profile.md` for organization-specific rules. The package includes no organization profile or wrapper. Profile propagation and retained snapshots are documented in [the profile contract](skills/bork-doitall/references/profile.md).

If you report running inside Herdr, tmux or Screen but the tool process lacks its context, discovery blocks instead of silently selecting another driver. Sandboxes, environment filters and detached tool backends can hide the invoking terminal. The shared helper accepts `expected_environment` to guard this case. On Linux it can recover Herdr, tmux or Screen context from a unique same-user Codex frontend in the current working directory, verify its live pane/socket and shell ancestry, and route later terminal commands through that context. Multiple matching frontends remain blocked; discovery must run outside a sandbox that hides host processes.

Each skill retains its own authorization boundaries. Doitall displays a plan and requires a separate `go`, defaults to `REVIEWER=NONE`, and merges only with approved `DOMERGE`. Prify and goodcode have their documented publication behavior. Ghreview asks before posting its completed review. Review and fix use their coordination contract.

## Repository layout

```text
plugin.json                         Portable Agent Plugins manifest
.agents/plugins/marketplace.json    Codex repository marketplace
.claude-plugin/plugin.json          Claude Code compatibility manifest
.claude-plugin/marketplace.json     Claude Code repository marketplace
skills/bork-*/                      Seven skills and bundled references/helpers/tests
```

Keep the skills together: their relative sibling links resolve when installed as adjacent folders, including inside the plugin. Source files were imported from the installed BORK skills; edits in this repository do not automatically update those original copies.

## Validate locally

Run the offline helper suites from the repository root:

```bash
python3 -m unittest discover -s skills/bork-doitall/scripts/tests -v
python3 -m unittest discover -s skills/bork-review/scripts/tests -v
```

The doitall suite uses isolated tmux sockets and private GNU Screen socket directories. The review suite verifies SSH-signed fixture commits when `ssh-keygen` is available. Neither suite runs an AI workflow or contacts GitHub.

Packaging follows [OpenAI's plugin format](https://developers.openai.com/plugins/build/plugins). The root manifest uses the Agent Plugins schema, and the repository marketplace exposes that root as one installable plugin.

GNU Screen execution uses the same role jobs, terminal runner and recovery gates as Herdr/tmux. See the [Screen contract](skills/bork-doitall/references/screen.md) for capabilities, navigation and lifecycle controls.
