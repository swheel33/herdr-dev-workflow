#!/usr/bin/env python3

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
import uuid

from lifecycle import atomic_json, canonical, known_roots, log_event, state_dir


class DispatchFailure(RuntimeError):
    pass


def run_command(command, *, check=True, input_text=None, cwd=None):
    log_event("dispatcher.command_started", command=command, cwd=cwd)
    try:
        result = subprocess.run(
            command,
            input=input_text,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=cwd,
        )
    except OSError as error:
        log_event("dispatcher.command_spawn_failed", command=command, error=str(error))
        raise DispatchFailure(f"{command[0]}: {error}") from error
    log_event(
        "dispatcher.command_finished",
        command=command,
        exit_code=result.returncode,
        stdout=result.stdout,
        stderr=result.stderr,
    )
    if check and result.returncode:
        detail = result.stderr.strip() or result.stdout.strip() or "no error output"
        raise DispatchFailure(
            f"Command failed ({result.returncode}): {' '.join(command)}\n{detail}"
        )
    return result


def git(path, *args, check=True):
    return run_command(["git", "-C", str(path), *args], check=check)


def herdr(*args, check=True):
    return run_command([os.environ.get("HERDR_BIN_PATH", "herdr"), *args], check=check)


def plugin_context():
    try:
        return json.loads(os.environ.get("HERDR_PLUGIN_CONTEXT_JSON", "{}"))
    except json.JSONDecodeError:
        return {}


def primary_repository(path):
    if not path:
        return None
    result = git(path, "rev-parse", "--path-format=absolute", "--git-common-dir", check=False)
    if result.returncode:
        return None
    common = canonical(result.stdout.strip())
    bare = git(path, "rev-parse", "--is-bare-repository", check=False)
    if bare.returncode == 0 and bare.stdout.strip() == "true":
        return common
    return canonical(Path(common).parent)


def current_project_root():
    context = plugin_context()
    candidates = [
        context.get("focused_pane_cwd"),
        context.get("workspace_cwd"),
        os.getcwd(),
    ]
    for candidate in candidates:
        root = primary_repository(candidate)
        if root:
            return root
    return None


def discover_project_roots(projects_root=None):
    projects = Path(projects_root or os.environ.get("HERDR_PROJECTS_ROOT", Path.home() / "Projects"))
    roots = set()
    if projects.is_dir():
        for directory, names, _files in os.walk(projects):
            names[:] = [name for name in names if name not in {".git", ".worktrees"}]
            current = Path(directory)
            if ".worktrees" in current.parts:
                names[:] = []
                continue
            if (current / ".git").exists():
                root = primary_repository(current)
                if root:
                    roots.add(root)
    for registered in known_roots():
        root = primary_repository(registered)
        if root and ".worktrees" not in Path(root).parts:
            roots.add(root)
    return sorted(roots, key=lambda value: (Path(value).name.lower(), value.lower()))


def pick_project(projects_root=None):
    roots = discover_project_roots(projects_root)
    if not roots:
        raise DispatchFailure("No Git repositories found in the plugin registry or ~/Projects")
    rows = "".join(f"{Path(root).name}\t{root}\n" for root in roots)
    result = run_command(
        ["fzf", "--prompt", "project> ", "--height", "100%", "--reverse", "--with-nth", "1,2"],
        check=False,
        input_text=rows,
    )
    if result.returncode in (1, 130):
        return None
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip() or "fzf failed"
        raise DispatchFailure(detail)
    selected = result.stdout.rstrip("\n").split("\t", 1)
    if len(selected) != 2 or selected[1] not in roots:
        raise DispatchFailure("Project picker returned an invalid repository")
    return selected[1]


def dispatcher_instruction_path():
    return canonical(Path(__file__).parent / "instructions" / "dispatcher.md")


def dispatcher_tracker_path():
    return canonical(Path(__file__).parent / "opencode" / "dispatcher-tracker.js")


def normal_tui_config():
    configured = os.environ.get("OPENCODE_TUI_CONFIG")
    if configured and Path(configured).is_file():
        return canonical(configured)
    xdg = os.environ.get("XDG_CONFIG_HOME")
    candidate = Path(xdg) / "opencode" / "tui.json" if xdg else Path.home() / ".config" / "opencode" / "tui.json"
    return canonical(candidate) if candidate.is_file() else None


def discussion_sessions_dir():
    return state_dir() / "discussion-sessions"


def discussion_links_dir():
    return state_dir() / "discussion-links"


def discussion_link_path(session_id):
    return discussion_links_dir() / f"{session_id}.json"


