#!/usr/bin/env python3

import argparse
import contextlib
from datetime import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

from lifecycle import (
    atomic_json,
    canonical,
    GitFailure,
    known_roots,
    log_event,
    notify,
    state_dir,
    synchronize_primary_main,
)


class DispatchFailure(RuntimeError):
    pass


CHAT_AGENT = "Project Chat"
CHAT_AGENT_COLOR = "#D27E99"
CHAT_TAB_LABEL = "New Chat"
IMPLEMENTATION_AGENT = "build"
CHAT_DISPATCH_COMMANDS = (
    'python3 "$HERDR_PLUGIN_ROOT/dispatcher.py" dispatch *',
    "python3 *dispatcher.py dispatch *",
)
CHAT_TUI_DISABLED_KEYBINDS = (
    "session_new",
    "session_list",
    "session_fork",
    "session_delete",
    "session_move",
    "agent_list",
    "agent_cycle",
    "agent_cycle_reverse",
)
AGENT_START_TIMEOUT_SECONDS = 30
PROMPT_DELIVERY_TIMEOUT_MS = 30_000


def run_command(command, *, check=True, input_text=None, cwd=None, log_output=True):
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
        stdout=result.stdout if log_output else None,
        stderr=result.stderr if log_output else None,
    )
    if check and result.returncode:
        detail = result.stderr.strip() or result.stdout.strip() or "no error output"
        raise DispatchFailure(f"Command failed ({result.returncode}): {' '.join(command)}\n{detail}")
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
    candidates = [context.get("focused_pane_cwd"), context.get("workspace_cwd"), os.getcwd()]
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
        raise DispatchFailure(result.stderr.strip() or result.stdout.strip() or "fzf failed")
    selected = result.stdout.rstrip("\n").split("\t", 1)
    if len(selected) != 2 or selected[1] not in roots:
        raise DispatchFailure("Project picker returned an invalid repository")
    return selected[1]


def json_field(output, *path):
    try:
        value = json.loads(output)
        for part in path:
            value = value[part]
        return value
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        raise DispatchFailure(f"Invalid Herdr JSON response while reading {'.'.join(path)}: {error}") from error


def dispatcher_instruction_path():
    return canonical(Path(__file__).parent / "instructions" / "dispatcher.md")


def chat_title_plugin_path():
    return canonical(Path(__file__).parent / "opencode" / "chat-tab-title.js")


def normal_tui_config_path():
    configured = os.environ.get("OPENCODE_TUI_CONFIG")
    if configured and Path(configured).is_file():
        return Path(configured)
    config_home = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    candidate = config_home / "opencode" / "tui.json"
    return candidate if candidate.is_file() else None


def project_chat_tui_config():
    config = {}
    source = normal_tui_config_path()
    if source:
        try:
            config = json.loads(source.read_text())
        except (OSError, json.JSONDecodeError) as error:
            raise DispatchFailure(f"Could not read normal OpenCode TUI config {source}: {error}") from error
        if not isinstance(config, dict):
            raise DispatchFailure(f"OpenCode TUI config {source} must contain a JSON object")
    keybinds = config.get("keybinds", {})
    if not isinstance(keybinds, dict):
        raise DispatchFailure("OpenCode TUI keybinds must be an object")
    config["keybinds"] = {**keybinds, **{key: "none" for key in CHAT_TUI_DISABLED_KEYBINDS}}
    path = state_dir() / "project-chat-tui.json"
    atomic_json(path, config)
    return canonical(path)


