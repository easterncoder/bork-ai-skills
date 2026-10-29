# BORK AI Skills

A private, skills-only plugin for GitHub issue and pull request workflows. Version 0.1.0.

| Skill | Purpose |
| --- | --- |
| `bork-batch` | Group related issues for execution. |
| `bork-doitall` | Coordinate the issue/PR workflow through implementation and review. |
| `bork-prify` | Implement one issue and publish a draft PR. |
| `bork-goodcode` | Coordinate review, fixes, pushes, and ready-PR feedback. |
| `bork-review` | Review within the coordinated review/fix loop. |
| `bork-fix` | Fix and validate the loop's blocking findings. |
| `bork-ghreview` | Perform one PR review, with confirmation before posting. |

## Install with Codex

Authenticate Git access to this private repository first. On Codex versions with plugin CLI support:

```bash
codex plugin marketplace add easterncoder/bork-ai-skills --ref main
codex plugin add bork@bork-ai-skills
```

Start a new conversation after installation so the host discovers the packaged skills. In the desktop plugin browser, select the `bork-ai-skills` marketplace and install **BORK** if your client uses the UI install flow.

The plugin exposes its bundled skills using the host's plugin namespace. Select the skill from the skill picker; the Markdown files retain the names shown above. Installing the package makes the instructions and helpers available. It does not run an issue workflow or grant GitHub permissions.

If the same BORK skills are already installed individually, use one installation source to avoid duplicate entries. This repository does not replace or remove an existing installation automatically.

## Requirements and behavior

Use a host with terminal access, Git, authenticated GitHub CLI (`gh`), PHP 8+, and Python 3 for the offline tests. Signing workflows need a configured signing key and signature verification trust. Goodcode needs native concurrent agents. Doitall needs the agent nesting/capacity in its skill, or its documented tmux fallback; tmux is required only for that fallback and its integration tests. A skills-only plugin does not supply these executables or credentials.

BORK defaults to the `generic` profile. Supply an absolute Markdown profile path with `PROFILE=/absolute/path/to/profile.md` for organization-specific rules. The package includes no organization profile or wrapper. Profile propagation and retained snapshots are documented in [the profile contract](skills/bork-doitall/references/profile.md).

Each skill retains its own authorization boundaries. Doitall displays a plan and requires a separate `go`, defaults to `REVIEWER=NONE`, and merges only with approved `DOMERGE`. Prify and goodcode have their documented publication behavior. Ghreview asks before posting its completed review. Review and fix use their coordination contract.

## Repository layout

```text
plugin.json                         Portable Agent Plugins manifest
.agents/plugins/marketplace.json    Private repository marketplace
skills/bork-*/                      Seven skills and bundled references/helpers/tests
```

Keep the skills together: their relative sibling links resolve inside the installed plugin. Source files were imported from the installed BORK skills; edits in this repository do not automatically update those original copies.

## Validate locally

Run the offline helper suites from the repository root:

```bash
python3 -m unittest discover -s skills/bork-doitall/scripts/tests -v
python3 -m unittest discover -s skills/bork-review/scripts/tests -v
```

The doitall suite uses isolated tmux sockets. The review suite verifies SSH-signed fixture commits when `ssh-keygen` is available. Neither suite runs an AI workflow or contacts GitHub.

Packaging follows [OpenAI's plugin format](https://developers.openai.com/plugins/build/plugins). The root manifest uses the Agent Plugins schema, and the repository marketplace exposes that root as one installable plugin.