def load_discussions():
    records = {}
    for directory in (discussion_sessions_dir(), discussion_links_dir()):
        if not directory.exists():
            continue
        for path in sorted(directory.glob("*.json")):
            try:
                value = json.loads(path.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            session_id = value.get("session_id")
            if session_id:
                records.setdefault(session_id, {}).update(value)
    return list(records.values())


def save_discussion(session_id, **updates):
    path = discussion_link_path(session_id)
    lock_path = state_dir() / "locks" / f"discussion-write-{hashlib.sha256(session_id.encode()).hexdigest()[:24]}.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        current = {}
        if path.exists():
            try:
                current = json.loads(path.read_text())
            except (OSError, json.JSONDecodeError):
                pass
        current.update({"session_id": session_id, "updated_at": int(time.time() * 1000), **updates})
        atomic_json(path, current)
    return current


@contextlib.contextmanager
def dispatch_session_lock(session_id):
    identifier = hashlib.sha256(session_id.encode()).hexdigest()[:24]
    path = state_dir() / "locks" / f"dispatcher-session-{identifier}.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def active_session_id():
    instance = os.environ.get("HERDR_DISPATCHER_INSTANCE_ID")
    if instance:
        path = state_dir() / "dispatcher-instances" / f"{instance}.json"
        try:
            session_id = json.loads(path.read_text()).get("session_id")
            if session_id:
                return session_id
        except (OSError, json.JSONDecodeError):
            pass
    return os.environ.get("HERDR_DISPATCHER_SESSION_ID")


def dispatcher_environment(root, session_id=None):
    environment = os.environ.copy()
    config_home = Path(os.environ.get("HERDR_PLUGIN_STATE_DIR", Path.home() / ".local/state/herdr-dev-workflow")) / "dispatcher-config"
    config_home.mkdir(parents=True, exist_ok=True)
    environment["XDG_CONFIG_HOME"] = str(config_home)
    environment.pop("OPENCODE_CONFIG", None)
    environment.pop("OPENCODE_CONFIG_DIR", None)
    environment["HERDR_DISPATCHER"] = "1"
    environment["HERDR_DISPATCHER_PROJECT_ROOT"] = root
    environment["HERDR_DISPATCHER_INSTANCE_ID"] = uuid.uuid4().hex
    if session_id:
        environment["HERDR_DISPATCHER_SESSION_ID"] = session_id
    else:
        environment.pop("HERDR_DISPATCHER_SESSION_ID", None)
    tui_config = normal_tui_config()
    if tui_config:
        environment["OPENCODE_TUI_CONFIG"] = tui_config
    environment["OPENCODE_CONFIG_CONTENT"] = json.dumps(
        {
            "instructions": [dispatcher_instruction_path()],
            "plugin": [f"file://{dispatcher_tracker_path()}"],
        },
        separators=(",", ":"),
    )
    return environment


def launch_session(root, session_id=None, exec_fn=os.execvpe):
    root = canonical(root)
    arguments = ["opencode", root]
    if session_id:
        arguments.extend(("--session", session_id))
    log_event("dispatcher.session_launching", project_root=root, fresh=not bool(session_id), session_id=session_id)
    exec_fn("opencode", arguments, dispatcher_environment(root, session_id))


def launch_fresh_session(root, exec_fn=os.execvpe):
    launch_session(root, exec_fn=exec_fn)


def chat_current():
    root = current_project_root()
    if root is None:
        log_event("dispatcher.current_falling_back_to_picker")
        root = pick_project()
    if root:
        launch_fresh_session(root)
    return 0


def chat_picker():
    root = pick_project()
    if root:
        launch_fresh_session(root)
    return 0


def opencode_sessions(root):
    result = run_command(["opencode", "session", "list", "--format", "json"], cwd=root)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise DispatchFailure(f"Invalid OpenCode session list JSON: {error}") from error


def pick_discussion(root):
    root = canonical(root)
    tracked = {item.get("session_id"): item for item in load_discussions() if item.get("project_root") == root}
    sessions = [item for item in opencode_sessions(root) if item.get("id") in tracked]
    if not sessions:
        raise DispatchFailure(f"No previous dispatcher chats found for {root}")
    sessions.sort(key=lambda item: item.get("updated", 0), reverse=True)
    rows = []
    for session in sessions:
        link = tracked[session["id"]].get("active_task") or {}
        status = f" [{link.get('branch')}]" if link.get("branch") else ""
        rows.append(f"{session.get('title') or 'Untitled'}{status}\t{session['id']}\n")
    result = run_command(
        ["fzf", "--prompt", "chat> ", "--height", "100%", "--reverse", "--with-nth", "1"],
        check=False,
        input_text="".join(rows),
    )
    if result.returncode in (1, 130):
        return None
    if result.returncode:
        raise DispatchFailure(result.stderr.strip() or "Chat picker failed")
    selected = result.stdout.rstrip("\n").rsplit("\t", 1)
    if len(selected) != 2 or selected[1] not in tracked:
        raise DispatchFailure("Chat picker returned an invalid OpenCode session")
    return selected[1]


def chat_history():
    root = current_project_root()
    if root is None:
        root = pick_project()
    if root:
        session_id = pick_discussion(root)
        if session_id:
            launch_session(root, session_id)
    return 0


def slugify(value):
    value = re.sub(r"[^a-z0-9._-]+", "-", value.strip().lower())
    value = re.sub(r"-+", "-", value).strip("-")
    if not value:
        raise DispatchFailure("Dispatch slug must contain a letter or number")
    return value


def validate_selected_repository(root):
    root = canonical(root)
    resolved = primary_repository(root)
    if resolved != root:
        raise DispatchFailure(
            f"Selected repository mismatch: expected primary root {root}, resolved {resolved or 'no repository'}"
        )
    return root


def dispatch_base(root):
    if git(root, "show-ref", "--verify", "--quiet", "refs/remotes/origin/develop", check=False).returncode == 0:
        return "origin/develop"
    head = git(root, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD", check=False)
    if head.returncode == 0:
        return head.stdout.strip()
    raise DispatchFailure("Could not determine a base: origin/develop and origin/HEAD are unavailable")


def json_field(output, *path):
    try:
        value = json.loads(output)
        for part in path:
            value = value[part]
        return value
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        raise DispatchFailure(f"Invalid Herdr JSON response while reading {'.'.join(path)}: {error}") from error


def agent_name(slug, pane_id):
    pane = re.sub(r"[^a-z0-9]", "", pane_id.lower())[-8:] or "pane"
    prefix = re.sub(r"[^a-z0-9]", "", slug.lower())[:18] or "task"
    return f"oc-{prefix}-{pane}"[:32]


def socket_request(method, params):
    path = os.environ.get("HERDR_SOCKET_PATH")
    if not path:
        raise DispatchFailure("HERDR_SOCKET_PATH is not set; cannot close dispatcher popup")
    request = json.dumps({"id": f"dispatcher-{os.getpid()}", "method": method, "params": params}) + "\n"
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.connect(path)
            connection.sendall(request.encode())
            response = json.loads(connection.makefile().readline())
    except (OSError, json.JSONDecodeError) as error:
        raise DispatchFailure(f"Herdr socket request {method} failed: {error}") from error
    if "error" in response:
        raise DispatchFailure(f"Herdr socket request {method} failed: {json.dumps(response['error'], sort_keys=True)}")
    return response.get("result", {})


def active_linked_task(session_id):
    if not session_id:
        return None
    try:
        discussion = next(item for item in load_discussions() if item.get("session_id") == session_id)
    except StopIteration:
        return None
    task = discussion.get("active_task")
    if not task or not task.get("agent") or not task.get("workspace_id"):
        return None
    result = herdr("agent", "get", task["agent"], check=False)
    if result.returncode:
        return None
    try:
        agent = json.loads(result.stdout).get("result", {}).get("agent", {})
    except json.JSONDecodeError:
        return None
    if agent.get("workspace_id") != task["workspace_id"] or agent.get("interactive_ready") is not True:
        return None
    checkout = task.get("checkout_path")
    cwd = agent.get("foreground_cwd") or agent.get("cwd")
    if checkout:
        if not cwd:
            return None
        checkout_path = Path(canonical(checkout))
        cwd_path = Path(canonical(cwd))
        if cwd_path != checkout_path and checkout_path not in cwd_path.parents:
            return None
    return task


def finish_dispatch(workspace_id, original_workspace_id):
    herdr("workspace", "focus", workspace_id)
    try:
        socket_request("popup.close", {})
    except DispatchFailure as close_error:
        if original_workspace_id:
            try:
                herdr("workspace", "focus", original_workspace_id)
            except DispatchFailure as restore_error:
                raise DispatchFailure(f"{close_error}\nAlso failed to restore workspace focus: {restore_error}") from close_error
        raise


def dispatch_task(slug, request):
    if os.environ.get("HERDR_DISPATCHER") != "1":
        raise DispatchFailure("dispatch is only available inside a dispatcher popup")
    root = validate_selected_repository(os.environ.get("HERDR_DISPATCHER_PROJECT_ROOT", ""))
    slug = slugify(slug)
    request = request.strip()
    if not request:
        raise DispatchFailure("Dispatch request must not be empty")
    original_workspace_id = plugin_context().get("workspace_id")
    session_id = active_session_id()
    if not session_id:
        raise DispatchFailure("Dispatcher session tracking is not ready; retry the request in this popup")
    with dispatch_session_lock(session_id):
        return dispatch_task_locked(root, slug, request, session_id, original_workspace_id)


def dispatch_task_locked(root, slug, request, session_id, original_workspace_id):
    branch = f"wheels/{slug}"
    checkout = str(Path(root) / ".worktrees" / slug)
    save_discussion(session_id, project_root=root)
    log_event(
        "dispatcher.dispatch_started",
        project_root=root,
        slug=slug,
        branch=branch,
        checkout_path=checkout,
        request=request,
    )
    try:
        linked = active_linked_task(session_id)
        if linked:
            delivered_at = linked.get("last_delivered_at", 0)
            if linked.get("last_request") == request and int(time.time() * 1000) - delivered_at < 60_000:
                raise DispatchFailure("This exact request was already delivered in the last minute; do not resend it")
            if linked.get("last_delivery_status") == "ui_failed" and linked.get("last_request") == request:
                raise DispatchFailure(
                    "This exact follow-up was already delivered, but popup focus/closure failed; do not resend it"
                )
            herdr("agent", "prompt", linked["agent"], request)
            save_discussion(
                session_id,
                project_root=root,
                active_task={
                    **linked,
                    "last_prompted_at": int(time.time() * 1000),
                    "last_request": request,
                    "last_delivery_status": "delivered",
                    "last_delivered_at": int(time.time() * 1000),
                },
            )
            try:
                finish_dispatch(linked["workspace_id"], original_workspace_id)
            except DispatchFailure:
                save_discussion(
                    session_id,
                    project_root=root,
                    active_task={**linked, "last_request": request, "last_delivery_status": "ui_failed"},
                )
                raise
            log_event(
                "dispatcher.followup_routed",
                session_id=session_id,
                workspace_id=linked["workspace_id"],
                agent=linked["agent"],
            )
            return 0
        git(root, "fetch", "origin", "--prune")
        if git(root, "show-ref", "--verify", "--quiet", f"refs/heads/{branch}", check=False).returncode == 0:
            raise DispatchFailure(f"Local branch already exists: {branch}")
        if git(root, "show-ref", "--verify", "--quiet", f"refs/remotes/origin/{branch}", check=False).returncode == 0:
            raise DispatchFailure(f"Remote branch already exists: origin/{branch}")
        if Path(checkout).exists():
            raise DispatchFailure(f"Worktree path already exists: {checkout}")
        base = dispatch_base(root)
        created = herdr(
            "worktree", "create",
            "--cwd", root,
            "--branch", branch,
            "--base", base,
            "--path", checkout,
            "--label", slug,
            "--no-focus",
            "--json",
        )
        workspace_id = json_field(created.stdout, "result", "workspace", "workspace_id")
        root_pane = json_field(created.stdout, "result", "root_pane", "pane_id")
        herdr(
            "pane", "split", root_pane,
            "--direction", "down",
            "--ratio", "0.70",
            "--cwd", checkout,
            "--no-focus",
        )
        name = agent_name(slug, root_pane)
        herdr("agent", "start", name, "--kind", "opencode", "--pane", root_pane, "--", checkout)
        herdr("agent", "prompt", name, request)
        if session_id:
            save_discussion(
                session_id,
                project_root=root,
                active_task={
                    "branch": branch,
                    "checkout_path": checkout,
                    "workspace_id": workspace_id,
                    "agent": name,
                    "dispatched_at": int(time.time() * 1000),
                    "last_request": request,
                    "last_delivery_status": "delivered",
                    "last_delivered_at": int(time.time() * 1000),
                },
            )
        try:
            finish_dispatch(workspace_id, original_workspace_id)
        except DispatchFailure:
            save_discussion(
                session_id,
                project_root=root,
                active_task={
                    "branch": branch,
                    "checkout_path": checkout,
                    "workspace_id": workspace_id,
                    "agent": name,
                    "dispatched_at": int(time.time() * 1000),
                    "last_request": request,
                    "last_delivery_status": "ui_failed",
                },
            )
            raise
    except (DispatchFailure, OSError) as error:
        log_event("dispatcher.dispatch_failed", project_root=root, slug=slug, error=str(error))
        raise
    log_event("dispatcher.dispatch_succeeded", workspace_id=workspace_id, agent=name)
    return 0


def parse_args():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("chat-current")
    commands.add_parser("chat-picker")
    commands.add_parser("chat-history")
    dispatch = commands.add_parser("dispatch")
    dispatch.add_argument("--slug", required=True)
    dispatch.add_argument("--request", required=True)
    return parser.parse_args()


def main():
    args = parse_args()
    try:
        if args.command == "chat-current":
            return chat_current()
        if args.command == "chat-picker":
            return chat_picker()
        if args.command == "chat-history":
            return chat_history()
        if args.command == "dispatch":
            return dispatch_task(args.slug, args.request)
    except DispatchFailure as error:
        print(str(error), file=sys.stderr)
        print("\nDispatcher remains open. Fix the error or continue chatting.", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