def dispatcher_environment(root, session_id=None):
    environment = os.environ.copy()
    inline = {}
    if environment.get("OPENCODE_CONFIG_CONTENT"):
        try:
            inline = json.loads(environment["OPENCODE_CONFIG_CONTENT"])
        except json.JSONDecodeError as error:
            raise DispatchFailure(f"OPENCODE_CONFIG_CONTENT must be valid JSON: {error}") from error
        if not isinstance(inline, dict):
            raise DispatchFailure("OPENCODE_CONFIG_CONTENT must contain a JSON object")
    agents = inline.get("agent", {})
    if not isinstance(agents, dict):
        raise DispatchFailure("OPENCODE_CONFIG_CONTENT agent must be an object")
    plugins = inline.get("plugin", [])
    if not isinstance(plugins, list):
        raise DispatchFailure("OPENCODE_CONFIG_CONTENT plugin must be an array")
    build = agents.get("build") if isinstance(agents.get("build"), dict) else {}
    plan = agents.get("plan") if isinstance(agents.get("plan"), dict) else {}
    chat = agents.get(CHAT_AGENT) if isinstance(agents.get(CHAT_AGENT), dict) else {}
    chat_permission = chat.get("permission") if isinstance(chat.get("permission"), dict) else {}
    chat_bash = chat_permission.get("bash") if isinstance(chat_permission.get("bash"), dict) else {}
    inline["agent"] = {
        **agents,
        "build": {**build, "disable": True},
        "plan": {**plan, "disable": True},
        CHAT_AGENT: {
            **chat,
            "description": "Project Chat",
            "mode": "primary",
            "color": chat.get("color", CHAT_AGENT_COLOR),
            "prompt": Path(dispatcher_instruction_path()).read_text(),
            "permission": {
                **chat_permission,
                "edit": "deny",
                "bash": {
                    **chat_bash,
                    **{command: "allow" for command in CHAT_DISPATCH_COMMANDS},
                },
            },
        },
    }
    title_plugin = f"file://{chat_title_plugin_path()}"
    inline["plugin"] = [*plugins, *([] if title_plugin in plugins else [title_plugin])]
    environment["OPENCODE_CONFIG_CONTENT"] = json.dumps(inline, separators=(",", ":"))
    environment["HERDR_DISPATCHER"] = "1"
    environment["HERDR_DISPATCHER_PROJECT_ROOT"] = canonical(root)
    environment["OPENCODE_TUI_CONFIG"] = project_chat_tui_config()
    if session_id:
        environment["HERDR_DISPATCHER_SESSION_ID"] = session_id
    else:
        environment.pop("HERDR_DISPATCHER_SESSION_ID", None)
    thread_id = os.environ.get("HERDR_DISPATCH_THREAD_ID")
    if thread_id:
        environment["HERDR_DISPATCH_THREAD_ID"] = thread_id
    else:
        environment.pop("HERDR_DISPATCH_THREAD_ID", None)
    return environment


def primary_workspace(root):
    root = canonical(root)
    listed = json_field(herdr("workspace", "list").stdout, "result", "workspaces")
    for workspace in listed:
        provenance = workspace.get("worktree") or {}
        checkout = provenance.get("checkout_path")
        if checkout and not provenance.get("is_linked_worktree") and canonical(checkout) == root:
            return workspace["workspace_id"], None
    listing = json_field(herdr("worktree", "list", "--cwd", root, "--json").stdout, "result")
    for tree in listing.get("worktrees", []):
        if tree.get("path") and canonical(tree["path"]) == root and tree.get("open_workspace_id"):
            return tree["open_workspace_id"], None
    source = listing.get("source") or {}
    if source.get("source_checkout_path") and canonical(source["source_checkout_path"]) == root and source.get("source_workspace_id"):
        return source["source_workspace_id"], None
    opened = herdr(
        "worktree", "open", "--cwd", root, "--path", root,
        "--label", Path(root).name, "--no-focus", "--json",
    )
    result = json_field(opened.stdout, "result")
    workspace_id = result["workspace"]["workspace_id"]
    bootstrap_pane_id = None if result["already_open"] else result["root_pane"]["pane_id"]
    return workspace_id, bootstrap_pane_id


