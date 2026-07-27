# Herdr Feature Workspaces

When `HERDR_ENV=1` and a request requires code changes:

- Do not create worktrees for questions, planning, exploration, reviews, or Git-only publication.
- If already delegated into the worktree for this exact task, work there directly and do not delegate again.
- Otherwise, do not edit the originating checkout. Create a sibling worktree under the primary repository's `.worktrees` directory.
- Run `git -C "$repo_root" fetch origin --prune` before selecting a base or creating a branch.
- Use `wheels/<slug>` for the branch and `.worktrees/<slug>` for the path.
- For work related to the current feature branch, use that branch as the base. Otherwise prefer `origin/develop`, then the remote default branch.
- Use `herdr worktree create --focus --json`, split the returned root pane downward at `0.70` without changing focus, start a named OpenCode agent in the focused root pane, and send it the complete request.
- Wait for and coordinate the delegated agent. Do not duplicate its work, close the originating workspace, or automatically prune the new workspace.
- If creation fails, report the error instead of editing the originating checkout.

Repository `AGENTS.md` files remain authoritative for implementation, validation, commits, and pushes.
