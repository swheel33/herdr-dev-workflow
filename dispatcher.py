#!/usr/bin/env python3

import argparse
from concurrent.futures import as_completed, ThreadPoolExecutor
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

from lifecycle import atomic_json, canonical, known_roots, log_event, notify, state_dir


class DispatchFailure(RuntimeError):
    pass


CHAT_AGENT = "Project Chat"
CHAT_AGENT_COLOR = "#D27E99"
CHAT_TAB_LABEL = "New Chat"
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


def open_chat_tab(root, session_id=None, label=CHAT_TAB_LABEL):
    root = canonical(root)
    workspace_id, bootstrap_pane_id = primary_workspace(root)
    command = [
        "plugin", "pane", "open",
        "--plugin", os.environ.get("HERDR_PLUGIN_ID", "wheels.dev-workflow"),
        "--entrypoint", "dispatcher-chat",
        "--placement", "split" if bootstrap_pane_id else "tab",
        "--workspace", workspace_id,
        "--cwd", root,
        "--env", f"HERDR_DISPATCHER_PROJECT_ROOT={root}",
        "--env", f"HERDR_CHAT_TAB_LABEL={label}",
    ]
    if bootstrap_pane_id:
        command.extend(("--target-pane", bootstrap_pane_id))
    if session_id:
        command.extend(("--env", f"HERDR_DISPATCHER_SESSION_ID={session_id}"))
    command.append("--focus")
    herdr(*command)
    if bootstrap_pane_id:
        herdr("pane", "close", bootstrap_pane_id)
    log_event("dispatcher.chat_tab_opened", project_root=root, workspace_id=workspace_id, session_id=session_id)
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
    result = run_command(["opencode", "session", "list", "--format", "json"], cwd=root)
    try:
        sessions = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise DispatchFailure(f"Invalid OpenCode session list JSON: {error}") from error
    return sessions if isinstance(sessions, list) else []


def checkout_root(path):
    result = git(path, "rev-parse", "--path-format=absolute", "--show-toplevel", check=False)
    return canonical(result.stdout.strip()) if result.returncode == 0 and result.stdout.strip() else None


def general_chat_sessions():
    sessions = {}
    roots = discover_project_roots()
    with ThreadPoolExecutor(max_workers=len(roots) or 1) as executor:
        futures = {executor.submit(opencode_sessions, root): root for root in roots}
        for future in as_completed(futures):
            root = futures[future]
            try:
                root_sessions = future.result()
            except DispatchFailure as error:
                log_event("dispatcher.chat_history_project_failed", project_root=root, error=str(error))
                continue
            for session in root_sessions:
                session_id = session.get("id")
                directory = session.get("directory")
                if not session_id or not directory or checkout_root(directory) != canonical(root):
                    continue
                sessions.setdefault(session_id, {**session, "project_root": root})
    return sorted(sessions.values(), key=lambda item: item.get("updated", 0), reverse=True)