def open_chat_in_workspace(
    root,
    workspace_id,
    *,
    session_id=None,
    label=CHAT_TAB_LABEL,
    focus=True,
    target_pane=None,
    fork=False,
    thread_id=None,
):
    root = canonical(root)
    command = [
        "plugin", "pane", "open",
        "--plugin", os.environ.get("HERDR_PLUGIN_ID", "wheels.dev-workflow"),
        "--entrypoint", "dispatcher-chat",
        "--placement", "split" if target_pane else "tab",
        "--workspace", workspace_id,
        "--cwd", root,
        "--env", f"HERDR_DISPATCHER_PROJECT_ROOT={root}",
        "--env", f"HERDR_CHAT_TAB_LABEL={label}",
    ]
    if target_pane:
        command.extend(("--target-pane", target_pane))
    if session_id:
        command.extend(("--env", f"HERDR_DISPATCHER_SESSION_ID={session_id}"))
    if fork:
        command.extend(("--env", "HERDR_DISPATCHER_FORK_SESSION=1"))
    if thread_id:
        command.extend(("--env", f"HERDR_DISPATCH_THREAD_ID={thread_id}"))
    command.append("--focus" if focus else "--no-focus")
    opened = herdr(*command)
    try:
        return json.loads(opened.stdout)["result"]["plugin_pane"]["pane"]["tab_id"]
    except (json.JSONDecodeError, KeyError, TypeError):
        return None


def open_chat_tab(root, session_id=None, label=CHAT_TAB_LABEL, *, fork=False, thread_id=None):
    root = canonical(root)
    workspace_id, bootstrap_pane_id = primary_workspace(root)
    open_chat_in_workspace(
        root,
        workspace_id,
        session_id=session_id,
        label=label,
        target_pane=bootstrap_pane_id,
        fork=fork,
        thread_id=thread_id,
    )
    if bootstrap_pane_id:
        herdr("pane", "close", bootstrap_pane_id)
    log_event(
        "dispatcher.chat_tab_opened",
        project_root=root,
        workspace_id=workspace_id,
        session_id=session_id,
        fork=fork,
        thread_id=thread_id,
    )
    return workspace_id


def open_selector(entrypoint):
    context = plugin_context()
    cwd = context.get("focused_pane_cwd") or context.get("workspace_cwd") or os.getcwd()
    herdr(
        "plugin", "pane", "open",
        "--plugin", os.environ.get("HERDR_PLUGIN_ID", "wheels.dev-workflow"),
        "--entrypoint", entrypoint,
        "--cwd", cwd,
        "--focus",
    )


def run_chat(exec_fn=os.execvpe):
    root = validate_selected_repository(os.environ.get("HERDR_DISPATCHER_PROJECT_ROOT", ""))
    session_id = os.environ.get("HERDR_DISPATCHER_SESSION_ID")
    tab_id = os.environ.get("HERDR_TAB_ID") or plugin_context().get("tab_id")
    if tab_id:
        herdr("tab", "rename", tab_id, os.environ.get("HERDR_CHAT_TAB_LABEL", CHAT_TAB_LABEL), check=False)
    arguments = ["opencode", root, "--agent", CHAT_AGENT]
    if session_id:
        arguments.extend(("--session", session_id))
    if os.environ.get("HERDR_DISPATCHER_FORK_SESSION") == "1":
        arguments.append("--fork")
    log_event("dispatcher.session_launching", project_root=root, fresh=not bool(session_id), session_id=session_id)
    exec_fn("opencode", arguments, dispatcher_environment(root, session_id))


def chat_current():
    root = current_project_root()
    if root is None:
        log_event("dispatcher.current_falling_back_to_picker")
        open_selector("dispatcher-picker")
        return 0
    open_chat_tab(root)
    return 0


def chat_picker():
    root = pick_project()
    if root:
        open_chat_tab(root)
    return 0


def opencode_sessions(root):
    result = run_command(
        ["opencode", "session", "list", "--format", "json"],
        cwd=root,
        log_output=False,
    )
    try:
        sessions = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise DispatchFailure(f"Invalid OpenCode session list JSON: {error}") from error
    return sessions if isinstance(sessions, list) else []


def dispatch_threads_path():
    return state_dir() / "dispatch-threads.json"


def load_dispatch_threads():
    path = dispatch_threads_path()
    if not path.exists():
        return []
    try:
        threads = json.loads(path.read_text()).get("threads", [])
    except (OSError, json.JSONDecodeError):
        return []
    return threads if isinstance(threads, list) else []


