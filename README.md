# Wheels Dev Workflow

Personal Herdr 0.8 workflow plugin for project chat, delegated OpenCode tasks,
Git worktrees, cleanup, and development tools.

## Requirements

- stable Herdr 0.8.0 or newer
- `git`
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

## Dispatcher

The dispatcher opens a fresh OpenCode TUI for project discussion and task
delegation. Every invocation starts a new conversation.

- **Chat for current project** resolves the repository behind the focused pane.
- Linked worktree paths resolve back to their primary repository.
- If the focused pane is not in a repository, the project picker opens.
- **Chat for another project** always opens the picker.
- The picker combines known cleanup repositories with Git repositories under
  `~/Projects`, excludes `.worktrees` checkouts, and deduplicates primary roots.

Discussion, questions, reviews, exploration, and planning stay in the popup.
Requests requiring code changes are dispatched to a new `wheels/<slug>` branch
at `<repo>/.worktrees/<slug>`.

A dispatched task receives this layout:

- top 70%: the only OpenCode agent
- bottom 30%: unused interactive shell

The plugin fetches the selected repository, creates the linked worktree without
focusing it, splits the root pane, starts one named OpenCode agent, and submits
the complete request without waiting. It focuses the new workspace and closes
the popup only after every dispatch step succeeds. On failure, the exact error
remains visible in the open popup and the incomplete workspace is not focused.

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

Available actions:

- **Retry pending worktree cleanup**
- **Show pending worktree cleanup failures**
- **Show worktree cleanup log**

## Startup Reconciliation

At startup the plugin:

1. Attempts every pending cleanup job once.
2. Discovers and maintains known primary repository roots.
3. Leaves unresolved cleanup paths closed.
4. Opens linked worktrees that do not already have a workspace.
5. Applies the standard 70/30 OpenCode and shell layout to newly opened workspaces.
6. Restores the stable Agent sidebar ordering and repository metadata.

Cleanup and reconciliation are serialized per repository.

## Sidebar

The example configuration installs an unfiltered Agent view ordered by
workspace, tab, and pane. Agent rows display:

1. semantic status and the bold workspace/worktree label
2. repository and branch

Terminal titles are not used as workspace titles. Agent and Space rows use
Herdr's supported packed `row_gap = 0` layout.

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
- `prefix+l`: set up the standard layout here
- `prefix+n`: create a personal worktree
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
