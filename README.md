# Wheels Dev Workflow

Portable Herdr plugin for personal git worktree workflows and development tools.

The manifest remains at version `0.0.1` during development and is only versioned when an actual release is published.

Requires Herdr 0.7.5 or newer.

## Install

Install the workflow dependencies first. `fzf` powers the interactive worktree
and branch menus and must be installed separately from the plugin:

```bash
# macOS
brew install fzf

# Debian or Ubuntu
sudo apt install fzf
```

After the repository is published, install the plugin from GitHub:

```bash
herdr plugin install swheel33/herdr-dev-workflow --yes
```

Installed and linked plugins are global to the current user in Herdr 0.7.5. If
the plugin was previously installed only in a named Herdr session, install or
link it again after upgrading.

When developing the plugin locally, link its checkout instead:

```bash
herdr plugin link /path/to/herdr-dev-workflow
```

Run the dependency check from Herdr's plugin action menu, or from the CLI:

```bash
herdr plugin action invoke wheels.dev-workflow.doctor
```

Install the OpenCode lifecycle integration and the official Herdr skill:

```bash
herdr integration install opencode
npx skills add ogulcancelik/herdr --skill herdr -g
```

Restart OpenCode after installing or updating its integration, skills, or
configuration.

## Keybindings

- `prefix+l`: set up the two-pane dev layout in the current workspace
- `prefix+n`: create a new `wheels/<name>` worktree from a selected base branch
- `prefix+o`: pick in a popup and open any existing worktree or `origin/*` branch
- `prefix+a`: open all managed worktrees
- `prefix+p`: automatically prune eligible managed and OpenCode worktrees plus standalone local branches
- `prefix+shift+p`: select and confirm a managed worktree, then prune it in the background
- `prefix+g`: open `lazygit` in a popup
- `prefix+e`: open `nvim` in a temporary full overlay

Keybindings live in Herdr's global `config.toml` and invoke portable plugin actions.
The plugin itself contains no user-specific absolute paths.
See [`keybindings.example.toml`](keybindings.example.toml) for the complete binding block.

## Layout

- top pane: a named `opencode` agent started through `herdr agent start`
- bottom pane: shell, or `pnpm install` for newly created worktrees

The agent name combines the workspace label and pane ID, so the agent can be
addressed reliably with Herdr 0.7.5 commands such as `herdr agent get`,
`herdr agent prompt`, and `herdr agent wait`.

## OpenCode Feature Spaces

The official Herdr skill gives an OpenCode agent access to Herdr's workspace,
worktree, pane, and agent commands when `HERDR_ENV=1`. Keep the skill installed
globally rather than copying it into every application repository.

A personal OpenCode instruction can authorize this feature-space policy:

- read-only exploration and OpenCode task subagents stay in the current space
- reuse the current worktree only when it belongs to the requested feature
- create a new Herdr worktree workspace when the current checkout is primary, unrelated, or uncertain
- use `wheels/<slug>` and `<repo>/.worktrees/<slug>` for new feature work
- use current `HEAD` for default-branch work or intentional stacked work
- use `develop`, then the repository default, for unrelated work
- start and prompt a named OpenCode agent in the new workspace
- leave the originating workspace open and never prune the new space automatically

The policy should be conditional on `HERDR_ENV=1`; outside Herdr, OpenCode
continues its normal workflow. OpenCode's experimental internal workspace
feature is not required because Herdr remains the visible workspace and agent
orchestrator.

Herdr 0.7.5 separates topology from agent startup. An agent creates a worktree
workspace, reads the returned root pane ID, starts OpenCode there, and submits
the implementation task:

```bash
herdr worktree create \
  --cwd "$repo_root" \
  --branch "wheels/$slug" \
  --base "$base_ref" \
  --path "$repo_root/.worktrees/$slug" \
  --label "$slug" \
  --no-focus \
  --json

herdr agent start "$agent_name" --kind opencode --pane "$root_pane_id" -- "$worktree_path"
herdr agent prompt "$agent_name" "$implementation_task"
```

Parse workspace and pane IDs from Herdr's JSON responses instead of deriving
them. The official skill contains the complete safety and coordination rules.

## Worktree Conventions

- managed worktrees live under `<repo>/.worktrees`
- new personal branches are named `wheels/<slug>`
- new personal branches use `wheels/<slug>` locally and `.worktrees/<slug>` on disk
- new personal branches prefer `develop` as their base, then fall back to the repository default
- the base selector shows fetched `origin/*` branches plus deduplicated local-only branches
- the open selector includes managed and external Git worktrees and reuses existing checkouts
- origin branches keep the exact origin branch name locally and use a slugged worktree path
- selecting `origin/alice/checkout-fix` opens local branch `alice/checkout-fix` at `.worktrees/alice-checkout-fix`
- colliding slugged worktree paths fail explicitly instead of opening a different branch
- `.env` files from `apps/*/*/.env` in the primary checkout are symlinked into new worktrees
- automatic pruning removes clean managed and `$TMPDIR/opencode` worktrees plus unchecked-out local branches when no same-named `origin/*` branch exists
- automatic pruning also clears stale Git worktree records whose checkout paths no longer exist
- manual pruning closes its popup after confirmation and reports completion or failure through a Herdr notification

## Dependencies

Required commands: `git`, `python3`, `opencode`, `pnpm`, `zsh`, `nvim`, `lazygit`, and `fzf`.
Herdr installs the plugin repository but does not install system dependencies.

## New Machine Setup

```bash
herdr update
herdr integration install opencode
herdr plugin install swheel33/herdr-dev-workflow --yes
npx skills add ogulcancelik/herdr --skill herdr -g
herdr config check
herdr plugin action invoke wheels.dev-workflow.doctor
```

When a named Herdr session is active, set `HERDR_SESSION=<name>` for the Herdr
commands. Add the keybindings from `keybindings.example.toml` to
`~/.config/herdr/config.toml`, then run `herdr server reload-config` or restart
Herdr. Restart OpenCode separately so it loads the integration and skill.
