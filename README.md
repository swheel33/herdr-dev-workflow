# Wheels Dev Workflow

Portable Herdr plugin for personal git worktree workflows and development tools.

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
herdr plugin install swheel33/herdr-dev-workflow
```

When developing the plugin locally, link its checkout instead:

```bash
herdr plugin link /path/to/herdr-dev-workflow
```

Run the dependency check from Herdr's plugin action menu, or from the CLI:

```bash
herdr plugin action invoke wheels.dev-workflow.doctor
```

## Keybindings

- `prefix+l`: set up the two-pane dev layout in the current workspace
- `prefix+n`: prompt in a popup for a new `wheels/<name>` branch and worktree
- `prefix+o`: pick in a popup and open an existing managed worktree or `origin/*` branch
- `prefix+a`: open all managed worktrees
- `prefix+p`: automatically prune eligible managed worktrees
- `prefix+shift+p`: manually select and prune a managed worktree in a popup
- `prefix+g`: open `lazygit` in a popup
- `prefix+e`: open `nvim` in a temporary full overlay

Keybindings live in Herdr's global `config.toml` and invoke portable plugin actions.
The plugin itself contains no user-specific absolute paths.
See [`keybindings.example.toml`](keybindings.example.toml) for the complete binding block.

## Layout

- top pane: `opencode`
- bottom pane: shell, or `pnpm install` for newly created worktrees

## Worktree Conventions

- managed worktrees live under `<repo>/.worktrees`
- new personal branches are named `wheels/<slug>`
- new personal branches use `wheels/<slug>` locally and `.worktrees/<slug>` on disk
- origin branches keep the exact origin branch name locally and use a slugged worktree path
- selecting `origin/alice/checkout-fix` opens local branch `alice/checkout-fix` at `.worktrees/alice-checkout-fix`
- colliding slugged worktree paths fail explicitly instead of opening a different branch
- `.env` files from `apps/*/*/.env` in the primary checkout are symlinked into new worktrees
- automatic pruning only considers worktrees under `.worktrees`; unrelated local branches are never removed

## Dependencies

Required commands: `git`, `python3`, `opencode`, `pnpm`, `zsh`, `nvim`, `lazygit`, and `fzf`.
Herdr installs the plugin repository but does not install system dependencies.