def update_dispatch_thread(thread_id, project_root, session_id, **fields):
    path = dispatch_threads_path()
    lock_path = state_dir() / "locks" / "dispatch-threads.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        threads = load_dispatch_threads()
        thread = next((item for item in threads if item.get("thread_id") == thread_id), None)
        if thread is None:
            thread = {
                "thread_id": thread_id,
                "project_root": canonical(project_root),
                "sessions": [],
                "dispatches": [],
            }
            threads.append(thread)
        sessions = thread.setdefault("sessions", [])
        if session_id and session_id not in sessions:
            sessions.append(session_id)
        thread.update(fields)
        thread["project_root"] = canonical(project_root)
        thread["latest_session_id"] = session_id
        thread["updated"] = int(time.time() * 1000)
        atomic_json(path, {"threads": threads})
    return thread


def record_dispatch_thread(root, thread_id, source_session_id, implementation_session_id, slug, branch, checkout):
    path = dispatch_threads_path()
    lock_path = state_dir() / "locks" / "dispatch-threads.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        threads = load_dispatch_threads()
        thread = next((item for item in threads if item.get("thread_id") == thread_id), None)
        if thread is None:
            thread = {
                "thread_id": thread_id,
                "project_root": canonical(root),
                "sessions": [],
                "dispatches": [],
            }
            threads.append(thread)
        sessions = thread.setdefault("sessions", [])
        for session_id in (source_session_id, implementation_session_id):
            if session_id not in sessions:
                sessions.append(session_id)
        thread.update({
            "project_root": canonical(root),
            "latest_session_id": implementation_session_id,
            "title": slug,
            "updated": int(time.time() * 1000),
        })
        thread.setdefault("dispatches", []).append({
            "slug": slug,
            "branch": branch,
            "checkout_path": canonical(checkout),
            "source_session_id": source_session_id,
            "implementation_session_id": implementation_session_id,
            "created": int(time.time() * 1000),
        })
        atomic_json(path, {"threads": threads})
    log_event(
        "dispatcher.thread_recorded",
        thread_id=thread_id,
        source_session_id=source_session_id,
        implementation_session_id=implementation_session_id,
        project_root=canonical(root),
    )


def project_chat_sessions(root):
    root = canonical(root)
    sessions = {}
    all_sessions = {}
    for session in opencode_sessions(root):
        session_id = session.get("id")
        directory = session.get("directory")
        if not session_id:
            continue
        all_sessions.setdefault(session_id, session)
        if directory and canonical(directory) == root:
            sessions.setdefault(session_id, {**session, "project_root": root})
    for thread in load_dispatch_threads():
        thread_root = thread.get("project_root")
        if not thread_root or canonical(thread_root) != root:
            continue
        thread_sessions = set(thread.get("sessions", []))
        for session_id in thread_sessions:
            sessions.pop(session_id, None)
        latest_id = thread.get("latest_session_id")
        latest = all_sessions.get(latest_id)
        if latest:
            sessions[latest_id] = {
                **latest,
                "project_root": root,
                "thread_id": thread.get("thread_id"),
                "fork_on_open": True,
            }
    return sorted(sessions.values(), key=lambda item: item.get("updated", 0), reverse=True)


def pick_chat(root):
    sessions = project_chat_sessions(root)
    if not sessions:
        raise DispatchFailure("No previous project chats found")
    rows = []
    valid = {}
    for session in sessions:
        session_id = session["id"]
        valid[session_id] = session
        updated = session.get("updated", 0) / 1000
        timestamp = datetime.fromtimestamp(updated).strftime("%Y-%m-%d %H:%M") if updated else "unknown"
        rows.append(
            f"{session.get('title') or 'Untitled'}\t{timestamp}\t{session_id}\n"
        )
    result = run_command(
        ["fzf", "--prompt", "chat> ", "--reverse", "--with-nth", "1,2"],
        check=False,
        input_text="".join(rows),
    )
    if result.returncode in (1, 130):
        return None
    if result.returncode:
        raise DispatchFailure(result.stderr.strip() or "Chat picker failed")
    selected = result.stdout.rstrip("\n").rsplit("\t", 1)
    if len(selected) != 2 or selected[1] not in valid:
        raise DispatchFailure("Chat picker returned an invalid OpenCode session")
    session = valid[selected[1]]
    return (
        session["project_root"],
        session["id"],
        session.get("title") or CHAT_TAB_LABEL,
        session.get("fork_on_open", False),
        session.get("thread_id"),
    )


