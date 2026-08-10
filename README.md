# Wheels Dev Workflow

Personal Herdr 0.8 workflow plugin for project chat, delegated OpenCode tasks,
Git worktrees, cleanup, and development tools.

## Requirements

- stable Herdr 0.8.0 or newer
- `git`
- GitHub CLI authenticated with `gh auth login` (only for GitHub-backed project creation and GitHub workflows)
- `python3`
- `opencode`
- `fzf`
- `pnpm`
- `zsh`
- `nvim`
- `lazygit`

Install `fzf` separately:

```bash
# macOS
brew install fzf

# Debian or Ubuntu
sudo apt install fzf
```

## Install

```bash
herdr integration install opencode
herdr plugin install swheel33/herdr-dev-workflow --yes
herdr config check
herdr plugin action invoke wheels.dev-workflow.doctor
```

For local plugin development:

```bash
herdr plugin link /path/to/herdr-dev-workflow
```

Installed and linked plugins are available to all Herdr sessions for the
current user.

## New Blank Project

Run the global **New blank project** action from any Herdr session. Its popup
asks for a project name and parent directory. The parent defaults to
`HERDR_PROJECTS_ROOT` when set, otherwise `~/Projects`.

The workflow deliberately creates no template, framework, package-manager
configuration, README, `.gitignore`, source file, or dependency. It only:

1. Validates the project name and resolves `~` and environment variables in the parent path.
2. Refuses path traversal, symbolic-link destinations, files, and existing non-empty directories. An existing empty directory is allowed.
3. Initializes Git with `main` and creates an empty commit named `Initial commit`.
4. Registers the repository with the plugin, opens its primary Herdr workspace, and focuses a new Project Chat tab.

The popup can optionally create a private or public GitHub repository. This
requires authenticated `gh`; the workflow creates `origin` and pushes `main`.
Local-only projects do not require `gh`. If GitHub authentication, repository
creation, or pushing fails, the initialized local repository is retained,
registered, and opened, and the exact GitHub error is reported.

The parent directory itself must already exist. Empty input accepts the shown
parent and GitHub defaults. `Ctrl-C` or end-of-input before creation cancels
without changing the filesystem.

## Dispatcher

The dispatcher opens normal OpenCode chat tabs in each project's primary
workspace. Chats inherit the user's complete OpenCode configuration, including
MCPs, plugins, credentials, and TUI settings.

- **Chat for current project** resolves the repository behind the focused pane.
- Linked worktree paths resolve back to their primary repository.
- If the focused pane is not in a repository, the project picker opens.
- **Chat for another project** always opens the project picker.
- **Chats** searches native OpenCode sessions across every known project and
  resumes the selection in its primary workspace.
- Project discovery combines known cleanup repositories with Git repositories
  under `HERDR_PROJECTS_ROOT` or `~/Projects`, excludes `.worktrees`, and
  deduplicates primary roots.

Discussion, questions, reviews, exploration, and planning remain in root
workspace tabs. The sidebar therefore contains primary projects and their
implementation worktrees rather than separate discussion workspaces. Chats can
remain open while the user moves between workspaces.

Chat tabs use a fixed **Project Chat** agent that denies direct edits in the
primary checkout. OpenCode's new/list/fork/delete/move session controls and
agent switching are disabled in these tabs; use `prefix+space` for another chat
and `prefix+c` for history. Normal implementation workspaces retain the usual
Build and Plan agents.

The Chats picker includes sessions rooted at primary checkouts and excludes
linked-worktree implementation sessions. OpenCode remains the sole source of
truth for transcripts; the plugin does not maintain a second history.

Requests requiring code changes are dispatched to a new `wheels/<slug>` branch
at `<repo>/.worktrees/<slug>`.

A dispatched task receives this layout:

- top 70%: the only OpenCode agent
- bottom 30%: unused interactive shell

The plugin fetches the selected repository, creates the linked worktree without
focusing it, splits the root pane, starts one named OpenCode agent, and submits
the complete request without waiting. It focuses the new workspace and closes
only the source chat tab after every dispatch step succeeds. On failure, the
exact error remains visible in the chat tab and the incomplete workspace is not
focused.

## Worktree Cleanup

