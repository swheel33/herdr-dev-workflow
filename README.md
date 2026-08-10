# Wheels Dev Workflow

Herdr workflow plugin for project-level chat, delegated OpenCode implementation,
Git worktrees, project creation, and automatic cleanup.

## Requirements

- Herdr 0.8.0 or newer on the stable channel
- `git`, `python3`, `opencode`, `fzf`, and `zsh`
- `gh` for GitHub-backed project creation and merged-PR cleanup
- `nvim`, `lazygit`, and `pnpm` for the optional development actions

Install `fzf` separately if it is not already available:

```bash
# macOS
brew install fzf

# Debian or Ubuntu
sudo apt install fzf
```

## Installation

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

## Workflow Model

Each repository has two kinds of Herdr workspace:

- The primary repository workspace is the project home. It contains Project
  Chat tabs for discussion, planning, review, and dispatch.
- Linked-worktree workspaces contain implementation agents and shells. They are
  disposable and map to branches under `wheels/*`.

Project Chat is deliberately discussion-only. Its OpenCode agent inherits the
normal user configuration, MCPs, plugins, credentials, and TUI settings, but it
denies file edits in the primary checkout and disables Build, Plan, agent
switching, and OpenCode session-management controls.

## Project Chat

Available actions:

- **Chat for current project** resolves the repository behind the focused pane.
  A linked worktree resolves back to its primary repository. If the pane is not
  inside Git, the project picker opens.
- **Chat for another project** opens the project picker.
- **Chats** opens searchable history for the focused pane's primary project.

Project discovery combines repositories previously adopted by the plugin with
Git repositories under `HERDR_PROJECTS_ROOT`, or `~/Projects` by default.
Managed `.worktrees` directories are excluded and linked checkouts are
deduplicated back to their primary repository.

### Dispatch

When a request needs code changes, Project Chat invokes the dispatcher once with
a complete handoff. The dispatcher:

1. Validates the source Project Chat, repository, and requested slug.
2. Fetches `origin` and safely synchronizes a clean, fast-forwardable primary
   `main` with `origin/main`.
3. Creates `wheels/<slug>` at `<repo>/.worktrees/<slug>` without changing focus.
4. Splits the implementation workspace into a 70% OpenCode pane and a 30%
   interactive shell, also without changing focus.
5. Verifies the checkout is the expected registered linked worktree and that the
   primary checkout's branch and HEAD have not changed.
6. Starts OpenCode's Build agent as a fork of the source Project Chat session,
   preserving the full planning and discussion context without retaining the
   discussion-only Project Chat role.
7. Waits for structured idle readiness, then verifies both the pane cwd and the
   forked OpenCode session directory resolve to the linked worktree before
   submitting the request once.
8. Confirms Herdr observed the expected session transition, revalidates checkout
   isolation, and records both sessions as one logical history thread.
9. Ensures one fresh, unfocused Project Chat exists in the primary workspace and
   closes the used chat without creating a duplicate.

The implementation workspace never steals focus. The dispatcher does not call
`workspace focus` or `tab focus`. If the user moved elsewhere while dispatch was
starting, the new workspace and replacement Project Chat remain in the
background. If the used Project Chat is still active, closing it naturally
reveals the fresh project home screen.

Failures before confirmed prompt delivery leave the source Project Chat open
with the exact error. A pane or OpenCode session directory mismatch is fatal and
prevents prompt submission, including when an OpenCode version preserves the
source session's primary-root directory while forking. After delivery, the
implementation is already running; history persistence and chat replacement
failures are reported as non-fatal cleanup warnings and must not be retried.

Primary synchronization never resets or force-updates local work. Dirty or
diverged primary checkouts block dispatch. Repositories without `origin` use an
available local base branch.

### Combined History

Dispatch uses OpenCode session forks rather than copying transcripts. The
implementation session therefore includes the original Project Chat context,
the dispatched request, implementation decisions, tool activity, and resulting
change context.

The **Chats** picker collapses the source and implementation sessions into one
logical row and selects the latest session in that thread. Choosing a dispatched
thread forks its combined context into a discussion-only Project Chat at the
primary repository root. This remains usable after the implementation worktree
and branch have been deleted, which is useful when a merged change needs a
follow-up.

The history popup displays `Loading chat history...` while that project's
OpenCode sessions are enumerated, then opens `fzf` with title and update time.
Native root sessions that have never dispatched remain independent rows.
Sessions created before thread tracking was introduced cannot be paired
retroactively.