def chat_history():
    root = current_project_root()
    if root is None:
        raise DispatchFailure("Chat history requires a pane inside a Git project")
    print("Loading chat history...", flush=True)
    selected = pick_chat(root)
    if selected:
        root, session_id, label, fork, thread_id = selected
        open_chat_tab(root, session_id, label, fork=fork, thread_id=thread_id)
    return 0


def register_chat_session(thread_id, session_id, root):
    root = validate_selected_repository(root)
    update_dispatch_thread(thread_id, root, session_id)
    log_event(
        "dispatcher.chat_session_registered",
        thread_id=thread_id,
        session_id=session_id,
        project_root=root,
    )
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
        raise DispatchFailure(f"Selected repository mismatch: expected primary root {root}, resolved {resolved or 'no repository'}")
    return root


def dispatch_base(root):
    if git(root, "show-ref", "--verify", "--quiet", "refs/remotes/origin/develop", check=False).returncode == 0:
        return "origin/develop"
    head = git(root, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD", check=False)
    if head.returncode == 0:
        return head.stdout.strip()
    for branch in ("develop", "main", "master"):
        if git(root, "show-ref", "--verify", "--quiet", f"refs/heads/{branch}", check=False).returncode == 0:
            return branch
    current = git(root, "branch", "--show-current", check=False).stdout.strip()
    if current:
        return current
    raise DispatchFailure("Could not determine a local or remote base branch")


def has_origin(root):
    return git(root, "remote", "get-url", "origin", check=False).returncode == 0


def agent_name(slug, pane_id):
    pane = re.sub(r"[^a-z0-9]", "", pane_id.lower())[-8:] or "pane"
    prefix = re.sub(r"[^a-z0-9]", "", slug.lower())[:18] or "task"
    return f"oc-{prefix}-{pane}"[:32]


def current_chat_session(pane_id):
    resumed = os.environ.get("HERDR_DISPATCHER_SESSION_ID")
    result = herdr("pane", "get", pane_id)
    pane = json_field(result.stdout, "result", "pane")
    session = pane.get("agent_session") if isinstance(pane, dict) else None
    session_id = session.get("value") if isinstance(session, dict) else None
    if session_id:
        return session_id
    if resumed:
        return resumed
    raise DispatchFailure("Project Chat session identity is not available; dispatch was not started")


def start_agent_when_shell_ready(
    name,
    pane_id,
    checkout,
    timeout=AGENT_START_TIMEOUT_SECONDS,
    parent_session_id=None,
):
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise DispatchFailure(f"Timed out waiting for agent target pane {pane_id} to become an available shell")
        command = [
            "agent", "start", name,
            "--kind", "opencode",
            "--pane", pane_id,
            "--timeout", str(max(1, int(remaining * 1000))),
            "--", checkout,
            "--agent", IMPLEMENTATION_AGENT,
        ]
        if parent_session_id:
            command.extend(("--session", parent_session_id, "--fork"))
        result = herdr(*command, check=False)
        if result.returncode == 0:
            agent = json_field(result.stdout, "result", "agent")
            if (
                not isinstance(agent, dict)
                or agent.get("name") != name
                or agent.get("pane_id") != pane_id
                or agent.get("agent") != "opencode"
                or agent.get("agent_status") != "idle"
                or agent.get("interactive_ready") is not True
                or agent.get("launch_pending") is True
                or type(agent.get("state_change_seq")) is not int
            ):
                raise DispatchFailure(f"Agent {name} started without authoritative idle readiness state")
            return agent
        detail = result.stderr.strip() or result.stdout.strip() or "no error output"
        if "agent_pane_busy" not in detail:
            raise DispatchFailure(f"Could not start agent {name}: {detail}")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise DispatchFailure(f"Timed out waiting for agent target pane {pane_id} to become an available shell: {detail}")
        time.sleep(min(0.05, remaining))


def prompt_agent_and_confirm_delivery(name, request, initial_state_change_seq, timeout_ms=PROMPT_DELIVERY_TIMEOUT_MS):
    result = herdr(
        "agent", "prompt", name, request,
        "--wait",
        "--until", "working",
        "--timeout", str(timeout_ms),
    )
    agent = json_field(result.stdout, "result", "agent")
    session = agent.get("agent_session") if isinstance(agent, dict) else None
    if (
        not isinstance(agent, dict)
        or agent.get("name") != name
        or agent.get("agent") != "opencode"
        or agent.get("agent_status") != "working"
        or type(agent.get("state_change_seq")) is not int
        or agent["state_change_seq"] <= initial_state_change_seq
        or not isinstance(session, dict)
        or session.get("source") != "herdr:opencode"
        or session.get("agent") != "opencode"
        or session.get("kind") != "id"
        or not isinstance(session.get("value"), str)
        or not session["value"]
    ):
        raise DispatchFailure(f"Prompt delivery to agent {name} was not confirmed by an OpenCode session transition")
    return agent


@contextlib.contextmanager
def dispatch_lock(root):
    identifier = hashlib.sha256(canonical(root).encode()).hexdigest()[:24]
    path = state_dir() / "locks" / f"dispatcher-{identifier}.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def dispatch_cleanup_warning(root, slug, stage, error):
    message = f"Implementation dispatch succeeded, but {stage}: {error}. Do not retry the dispatch."
    log_event(
        "dispatcher.dispatch_cleanup_warning",
        project_root=root,
        slug=slug,
        stage=stage,
        error=str(error),
    )
    try:
        notify("Dispatch cleanup incomplete", message)
    except Exception as notify_error:
        log_event("dispatcher.dispatch_cleanup_notification_failed", error=str(notify_error))
    try:
        print(message, file=sys.stderr)
    except OSError:
        pass


def replace_source_chat(root, chat_tab_id, chat_workspace_id):
    listed = herdr("tab", "list", "--workspace", chat_workspace_id)
    tabs = json_field(listed.stdout, "result", "tabs")
    if not isinstance(tabs, list) or any(
        not isinstance(tab, dict) or not isinstance(tab.get("tab_id"), str) for tab in tabs
    ):
        raise DispatchFailure("source workspace tab metadata is invalid")
    if not any(tab["tab_id"] == chat_tab_id for tab in tabs):
        raise DispatchFailure("source Project Chat is no longer present")

    empty_chat_ids = [
        tab["tab_id"]
        for tab in tabs
        if tab["tab_id"] != chat_tab_id and tab.get("label") == CHAT_TAB_LABEL
    ]
    if not empty_chat_ids:
        replacement_tab_id = open_chat_in_workspace(root, chat_workspace_id, focus=False)
        if not replacement_tab_id:
            raise DispatchFailure("replacement Project Chat tab identity is not available")
        try:
            herdr("tab", "rename", replacement_tab_id, CHAT_TAB_LABEL)
        except Exception:
            herdr("tab", "close", replacement_tab_id, check=False)
            raise
    else:
        for duplicate_tab_id in empty_chat_ids[1:]:
            herdr("tab", "close", duplicate_tab_id)
    herdr("tab", "close", chat_tab_id)


def dispatch_task(slug, request):
    if os.environ.get("HERDR_DISPATCHER") != "1":
        raise DispatchFailure("dispatch is only available inside a project chat tab")
    root = validate_selected_repository(os.environ.get("HERDR_DISPATCHER_PROJECT_ROOT", ""))
    slug = slugify(slug)
    request = request.strip()
    if not request:
        raise DispatchFailure("Dispatch request must not be empty")
    context = plugin_context()
    chat_tab_id = os.environ.get("HERDR_TAB_ID") or context.get("tab_id")
    chat_workspace_id = os.environ.get("HERDR_WORKSPACE_ID") or context.get("workspace_id")
    chat_pane_id = os.environ.get("HERDR_PANE_ID") or context.get("pane_id")
    if not chat_tab_id or not chat_workspace_id or not chat_pane_id:
        raise DispatchFailure("Project Chat tab, workspace, or pane metadata is missing")
    source_session_id = current_chat_session(chat_pane_id)
    thread_id = os.environ.get("HERDR_DISPATCH_THREAD_ID") or source_session_id
    with dispatch_lock(root):
        return dispatch_task_locked(
            root,
            slug,
            request,
            chat_tab_id,
            chat_workspace_id,
            source_session_id,
            thread_id,
        )


def dispatch_task_locked(
    root,
    slug,
    request,
    chat_tab_id,
    chat_workspace_id,
    source_session_id,
    thread_id,
):
    branch = f"wheels/{slug}"
    checkout = str(Path(root) / ".worktrees" / slug)
    log_event(
        "dispatcher.dispatch_started",
        project_root=root,
        slug=slug,
        branch=branch,
        checkout_path=checkout,
        request=request,
    )
    try:
        origin = has_origin(root)
        if origin:
            try:
                sync = synchronize_primary_main(root)
            except GitFailure as error:
                detail = "" if error.result is None else (error.result.stderr.strip() or error.result.stdout.strip())
                raise DispatchFailure(f"{error.message}{f': {detail}' if detail else ''}") from error
            if sync["status"] in {"dirty", "diverged"}:
                raise DispatchFailure(
                    f"Local main synchronization blocked: {sync['status']}. "
                    "The primary checkout and branch were left unchanged."
                )
        if git(root, "show-ref", "--verify", "--quiet", f"refs/heads/{branch}", check=False).returncode == 0:
            raise DispatchFailure(f"Local branch already exists: {branch}")
        if origin and git(root, "show-ref", "--verify", "--quiet", f"refs/remotes/origin/{branch}", check=False).returncode == 0:
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
        herdr("pane", "split", root_pane, "--direction", "down", "--ratio", "0.70", "--cwd", checkout, "--no-focus")
        name = agent_name(slug, root_pane)
        started_agent = start_agent_when_shell_ready(
            name,
            root_pane,
            checkout,
            parent_session_id=source_session_id,
        )
        delivered_agent = prompt_agent_and_confirm_delivery(name, request, started_agent["state_change_seq"])
    except (DispatchFailure, OSError) as error:
        log_event("dispatcher.dispatch_failed", project_root=root, slug=slug, error=str(error))
        raise
    implementation_session_id = delivered_agent["agent_session"]["value"]
    try:
        record_dispatch_thread(
            root,
            thread_id,
            source_session_id,
            implementation_session_id,
            slug,
            branch,
            checkout,
        )
        replace_source_chat(root, chat_tab_id, chat_workspace_id)
    except Exception as error:
        dispatch_cleanup_warning(root, slug, "could not reset the source Project Chat", error)
    log_event(
        "dispatcher.dispatch_succeeded",
        workspace_id=workspace_id,
        agent=name,
        agent_session=implementation_session_id,
        thread_id=thread_id,
    )
    return 0


def parse_args():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("chat-current")
    commands.add_parser("chat-picker")
    commands.add_parser("chat-history")
    commands.add_parser("run-chat")
    register = commands.add_parser("register-chat-session")
    register.add_argument("--thread-id", required=True)
    register.add_argument("--session-id", required=True)
    register.add_argument("--root", required=True)
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
        if args.command == "run-chat":
            return run_chat()
        if args.command == "register-chat-session":
            return register_chat_session(args.thread_id, args.session_id, args.root)
        if args.command == "dispatch":
            return dispatch_task(args.slug, args.request)
    except DispatchFailure as error:
        print(str(error), file=sys.stderr)
        print("\nThe project chat tab remains open. Fix the error or continue chatting.", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
