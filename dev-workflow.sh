#!/bin/bash

set -euo pipefail

HERDR_BIN="${HERDR_BIN_PATH:-herdr}"
PLUGIN_ID="${HERDR_PLUGIN_ID:-wheels.dev-workflow}"

usage() {
  printf 'Usage: dev-workflow.sh <layout-here|open-pane|open-all|prune-auto|new-branch-pane|open-pane-entry|prune-pane|doctor>\n' >&2
  exit 1
}

doctor() {
  local command missing=0
  local required=(git python3 opencode pnpm zsh nvim lazygit fzf)

  printf 'Wheels Dev Workflow dependency check\n\n'
  printf 'Herdr: %s\n' "$HERDR_BIN"
  for command in "${required[@]}"; do
    if command -v "$command" >/dev/null 2>&1; then
      printf '  ok       %-10s %s\n' "$command" "$(command -v "$command")"
    else
      printf '  missing  %s\n' "$command"
      if [[ "$command" == "fzf" ]]; then
        printf '           install with `brew install fzf` on macOS or your Linux package manager\n'
      fi
      missing=1
    fi
  done

  printf '\n'
  if [[ "$missing" == "0" ]]; then
    printf 'All required dependencies are available.\n'
  else
    printf 'Install the missing dependencies before using every workflow action.\n'
  fi
  printf '\nPress enter to close...'
  IFS= read -r _
  return "$missing"
}

slugify() {
  local value="$1"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  value="${value// /-}"
  value="${value//[^a-z0-9._-]/-}"
  while [[ "$value" == *--* ]]; do
    value="${value//--/-}"
  done
  value="${value#-}"
  value="${value%-}"
  printf '%s' "$value"
}

json_field() {
  local field="$1"
  python3 -c '
import json
import sys

field = sys.argv[1]
data = json.load(sys.stdin)

def walk(value):
    if isinstance(value, dict):
        if field in value and value[field] is not None:
            print(value[field])
            raise SystemExit(0)
        for child in value.values():
            walk(child)
    elif isinstance(value, list):
        for child in value:
            walk(child)

walk(data)
raise SystemExit(1)
' "$field"
}

repo_root_or_die() {
  local common_dir
  common_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || {
    printf 'dev workflow must be run inside a git repository\n' >&2
    exit 1
  }
  dirname "$common_dir"
}

current_checkout_root_or_die() {
  git rev-parse --path-format=absolute --show-toplevel 2>/dev/null || {
    printf 'dev workflow must be run inside a git repository\n' >&2
    exit 1
  }
}

managed_worktree_root() {
  local repo_root="$1"
  printf '%s/.worktrees' "$repo_root"
}

managed_worktree_path() {
  local repo_root="$1"
  local name="$2"
  printf '%s/%s' "$(managed_worktree_root "$repo_root")" "$name"
}

managed_branch_name() {
  local name="$1"
  printf 'wheels/%s' "$name"
}