def pick_chat():
    sessions = general_chat_sessions()
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
            f"{Path(session['project_root']).name}\t{session.get('title') or 'Untitled'}\t{timestamp}\t{session_id}\n"
        )
    result = run_command(
        ["fzf", "--prompt", "chat> ", "--height", "100%", "--reverse", "--with-nth", "1,2,3"],
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
    return session["project_root"], session["id"], session.get("title") or CHAT_TAB_LABEL


def chat_history():
    selected = pick_chat()
    if selected:
        open_chat_tab(*selected)
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


def start_agent_when_shell_ready(name, pane_id, checkout, timeout=30):
    deadline = time.monotonic() + timeout
    while True:
        result = herdr(
            "agent", "start", name,
            "--kind", "opencode",
            "--pane", pane_id,
            "--", checkout,
            check=False,
        )
        if result.returncode == 0:
            return
        detail = result.stderr.strip() or result.stdout.strip() or "no error output"
        if "agent_pane_busy" not in detail:
            raise DispatchFailure(f"Could not start agent {name}: {detail}")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise DispatchFailure(f"Timed out waiting for agent target pane {pane_id} to become an available shell: {detail}")
        time.sleep(min(0.05, remaining))


@contextlib.contextmanager
def dispatch_lock(root):
    identifier = hashlib.sha256(canonical(root).encode()).hexdigest()[:24]
    path = state_dir() / "locks" / f"dispatcher-{identifier}.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def dispatch_cleanup_warning(root, slug, stage, error):
    detail = str(error)
    message = f"Implementation dispatch succeeded, but {stage}: {detail}. Do not retry the dispatch."
    log_event(
        "dispatcher.dispatch_cleanup_warning",
        project_root=root,
        slug=slug,
        stage=stage,
        error=detail,
    )
    try:
        notify("Dispatch cleanup incomplete", message)
    except Exception as notify_error:
        log_event("dispatcher.dispatch_cleanup_notification_failed", error=str(notify_error))
    try:
        print(message, file=sys.stderr)
    except OSError:
        pass


def source_chat_can_close(root, chat_tab_id, chat_workspace_id):
    if not chat_workspace_id:
        raise DispatchFailure("source workspace metadata is missing; leaving the Project Chat open")
    listed = herdr("tab", "list", "--workspace", chat_workspace_id)
    tabs = json_field(listed.stdout, "result", "tabs")
    if not isinstance(tabs, list):
        raise DispatchFailure("source workspace tab metadata is invalid; leaving the Project Chat open")
    if any(not isinstance(tab, dict) or not isinstance(tab.get("tab_id"), str) for tab in tabs):
        raise DispatchFailure("source workspace tab metadata is invalid; leaving the Project Chat open")
    tab_ids = [tab["tab_id"] for tab in tabs]
    if chat_tab_id not in tab_ids:
        return False
    if len(tabs) == 1:
        herdr(
            "tab", "create",
            "--workspace", chat_workspace_id,
            "--cwd", root,
            "--no-focus",
        )
    return True


def finish_dispatch(root, slug, workspace_id, chat_tab_id, chat_workspace_id):
    try:
        can_close = source_chat_can_close(root, chat_tab_id, chat_workspace_id)
    except (DispatchFailure, OSError) as error:
        dispatch_cleanup_warning(root, slug, "could not preserve the source workspace", error)
        can_close = False
    try:
        herdr("workspace", "focus", workspace_id)
    except (DispatchFailure, OSError) as error:
        dispatch_cleanup_warning(root, slug, "could not focus the implementation workspace", error)
        return
    if not can_close:
        return
    try:
        herdr("tab", "close", chat_tab_id)
    except (DispatchFailure, OSError) as close_error:
        restore_error = None
        if chat_workspace_id:
            try:
                herdr("workspace", "focus", chat_workspace_id)
            except (DispatchFailure, OSError) as error:
                restore_error = error
        detail = close_error
        if restore_error:
            detail = f"{close_error}; also could not restore source workspace focus: {restore_error}"
        dispatch_cleanup_warning(root, slug, "could not close the source Project Chat", detail)


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
    if not chat_tab_id:
        raise DispatchFailure("HERDR_TAB_ID is not set; cannot close the project chat tab")
    with dispatch_lock(root):
        return dispatch_task_locked(root, slug, request, chat_tab_id, chat_workspace_id)


def dispatch_task_locked(root, slug, request, chat_tab_id, chat_workspace_id):
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
            git(root, "fetch", "origin", "--prune")
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
        start_agent_when_shell_ready(name, root_pane, checkout)
        herdr("agent", "prompt", name, request)
    except (DispatchFailure, OSError) as error:
        log_event("dispatcher.dispatch_failed", project_root=root, slug=slug, error=str(error))
        raise
    try:
        finish_dispatch(root, slug, workspace_id, chat_tab_id, chat_workspace_id)
    except Exception as error:
        dispatch_cleanup_warning(root, slug, "could not finish source chat cleanup", error)
    log_event("dispatcher.dispatch_succeeded", workspace_id=workspace_id, agent=name)
    return 0


def parse_args():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("chat-current")
    commands.add_parser("chat-picker")
    commands.add_parser("chat-history")
    commands.add_parser("run-chat")
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
        if args.command == "dispatch":
            return dispatch_task(args.slug, args.request)
    except DispatchFailure as error:
        print(str(error), file=sys.stderr)
        print("\nThe project chat tab remains open. Fix the error or continue chatting.", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
