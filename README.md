# Wheels Dev Workflow

Herdr plugin for discussion-first project chat, OpenCode 2 implementation
dispatch, disposable Git worktrees, and durable cleanup.

## Requirements

- Herdr 0.8.0 or newer
- Node.js 24 or newer
- `git`, the `opencode2` preview, and `fzf`
- `pnpm` to bootstrap implementation worktrees
- `gh` for GitHub project creation, pull-request targets, and merged-PR cleanup
- `nvim` and `lazygit` for their optional actions

Install the OpenCode 2 preview alongside OpenCode V1:

```bash
pnpm add -g --allow-build=@opencode-ai/cli @opencode-ai/cli@next
```

## Installation

```bash
herdr plugin install swheel33/herdr-dev-workflow --yes
herdr config check
herdr plugin action invoke wheels.dev-workflow.workflow-status
```

For local development:

```bash
pnpm install
pnpm build
herdr plugin link /path/to/herdr-dev-workflow --enabled
```

The Herdr startup hook creates the private workflow SQLite database and installs
a managed OpenCode server loader under `~/.config/opencode/plugins`. OpenCode
discovers it natively, so no config entry or wrapper binary is required. V1
remains available as `opencode`; V2 runs as `opencode2` with its standard shared
database and background service. Preview updates remain enabled, and the
workflow restarts a stale service when its version differs from the installed
CLI.

## Project Chat

Project Chat is the project home for discussion, planning, inspection, and
review. Its OpenCode agent denies edits, shell commands, and subagents while
retaining normal read, search, web, MCP, model, credential, and provider
configuration.

**Project Chat** resolves the focused checkout back to its primary repository.
Outside a Git checkout it opens the project picker under `HERDR_PROJECTS_ROOT`,
defaulting to `~/Projects`. The primary-checkout workspace itself is the
persistent Project Chat hub: selecting the primary branch in Herdr opens the
full OpenCode UI, and OpenCode's native tabs and session list own chat creation
and history. Project Chat uses OpenCode's built-in standalone server lifecycle;
the server companion exposes only the Project Chat primary agent in that host.
It still shares OpenCode's standard database, credentials, MCP configuration,
and conversation history. Invoking the action again focuses the primary
workspace. Linked branch workspaces retain the 70/30 OpenCode Build and shell
layout, while ordinary `opencode2` sessions remain unchanged and default to
Build.

OpenCode remains authoritative for messages, attachments, compaction, session
lineage, model selection, provider selection, and history. The plugin never
exports or copies transcripts.

## Dispatch

When implementation is requested, Project Chat calls one typed
`dispatch_implementation` tool. The tool receives the authoritative OpenCode
session and message IDs, so it can fork immediately before the active dispatch
turn without parsing commands or transcript text.

Dispatch supports:

- **New work**: create `wheels/<slug>` from the repository default branch at
  `<repo>/.worktrees/<slug>`.
- **Existing branch**: reuse its linked checkout or create a tracking worktree.
- **Pull request**: resolve a same-repository PR number or URL to its exact head.
  Cross-repository PRs are rejected before mutation.

The target workspace opens in the background with a 70% OpenCode Build pane and
a 30% shell. Matching `apps/*/.env` files are symlinked from the primary
checkout, and `pnpm install` starts in the shell pane.

The source session is forked with a native `before` boundary, moved to the
target checkout, switched to Build, renamed to the conversation title, and
prompted through the V2 HTTP API. The source Project Chat conversation remains
in native history after confirmed delivery. The implementation fork contains
the preceding conversation and complete handoff, so that shared prefix appears
in both records. The prompt request is the delivery boundary:

- Before the prompt request begins, a failure is retryable. Any worktree,
  workspace, branch, or fork already created is deliberately preserved for
  inspection instead of being rolled back.
- After confirmed delivery, bookkeeping failures are warnings and never cause a
  second implementation prompt.
- If the prompt request starts but its response is lost or times out, delivery is
  recorded as unknown and the implementation workspace is preserved. The same
  source turn remains non-retryable to prevent duplicate implementation.

New dispatches safely fast-forward a clean primary default branch. Dirty or
diverged primary checkouts block new-branch dispatch. Existing targets are never
reset, rebased, or rewritten by dispatch.

## Cleanup

Closing a dispatched linked-worktree workspace permanently removes its checkout.
Uncommitted worktree changes are force-discarded by design.

Branch deletion follows explicit SQLite ownership:

- New work owns its local `wheels/*` branch and same-named remote branch, so both
  may be deleted.
- An existing local branch keeps both its local and remote branch.
- An origin branch or PR owns only the local tracking branch created for its
  worktree; cleanup deletes that local branch and preserves the remote.
- Branch names and prefixes never prove ownership by themselves.

Cleanup persists and retries these phases:

1. Validate repository, checkout, branch, ownership, and protected-branch rules.
2. Delete an owned remote branch when present.
3. Unlock and force-remove the linked checkout.
4. Delete the local branch when the plugin created it.
5. Prune Git worktree metadata.

The primary checkout, its branch, the repository default branch, `main`,
`master`, and `HERDR_PROTECTED_BRANCHES` are never deleted. Duplicate Herdr
events and concurrent cleanup processes are serialized through SQLite leases.

**Workflow Status** retries pending jobs and displays anything still failing.

## Automatic Pruning

A singleton hourly watcher examines every dispatched linked worktree. New work,
existing branches, and PR targets use the same pruning path. It closes a
workspace when its exact head is integrated into the repository default branch
or matches a same-repository merged pull request. A target with no implementation
commits is not considered integrated unless its exact PR head was merged.

Automatic closure is blocked while multiple Herdr sessions run, the workspace
is focused, the agent is active, or the checkout is dirty. The first block is
reported and later scans reconsider it. Set `HERDR_AUTO_PRUNE_INTERVAL_SECONDS`
to change the interval; values below 60 seconds are clamped.

Every blocked, attempted, completed, and failed automatic prune is recorded in
SQLite. **Workflow Status** shows the 20 most recent prune and cleanup entries.

## Blank Projects

**New blank project** creates only a Git repository on `main` with an empty
`Initial commit`, then opens Project Chat. The popup optionally creates and
pushes a public or private GitHub repository. GitHub failure preserves the local
repository.

## State

All plugin state lives in:

```text
$HERDR_PLUGIN_STATE_DIR/workflow.sqlite
```

The database stores dispatch receipts, managed-target ownership, cleanup jobs,
Project Chat hub mappings, auto-prune blocks, repository discovery, and bounded
diagnostic messages. It does not store prompts, transcripts, or OpenCode
history. SQLite failures stop destructive work rather than falling back to
guessed state.

## Other Actions

- **Open lazygit**
- **Open Neovim**
- **Workflow Status** checks dependencies, retries cleanup, reports remaining
  failures, and shows recent pruning activity.

Suggested shortcuts are in [`keybindings.example.toml`](keybindings.example.toml).
Herdr forwards OSC 52 clipboard writes; merge the relevant settings from
[`examples/nvim/options.lua`](examples/nvim/options.lua) into the existing
Neovim configuration.
