# Herdr Feature Workspaces

When `HERDR_ENV=1` and a request requires code changes:

- Treat repository detection as a prerequisite. Run `git rev-parse --show-toplevel` from the caller's current directory before planning a workspace. If it fails, do not create a Herdr workspace or treat the home or root directory as a project; ask the user for the intended repository path.
- Before `herdr worktree create`, verify the proposed repository root contains a valid `.git` worktree: `test -e "$repo_root/.git"`, `git -C "$repo_root" rev-parse --is-inside-work-tree` must return `true`, and `git -C "$repo_root" rev-parse --show-toplevel` must resolve to `$repo_root`. If validation fails, ask the user for the correct repository path instead of creating a workspace.
- Do not create worktrees for questions, planning, exploration, reviews, or Git-only publication.
- If already delegated into the worktree for this exact task, work there directly and do not delegate again.
- Otherwise, do not edit the originating checkout. Create a sibling worktree under the primary repository's `.worktrees` directory.
- Run `git -C "$repo_root" fetch origin --prune` before selecting a base or creating a branch.
- Use `wheels/<slug>` for the branch and `.worktrees/<slug>` for the path.
- For work related to the current feature branch, use that branch as the base. Otherwise prefer `origin/develop`, then the remote default branch. Do not switch the originating checkout to the base branch; `--base` creates the new branch from that ref even when the ref is checked out in another worktree.
- Create the workspace with `herdr worktree create --cwd "$repo_root" --branch "wheels/$slug" --base "$base_ref" --path "$repo_root/.worktrees/$slug" --label "$slug" --focus --json`. Always pass the primary repository root through `--cwd`; relying on the process working directory can make Herdr treat a linked worktree as the source.
- Split the returned `root_pane.pane_id` downward at `0.70` with `herdr pane split <root-pane-id> --direction down --ratio 0.70 --cwd "$worktree_path" --no-focus`. The original root pane must remain focused, occupy the upper 70%, and host the only agent. Leave the new lower pane as an unused interactive shell.
- Start exactly one named OpenCode agent in the original root pane and send it the complete request. Submit the prompt without `--wait`, then return control immediately. Do not repeatedly poll, wait for completion, inspect the delegated work, or perform the task locally in the same turn.
- Coordinate the delegated agent asynchronously. Never use blocking agent waits such as `herdr agent prompt --wait`, `herdr agent wait`, or `herdr pane wait-output`. Resume coordination after an asynchronous completion notification or a new user request. Do not duplicate its work, close the originating workspace, or automatically prune the new workspace.
- If workspace creation or the delegated agent fails, is blocked, becomes overloaded, or exits, report the error. Do not edit the originating checkout, start a replacement agent, move the agent, or use the lower pane for an agent.

Repository `AGENTS.md` files remain authoritative for implementation, validation, commits, and pushes.