OpenCode remains the source of truth for transcript content. The plugin stores
only session relationships and dispatch metadata in
`$HERDR_PLUGIN_STATE_DIR/dispatch-threads.json`.

## New Blank Project

Run **New blank project** from any Herdr session. The popup asks for a project
name, parent directory, and optional GitHub visibility. The parent defaults to
`HERDR_PROJECTS_ROOT` or `~/Projects`.

The workflow creates no framework, package-manager files, README, `.gitignore`,
source code, or dependencies. It only validates the destination, initializes
Git on `main`, creates an empty `Initial commit`, registers the repository, and
opens its primary workspace with Project Chat. An existing empty destination is
allowed; non-empty directories, files, symbolic-link destinations, and path
traversal are rejected.

GitHub creation requires authenticated `gh`. If GitHub authentication, remote
creation, or pushing fails, the initialized local repository is retained and
opened with the exact error reported.

## Worktree Cleanup

Closing a linked-worktree workspace is permanent cleanup. Uncommitted worktree
changes are force-discarded. Cleanup persists and retries these idempotent phases:

1. Delete the configured upstream branch, or the same-named `origin` branch.
2. Unlock and force-remove the linked checkout.
3. Delete the local branch.
4. Prune Git worktree metadata.

Primary checkouts, their checked-out branches, `origin/HEAD`, `main`, `master`,
and branches listed in `HERDR_PROTECTED_BRANCHES` are protected. Cleanup stops
rather than guessing when event, path, branch, or repository metadata conflicts.

A singleton poller fetches known repositories at startup and hourly. It closes a
clean, idle `wheels/*` workspace when its exact head is integrated into
`origin/main`, or when a merged pull request matches both branch and head commit.
It will not auto-close while multiple Herdr sessions are running, the workspace
is focused, the agent is active, or the checkout is dirty. Blocked worktrees are
re-evaluated later without repeated notifications.

Set `HERDR_AUTO_PRUNE_INTERVAL_SECONDS` to change the polling interval. Values
below 60 seconds are clamped.

Cleanup actions:

- **Retry pending worktree cleanup**
- **Show pending worktree cleanup failures**
- **Show worktree cleanup log**
- **Adopt current workspaces**

## Startup Reconciliation

At startup the plugin retries pending cleanup, adopts known repositories, keeps
pending cleanup paths closed, opens registered linked worktrees that lack a
workspace, applies the standard 70/30 layout in parallel, and starts merged-PR
polling. Git worktree metadata remains the source of truth for checkouts.

To rebuild a named Herdr session without treating each workspace close as
permanent worktree cleanup:

```bash
herdr plugin action invoke wheels.dev-workflow.adopt-workspaces
herdr session stop <name>
herdr session delete <name>
herdr --session <name>
```

The rebuilt session recreates OpenCode and shell processes; it does not restore
live terminal processes or scrollback.

## Other Actions

- **New personal branch** creates a managed worktree.
- **Open worktree or origin branch** opens an existing checkout or remote branch.
- **Open all managed worktrees** restores every managed checkout.
- **Open lazygit** and **Open Neovim** launch project tools.
- **Check workflow dependencies** validates local requirements.

## Keybindings

Suggested bindings from [`keybindings.example.toml`](keybindings.example.toml):

- `prefix+space`: chat for current project
- `prefix+shift+space`: chat for another project
- `prefix+c`: search combined chat history
- `prefix+n`: create a blank project
- `prefix+o`: open a worktree or `origin/*` branch
- `prefix+a`: open all managed worktrees
- `prefix+p`: retry pending cleanup jobs
- `prefix+shift+p`: show pending cleanup failures
- `prefix+g`: open lazygit
- `prefix+e`: open Neovim

Add the example entries to `~/.config/herdr/config.toml`, then run
`herdr server reload-config` or restart Herdr.

## State And Logs

Structured lifecycle events are written to:

```text
$HERDR_PLUGIN_STATE_DIR/lifecycle.jsonl
```

The log contains hook payloads, command results, dispatch transitions,
notifications, reconciliation, and cleanup phases. It rotates at 5 MiB and
retains one previous file. Logging is best-effort and never blocks cleanup.

Pending cleanup jobs, repository discovery, merged-worktree safety blocks, and
dispatch thread relationships live under `$HERDR_PLUGIN_STATE_DIR`. Use **Show
worktree cleanup log** to view the newest 1,000 lifecycle entries in Herdr.

## Neovim Clipboard

Herdr forwards OSC 52 clipboard writes. Merge the relevant settings from
[`examples/nvim/options.lua`](examples/nvim/options.lua) into the existing
Neovim configuration rather than replacing it.