Closing any linked-worktree workspace is permanent cleanup, regardless of why
it closed. Uncommitted changes are force-discarded.

Cleanup runs these persisted, idempotent phases:

1. Delete the configured upstream branch, or the same-named `origin` branch.
2. Unlock and force-remove the linked checkout.
3. Delete the local branch.
4. Prune Git worktree metadata.

Primary checkouts, their checked-out branches, `origin/HEAD`, `main`, and
`master` are protected. Cleanup stops rather than guessing when event, path, or
branch metadata does not match.

Failures retain the job, failed phase, command, exit code, stdout, and stderr.
Each hook, startup, or manual retry makes one attempt. Already-missing resources
count as completed phases, and successful jobs are removed. Do not recreate a
pending job's branch or checkout path before retrying it.

A singleton plugin process also checks GitHub immediately at startup and every
hour. A `wheels/*` worktree is automatically closed and cleaned only when a
merged pull request matches both its branch and exact head commit. Closed but
unmerged pull requests and reused branch names are ignored. If multiple Herdr
sessions are running, the workspace is focused, the agent is not idle/done, or
the checkout is dirty, the plugin notifies once and leaves that worktree for
manual cleanup. Set
`HERDR_AUTO_PRUNE_INTERVAL_SECONDS` to change the interval; values below 60
seconds are clamped.

Available actions:

- **Retry pending worktree cleanup**
- **Show pending worktree cleanup failures**
- **Show worktree cleanup log**
- **Adopt current workspaces**

## Startup Reconciliation

At startup the plugin:

1. Attempts every pending cleanup job once.
2. Discovers and maintains known primary repository roots.
3. Leaves unresolved cleanup paths closed.
4. Opens linked worktrees that do not already have a workspace.
5. Applies the standard 70/30 OpenCode and shell layout to newly opened linked workspaces in parallel.
6. Starts the hourly merged-PR cleanup poller.

Cleanup and workspace opening are serialized per repository; independent layout
startup runs concurrently.

**Adopt current workspaces** resolves every live workspace and pane back to its
primary Git repository and persists those roots in plugin state. Git worktree
metadata remains the source of truth; the plugin does not copy checkouts into
its state.

To rebuild a named Herdr session from existing worktrees, adopt first, then stop
and delete the session rather than closing its workspaces individually:

```bash
herdr plugin action invoke wheels.dev-workflow.adopt-workspaces
herdr session stop <name>
herdr session delete <name>
herdr --session <name>
```

Closing the workspaces individually invokes permanent cleanup. A rebuilt
session recreates fresh OpenCode and shell processes; it does not restore live
terminal processes or scrollback.

## Sidebar

Primary project workspaces hold general chat tabs. Linked child workspaces hold
implementation agents. The example keeps Herdr's default Space rows and leaves
Agent rows empty.

## Logs

Lifecycle activity is written as JSON Lines to:

```text
$HERDR_PLUGIN_STATE_DIR/lifecycle.jsonl
```

The log includes hook payloads, cleanup jobs, phase transitions, retries,
reconciliation, notifications, and Git/Herdr commands with exit code, stdout,
and stderr. At 5 MiB it rotates to `lifecycle.jsonl.1`; one rotated file is
retained. Logging is best-effort and never blocks cleanup.

Use **Show worktree cleanup log** to view the newest 1,000 entries in Herdr.

## Keybindings

Suggested bindings from [`keybindings.example.toml`](keybindings.example.toml):

- `prefix+space`: chat for current project
- `prefix+shift+space`: chat for another project
- `prefix+c`: search chats across all projects
- `prefix+n`: create a blank project
- `prefix+o`: open a worktree or `origin/*` branch
- `prefix+a`: open all managed worktrees
- `prefix+p`: retry pending cleanup jobs
- `prefix+shift+p`: show pending cleanup failures
- `prefix+g`: open lazygit
- `prefix+e`: open Neovim

Add the example entries to `~/.config/herdr/config.toml`, then run
`herdr server reload-config` or restart Herdr.

## Neovim Clipboard

Herdr forwards OSC 52 clipboard writes. Merge the relevant settings from
[`examples/nvim/options.lua`](examples/nvim/options.lua) into your existing
Neovim options rather than replacing the file.