path_contains() {
  local parent="$1"
  local child="$2"
  [[ "$child" == "$parent" || "$child" == "$parent"/* ]]
}

default_branch() {
  local repo_root="$1"
  local ref
  ref="$(git -C "$repo_root" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [[ -n "$ref" ]]; then
    printf '%s' "${ref#refs/remotes/origin/}"
    return
  fi
  if git -C "$repo_root" show-ref --verify --quiet refs/heads/main; then
    printf 'main'
    return
  fi
  if git -C "$repo_root" show-ref --verify --quiet refs/heads/master; then
    printf 'master'
    return
  fi
  git -C "$repo_root" branch --show-current
}

worktree_base_ref() {
  local repo_root="$1"
  local branch_name="$2"
  if git -C "$repo_root" show-ref --verify --quiet "refs/remotes/origin/${branch_name}"; then
    printf '%s' "origin/${branch_name}"
  else
    printf '%s' "$branch_name"
  fi
}

preferred_base_branch() {
  local repo_root="$1"
  if git -C "$repo_root" show-ref --verify --quiet refs/remotes/origin/develop ||
    git -C "$repo_root" show-ref --verify --quiet refs/heads/develop; then
    printf 'develop'
    return
  fi
  default_branch "$repo_root"
}

refresh_origin_refs() {
  local repo_root="$1"
  git -C "$repo_root" fetch origin --prune
}

list_worktrees_porcelain() {
  local repo_root="$1"
  git -C "$repo_root" worktree list --porcelain
}

is_managed_worktree_path() {
  local repo_root="$1"
  local path="$2"
  [[ "$path" == "$(managed_worktree_root "$repo_root")"/* ]]
}

primary_worktree_path() {
  local repo_root="$1"
  local line path fallback=""
  while IFS= read -r line; do
    case "$line" in
      worktree\ *)
        path="${line#worktree }"
        if [[ -z "$fallback" ]]; then
          fallback="$path"
        fi
        if ! is_managed_worktree_path "$repo_root" "$path"; then
          printf '%s' "$path"
          return
        fi
        ;;
    esac
  done < <(list_worktrees_porcelain "$repo_root")
  printf '%s' "$fallback"
}

symlink_if_missing() {
  local source_path="$1"
  local target_path="$2"
  if [[ ! -e "$source_path" || -e "$target_path" || -L "$target_path" ]]; then
    return
  fi
  mkdir -p "$(dirname "$target_path")"
  ln -s "$source_path" "$target_path"
  printf 'Linked %s -> %s\n' "$target_path" "$source_path"
}

bootstrap_worktree_local_files() {
  local repo_root="$1"
  local tree_path="$2"
  local source_root env_path relative_path
  source_root="$(primary_worktree_path "$repo_root")"
  if [[ -z "$source_root" || "$source_root" == "$tree_path" ]]; then
    return
  fi
  while IFS= read -r env_path; do
    [[ -n "$env_path" ]] || continue
    relative_path="${env_path#"$source_root"/}"
    symlink_if_missing "$env_path" "$tree_path/$relative_path"
  done < <(find "$source_root/apps" -mindepth 2 -maxdepth 2 -type f -name '.env' 2>/dev/null | sort)
}

first_pane_for_workspace() {
  local workspace_id="$1"
  "$HERDR_BIN" pane list --workspace "$workspace_id" | python3 -c '
import json
import sys

data = json.load(sys.stdin)
panes = data.get("result", {}).get("panes", [])
focused = next((pane for pane in panes if pane.get("focused")), None)
pane = focused or (panes[0] if panes else None)
if not pane:
    raise SystemExit(1)
print(pane["pane_id"])
'
}

workspace_pane_count() {
  local workspace_id="$1"
  "$HERDR_BIN" pane list --workspace "$workspace_id" | python3 -c '
import json
import sys

data = json.load(sys.stdin)
print(len(data.get("result", {}).get("panes", [])))
'
}

open_workspace_for_path() {
  local repo_root="$1"
  local tree_path="$2"
  local label="$3"
  local output workspace_id
  output="$("$HERDR_BIN" worktree open --cwd "$repo_root" --path "$tree_path" --label "$label" --focus --json)"
  workspace_id="$(printf '%s' "$output" | json_field workspace_id)"
  printf '%s' "$workspace_id"
}

setup_layout_for_workspace() {
  local workspace_id="$1"
  local directory="$2"
  local label="$3"
  local run_install="${4:-0}"
  local root_pane pane_count shell_json shell_pane directory_quoted

  pane_count="$(workspace_pane_count "$workspace_id")"
  if [[ "$pane_count" -gt 1 ]]; then
    "$HERDR_BIN" workspace focus "$workspace_id" >/dev/null
    return
  fi

  root_pane="$(first_pane_for_workspace "$workspace_id")"

  shell_json="$("$HERDR_BIN" pane split "$root_pane" --direction down --ratio 0.70 --cwd "$directory" --no-focus)"
  shell_pane="$(printf '%s' "$shell_json" | json_field pane_id)"
  printf -v directory_quoted '%q' "$directory"

  "$HERDR_BIN" pane run "$root_pane" "cd -- $directory_quoted && opencode" >/dev/null
  if [[ "$run_install" == "1" ]]; then
    "$HERDR_BIN" pane run "$shell_pane" "zsh -lic 'cd -- \"\$1\" && pnpm install' zsh $directory_quoted" >/dev/null
  else
    "$HERDR_BIN" pane run "$shell_pane" "cd -- $directory_quoted && clear" >/dev/null
  fi
  "$HERDR_BIN" workspace focus "$workspace_id" >/dev/null
}

target_directory_for_new_worktree() {
  local checkout_root="$1"
  local tree_path="$2"
  local relative_path target_directory
  target_directory="$tree_path"
  if path_contains "$checkout_root" "$PWD"; then
    relative_path="${PWD#"$checkout_root"}"
    relative_path="${relative_path#/}"
    if [[ -n "$relative_path" && -d "$tree_path/$relative_path" ]]; then
      target_directory="$tree_path/$relative_path"
    fi
  fi
  printf '%s' "$target_directory"
}

open_worktree_path_with_layout() {
  local repo_root="$1"
  local tree_path="$2"
  local label="$3"
  local run_install="${4:-0}"
  local workspace_id
  workspace_id="$(open_workspace_for_path "$repo_root" "$tree_path" "$label")"
  setup_layout_for_workspace "$workspace_id" "$tree_path" "$label" "$run_install"
}

create_personal_worktree() {
  local requested_name="$1"
  local repo_root checkout_root branch_suffix branch_name tree_name tree_path base_branch base_ref target_directory workspace_id
  repo_root="$(repo_root_or_die)"
  checkout_root="$(current_checkout_root_or_die)"
  branch_suffix="$(slugify "$requested_name")"
  if [[ -z "$branch_suffix" ]]; then
    printf 'Invalid worktree name: %s\n' "$requested_name" >&2
    exit 1
  fi
  branch_name="$(managed_branch_name "$branch_suffix")"
  tree_name="$branch_suffix"
  tree_path="$(managed_worktree_path "$repo_root" "$tree_name")"

  if [[ -e "$tree_path" ]]; then
    printf 'Worktree already exists: %s\n' "$tree_path" >&2
    exit 1
  fi
  if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch_name"; then
    printf 'Branch already exists: %s\n' "$branch_name" >&2
    exit 1
  fi

  refresh_origin_refs "$repo_root"
  if git -C "$repo_root" show-ref --verify --quiet "refs/remotes/origin/$branch_name"; then
    printf 'Remote branch already exists: origin/%s\n' "$branch_name" >&2
    exit 1
  fi

  base_branch="$(select_base_branch "$repo_root")" || exit 0
  base_ref="$(worktree_base_ref "$repo_root" "$base_branch")"
  if ! git -C "$repo_root" rev-parse --verify --quiet "${base_ref}^{commit}" >/dev/null; then
    printf 'Base branch not found: %s\n' "$base_ref" >&2
    exit 1
  fi
  printf 'Creating %s from %s...\n' "$branch_name" "$base_ref"
  mkdir -p "$(managed_worktree_root "$repo_root")"
  git -C "$repo_root" worktree add -b "$branch_name" "$tree_path" "$base_ref"
  bootstrap_worktree_local_files "$repo_root" "$tree_path"
  target_directory="$(target_directory_for_new_worktree "$checkout_root" "$tree_path")"
  workspace_id="$(open_workspace_for_path "$repo_root" "$tree_path" "$tree_name")"
  setup_layout_for_workspace "$workspace_id" "$target_directory" "$tree_name" 1
}

open_existing_worktree() {
  local repo_root="$1"
  local tree_path="$2"
  local label="$3"
  if [[ ! -d "$tree_path" ]]; then
    printf 'Worktree not found: %s\n' "$tree_path" >&2
    exit 1
  fi
  open_worktree_path_with_layout "$repo_root" "$tree_path" "$label" 0
}

worktree_path_for_branch() {
  local repo_root="$1"
  local branch_name="$2"
  local line path=""
  while IFS= read -r line; do
    case "$line" in
      worktree\ *) path="${line#worktree }" ;;
      "branch refs/heads/${branch_name}")
        printf '%s' "$path"
        return 0
        ;;
    esac
  done < <(list_worktrees_porcelain "$repo_root")
  return 1
}

origin_branch_tree_name() {
  local branch="$1"
  slugify "$branch"
}

open_origin_branch() {
  local remote_branch="$1"
  local repo_root tree_name tree_path upstream_ref checked_out_branch existing_path
  repo_root="$(repo_root_or_die)"
  remote_branch="${remote_branch#origin/}"
  if [[ -z "$remote_branch" || "$remote_branch" == HEAD ]]; then
    printf 'Invalid origin branch: %s\n' "$remote_branch" >&2
    exit 1
  fi
  upstream_ref="origin/$remote_branch"
  tree_name="$(origin_branch_tree_name "$remote_branch")"
  tree_path="$(managed_worktree_path "$repo_root" "$tree_name")"

  if ! git -C "$repo_root" rev-parse --verify --quiet "$upstream_ref^{commit}" >/dev/null; then
    printf 'Remote branch not found: %s\n' "$upstream_ref" >&2
    exit 1
  fi

  existing_path="$(worktree_path_for_branch "$repo_root" "$remote_branch" || true)"
  if [[ -n "$existing_path" ]]; then
    open_existing_worktree "$repo_root" "$existing_path" "$(basename "$existing_path")"
    return
  fi

  if [[ ! -d "$tree_path" ]]; then
    mkdir -p "$(managed_worktree_root "$repo_root")"
    if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$remote_branch"; then
      git -C "$repo_root" worktree add "$tree_path" "$remote_branch"
    else
      git -C "$repo_root" worktree add -b "$remote_branch" "$tree_path" "$upstream_ref"
      git -C "$tree_path" branch --set-upstream-to="$upstream_ref" "$remote_branch" >/dev/null 2>&1 || true
    fi
    bootstrap_worktree_local_files "$repo_root" "$tree_path"
  else
    checked_out_branch="$(git -C "$tree_path" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
    if [[ "$checked_out_branch" != "$remote_branch" ]]; then
      printf 'Worktree path collision: %s contains %s, expected %s\n' \
        "$tree_path" "${checked_out_branch:-a non-branch checkout}" "$remote_branch" >&2
      exit 1
    fi
  fi

  open_worktree_path_with_layout "$repo_root" "$tree_path" "$tree_name" 1
}

managed_worktree_rows() {
  local repo_root="$1"
  local line path branch name
  while IFS= read -r line; do
    if [[ "$line" == worktree\ * ]]; then
      path="${line#worktree }"
      if ! is_managed_worktree_path "$repo_root" "$path"; then
        continue
      fi
      name="$(basename "$path")"
      branch="$(git -C "$path" symbolic-ref --quiet --short HEAD 2>/dev/null || printf 'detached')"
      printf 'worktree\t%s\t%s\t%s\n' "$name" "$branch" "$path"
    fi
  done < <(list_worktrees_porcelain "$repo_root")
}

openable_worktree_rows() {
  local repo_root="$1"
  local line path branch name
  while IFS= read -r line; do
    if [[ "$line" == worktree\ * ]]; then
      path="${line#worktree }"
      name="$(basename "$path")"
      branch="$(git -C "$path" symbolic-ref --quiet --short HEAD 2>/dev/null || printf 'detached')"
      printf 'worktree\t%s\t%s\t%s\n' "$name" "$branch" "$path"
    fi
  done < <(list_worktrees_porcelain "$repo_root")
}

select_with_fzf() {
  local prompt="$1"
  if ! command -v fzf >/dev/null 2>&1; then
    printf 'fzf is required for interactive workflow menus. Install it with `brew install fzf` on macOS or your Linux package manager.\n' >&2
    return 127
  fi
  fzf --prompt "$prompt" --height 90% --reverse
}

base_branch_row() {
  local repo_root="$1"
  local branch="$2"
  local marker="${3:-}"
  local ref source date subject
  ref="$(worktree_base_ref "$repo_root" "$branch")"
  if [[ "$ref" == origin/* ]]; then
    source='origin'
  else
    source='local'
  fi
  if [[ -n "$marker" ]]; then
    source="${marker}/${source}"
  fi
  date="$(git -C "$repo_root" log -1 --format='%cr' "$ref" 2>/dev/null || true)"
  subject="$(git -C "$repo_root" log -1 --format='%s' "$ref" 2>/dev/null || true)"
  printf '%s\t%s\t%s\t%s\n' "$branch" "$source" "$date" "$subject"
}

base_branch_rows() {
  local repo_root="$1"
  local preferred="$2"
  local ref branch

  base_branch_row "$repo_root" "$preferred" default

  while IFS= read -r ref; do
    [[ "$ref" == origin/HEAD ]] && continue
    branch="${ref#origin/}"
    [[ "$branch" == "$preferred" ]] && continue
    base_branch_row "$repo_root" "$branch"
  done < <(git -C "$repo_root" for-each-ref --sort=-committerdate --format='%(refname:short)' refs/remotes/origin)

  while IFS= read -r branch; do
    [[ "$branch" == "$preferred" ]] && continue
    if git -C "$repo_root" show-ref --verify --quiet "refs/remotes/origin/${branch}"; then
      continue
    fi
    base_branch_row "$repo_root" "$branch"
  done < <(git -C "$repo_root" for-each-ref --sort=-committerdate --format='%(refname:short)' refs/heads)
}

select_base_branch() {
  local repo_root="$1"
  local preferred selected
  preferred="$(preferred_base_branch "$repo_root")"
  if [[ -z "$preferred" ]]; then
    printf 'Could not determine a base branch for %s\n' "$repo_root" >&2
    return 1
  fi
  selected="$(base_branch_rows "$repo_root" "$preferred" | select_with_fzf "base (${preferred})> ")" || return 1
  selected="${selected%%$'\t'*}"
  [[ -n "$selected" ]] || return 1
  printf '%s' "$selected"
}

new_branch_pane() {
  local name
  if ! IFS= read -er -p 'New branch name: ' name; then
    exit 0
  fi
  [[ -n "$name" ]] || exit 0
  create_personal_worktree "$name"
}

origin_branch_rows() {
  local repo_root="$1"
  local line ref branch date author subject checked
  local checked_branches=()
  while IFS= read -r line; do
    if [[ "$line" == branch\ refs/heads/* ]]; then
      checked_branches+=("${line#branch refs/heads/}")
    fi
  done < <(list_worktrees_porcelain "$repo_root")

  while IFS=$'\t' read -r ref date author subject; do
    [[ "$ref" == origin || "$ref" == origin/HEAD ]] && continue
    branch="${ref#origin/}"
    for checked in "${checked_branches[@]}"; do
      [[ "$branch" == "$checked" ]] && continue 2
    done
    printf 'origin\t%s\t%s\t%s\t%s\n' "$ref" "$date" "$author" "$subject"
  done < <(
    git -C "$repo_root" for-each-ref \
      --sort=-committerdate \
      --format='%(refname:short)%09%(committerdate:relative)%09%(authorname)%09%(subject)' \
      refs/remotes/origin
  )
}

open_pane_entry() {
  local repo_root selected kind branch name tree_path
  repo_root="$(repo_root_or_die)"
  printf 'Fetching origin...\n'
  refresh_origin_refs "$repo_root"
  selected="$(
    {
      openable_worktree_rows "$repo_root"
      origin_branch_rows "$repo_root"
    } | select_with_fzf 'open> '
  )" || exit 0

  kind="${selected%%$'\t'*}"
  selected="${selected#*$'\t'}"

  case "$kind" in
    worktree)
      name="${selected%%$'\t'*}"
      selected="${selected#*$'\t'}"
      branch="${selected%%$'\t'*}"
      tree_path="${selected#*$'\t'}"
      [[ -n "$name" && -n "$branch" && -n "$tree_path" ]] || exit 0
      open_existing_worktree "$repo_root" "$tree_path" "$name"
      ;;
    origin)
      branch="${selected%%$'\t'*}"
      [[ -n "$branch" ]] || exit 0
      open_origin_branch "$branch"
      ;;
    *)
      printf 'Unknown selection type: %s\n' "$kind" >&2
      exit 1
      ;;
  esac
}

pause_on_error() {
  local status="$1"
  trap - EXIT
  if [[ "$status" != "0" && "$status" != "130" ]]; then
    printf '\nWorkflow failed (exit %s). Press enter to close...' "$status" >&2
    IFS= read -r _ || true
  fi
  exit "$status"
}

open_all() {
  local cwd repo_root selected kind name tree_path workspace_id
  local total=0 opened=0 already_open=0
  local target_workspace=""

  cwd="$(pane_cwd_or_die)"
  cd "$cwd"
  repo_root="$(repo_root_or_die)"

  while IFS= read -r selected; do
    [[ -n "$selected" ]] || continue
    kind="${selected%%$'\t'*}"
    selected="${selected#*$'\t'}"
    [[ "$kind" == "worktree" ]] || continue

    total=$((total + 1))
    name="${selected%%$'\t'*}"
    tree_path="$(managed_worktree_path "$repo_root" "$name")"
    workspace_id="$(open_workspace_for_path "$repo_root" "$tree_path" "$name")"

    if [[ -z "$target_workspace" ]]; then
      target_workspace="$workspace_id"
    fi

    if [[ "$(workspace_pane_count "$workspace_id")" -gt 1 ]]; then
      already_open=$((already_open + 1))
      printf 'Already open: %s\n' "$name"
      continue
    fi

    setup_layout_for_workspace "$workspace_id" "$tree_path" "$name" 0
    opened=$((opened + 1))
    printf 'Opened: %s\n' "$name"
  done < <(managed_worktree_rows "$repo_root")

  if [[ "$total" -eq 0 ]]; then
    printf 'No managed worktrees found under %s\n' "$(managed_worktree_root "$repo_root")" >&2
    notify "No managed worktrees" "No managed worktrees found."
    exit 1
  fi

  if [[ -n "$target_workspace" ]]; then
    "$HERDR_BIN" workspace focus "$target_workspace" >/dev/null
  fi

  local summary
  summary="Opened $opened managed worktree(s); $already_open already open."
  printf '%s\n' "$summary"
  notify "Open all complete" "$summary"
}

worktree_dirty() {
  local path="$1"
  [[ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]]
}

remote_branch_exists() {
  local repo_root="$1"
  local branch_name="$2"
  git -C "$repo_root" show-ref --verify --quiet "refs/remotes/origin/$branch_name"
}

default_branch_names() {
  local repo_root="$1"
  local branch
  branch="$(default_branch "$repo_root")"
  [[ -n "$branch" ]] && printf '%s\n' "$branch"
  printf 'main\nmaster\n'
}

branch_is_protected() {
  local repo_root="$1"
  local branch_name="$2"
  local protected primary_path primary_branch
  primary_path="$(primary_worktree_path "$repo_root")"
  primary_branch="$(git -C "$primary_path" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [[ "$branch_name" == "$primary_branch" ]]; then
    return 0
  fi
  while IFS= read -r protected; do
    [[ -n "$protected" ]] || continue
    if [[ "$branch_name" == "$protected" ]]; then
      return 0
    fi
  done < <(default_branch_names "$repo_root" | sort -u)
  return 1
}

prune_branch() {
  local repo_root="$1"
  local branch_name="$2"
  local tree_path="${3:-}"

  if [[ -n "$tree_path" ]]; then
    close_workspace_for_path "$tree_path"
    git -C "$repo_root" worktree remove "$tree_path"
  fi
  if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch_name"; then
    git -C "$repo_root" branch -D "$branch_name" >/dev/null
  fi
}

close_workspace_for_path() {
  local target_path="$1"
  "$HERDR_BIN" worktree list --cwd "$target_path" --json 2>/dev/null | python3 -c '
import json
import sys

target = sys.argv[1]
try:
    data = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
for worktree in data.get("result", {}).get("worktrees", []):
    path = worktree.get("path", "")
    workspace_id = worktree.get("open_workspace_id")
    if workspace_id and (path == target or path.startswith(target.rstrip("/") + "/")):
        print(workspace_id)
' "$target_path" | while IFS= read -r workspace_id; do
    "$HERDR_BIN" workspace close "$workspace_id" >/dev/null 2>&1 || true
  done
}

prune_selected_worktree() {
  local repo_root="$1"
  local name="$2"
  local force="${3:-0}"
  local tree_path branch_name reason
  tree_path="$(managed_worktree_path "$repo_root" "$name")"
  branch_name="$(git -C "$tree_path" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [[ ! -d "$tree_path" || -z "$branch_name" ]]; then
    printf 'Worktree not found or detached: %s\n' "$name" >&2
    return 1
  fi
  if worktree_dirty "$tree_path" && [[ "$force" != "1" ]]; then
    printf 'Skipping dirty worktree: %s (use force mode to remove)\n' "$name" >&2
    return 1
  fi
  if [[ "$force" != "1" ]]; then
    if remote_branch_exists "$repo_root" "$branch_name"; then
      printf 'Skipping %s: remote branch still exists\n' "$name" >&2
      return 1
    fi
    reason='no matching remote branch'
  else
    reason='forced'
  fi

  close_workspace_for_path "$tree_path"
  if [[ "$force" == "1" ]]; then
    git -C "$repo_root" worktree remove --force "$tree_path"
    git -C "$repo_root" branch -D "$branch_name" >/dev/null
  else
    prune_branch "$repo_root" "$branch_name" "$tree_path"
  fi
  printf 'Pruned %s (%s)\n' "$name" "$reason"
}

notify() {
  local title="$1"
  local body="${2:-}"
  "$HERDR_BIN" notification show "$title" --body "$body" --sound none >/dev/null 2>&1 || true
}

prune_auto() {
  local cwd repo_root kind name branch_name tree_path index
  local source_workspace_id="${HERDR_WORKSPACE_ID:-}" source_is_pruned=0
  local total=0 pruned_branches=0 pruned_worktrees=0 skipped_dirty=0 skipped_remote=0 skipped_protected=0 skipped_other=0
  local prune_names=() prune_branches=() prune_paths=() close_pids=() remove_pids=()

  cwd="$(pane_cwd_or_die)"
  cd "$cwd"
  repo_root="$(repo_root_or_die)"

  notify "Pruning worktrees..." "Fetching origin and checking managed worktrees."
  printf 'Fetching origin...\n'
  refresh_origin_refs "$repo_root"

  while IFS=$'\t' read -r kind name branch_name tree_path; do
    [[ "$kind" == "worktree" && -n "$tree_path" ]] || continue
    total=$((total + 1))

    if [[ -z "$branch_name" || "$branch_name" == "detached" ]]; then
      skipped_other=$((skipped_other + 1))
      printf 'Skipping %s: detached worktree\n' "$name"
      continue
    fi

    if branch_is_protected "$repo_root" "$branch_name"; then
      skipped_protected=$((skipped_protected + 1))
      printf 'Skipping %s: protected branch\n' "$branch_name"
      continue
    fi

    if remote_branch_exists "$repo_root" "$branch_name"; then
      skipped_remote=$((skipped_remote + 1))
      printf 'Skipping %s: remote branch exists\n' "$branch_name"
      continue
    fi

    if [[ ! -d "$tree_path" ]]; then
      skipped_other=$((skipped_other + 1))
      printf 'Skipping %s: worktree path missing (%s)\n' "$branch_name" "$tree_path"
      continue
    fi

    if worktree_dirty "$tree_path"; then
      skipped_dirty=$((skipped_dirty + 1))
      printf 'Skipping %s: dirty worktree (%s)\n' "$branch_name" "$tree_path"
      continue
    fi

    prune_names+=("$name")
    prune_branches+=("$branch_name")
    prune_paths+=("$tree_path")
    if path_contains "$tree_path" "$cwd"; then
      source_is_pruned=1
    fi
  done < <(managed_worktree_rows "$repo_root")

  for index in "${!prune_paths[@]}"; do
    close_workspace_for_path "${prune_paths[$index]}" &
    close_pids[$index]=$!
  done
  for index in "${!close_pids[@]}"; do
    wait "${close_pids[$index]}" || true
  done

  if [[ -n "$source_workspace_id" && "$source_is_pruned" == "0" && "${#prune_paths[@]}" -gt 0 ]]; then
    "$HERDR_BIN" workspace focus "$source_workspace_id" >/dev/null 2>&1 || true
  fi

  for index in "${!prune_paths[@]}"; do
    printf 'Pruning worktree %s (%s)...\n' "${prune_names[$index]}" "${prune_branches[$index]}"
    git -C "$repo_root" worktree remove "${prune_paths[$index]}" &
    remove_pids[$index]=$!
  done

  for index in "${!remove_pids[@]}"; do
    name="${prune_names[$index]}"
    branch_name="${prune_branches[$index]}"
    tree_path="${prune_paths[$index]}"
    if ! wait "${remove_pids[$index]}"; then
      skipped_other=$((skipped_other + 1))
      printf 'Failed to prune worktree %s (%s)\n' "$name" "$tree_path" >&2
      continue
    fi

    pruned_worktrees=$((pruned_worktrees + 1))
    if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch_name"; then
      if ! git -C "$repo_root" branch -D "$branch_name" >/dev/null; then
        skipped_other=$((skipped_other + 1))
        printf 'Removed worktree %s but failed to delete branch %s\n' "$name" "$branch_name" >&2
        continue
      fi
    fi

    pruned_branches=$((pruned_branches + 1))
    printf 'Pruned worktree %s and branch %s (no matching remote branch)\n' "$name" "$branch_name"
  done

  local summary
  summary="Pruned $pruned_branches of $total managed worktrees; removed $pruned_worktrees worktrees; skipped $skipped_dirty dirty, $skipped_remote with remote, $skipped_protected protected, $skipped_other other."
  printf '%s\n' "$summary"
  notify "Prune complete" "$summary"
}

prune_pane() {
  local repo_root selected name answer force=0
  repo_root="$(repo_root_or_die)"
  printf 'Fetching origin...\n'
  refresh_origin_refs "$repo_root"
  selected="$(managed_worktree_rows "$repo_root" | select_with_fzf 'prune> ')" || exit 0
  selected="${selected#*$'\t'}"
  name="${selected%%$'\t'*}"
  [[ -n "$name" ]] || exit 0
  printf 'Prune %s? [y/N] ' "$name"
  IFS= read -r answer
  [[ "$answer" == y || "$answer" == Y ]] || exit 0
  printf 'Force if dirty/remote branch still exists? [y/N] '
  IFS= read -r answer
  if [[ "$answer" == y || "$answer" == Y ]]; then
    force=1
  fi
  prune_selected_worktree "$repo_root" "$name" "$force"
  printf '\nPress enter to close...'
  IFS= read -r _
}

layout_here() {
  local pane_id workspace_id directory label
  pane_id="${HERDR_PANE_ID:-}"
  workspace_id="${HERDR_WORKSPACE_ID:-}"
  directory="$(pane_cwd_or_die)"
  label="$(basename "$directory")"
  if [[ -z "$workspace_id" ]]; then
    printf 'Missing HERDR_WORKSPACE_ID; invoke this through a Herdr plugin action.\n' >&2
    exit 1
  fi
  setup_layout_for_workspace "$workspace_id" "$directory" "$label" 0
  if [[ -n "$pane_id" ]]; then
    "$HERDR_BIN" workspace focus "$workspace_id" >/dev/null 2>&1 || true
  fi
}

pane_cwd_or_die() {
  local pane_id="${HERDR_PANE_ID:-}"
  if [[ -z "$pane_id" ]]; then
    printf 'Missing HERDR_PANE_ID; invoke this through a Herdr plugin action.\n' >&2
    exit 1
  fi

  "$HERDR_BIN" pane get "$pane_id" | python3 -c '
import json
import sys

try:
    data = json.load(sys.stdin)
except Exception as exc:
    print(f"Invalid pane JSON: {exc}", file=sys.stderr)
    raise SystemExit(1)

pane = data.get("result", {}).get("pane", {})
cwd = pane.get("foreground_cwd") or pane.get("cwd")
if cwd:
    print(cwd)
    raise SystemExit(0)

print("Missing foreground_cwd/cwd in pane info", file=sys.stderr)
raise SystemExit(1)
'
}

open_plugin_pane() {
  local entrypoint="${1:-}"
  local cwd
  [[ -n "$entrypoint" ]] || usage
  cwd="$(pane_cwd_or_die)"
  "$HERDR_BIN" plugin pane open --plugin "$PLUGIN_ID" --entrypoint "$entrypoint" --cwd "$cwd" --focus >/dev/null
}

main() {
  local command="${1:-}"
  shift || true
  case "$command" in
    layout-here) layout_here "$@" ;;
    open-pane) open_plugin_pane "$@" ;;
    open-all) open_all "$@" ;;
    prune-auto) prune_auto "$@" ;;
    new-branch-pane) new_branch_pane "$@" ;;
    open-pane-entry)
      trap 'pause_on_error "$?"' EXIT
      open_pane_entry "$@"
      ;;
    prune-pane) prune_pane "$@" ;;
    doctor) doctor "$@" ;;
    *) usage ;;
  esac
}

main "$@"
