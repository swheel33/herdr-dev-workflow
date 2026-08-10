#!/usr/bin/env python3

import argparse
import os
from pathlib import Path
import subprocess
import sys

import dispatcher
from lifecycle import canonical, log_event, notify, remember_root


class ProjectFailure(RuntimeError):
    pass


class Cancelled(RuntimeError):
    pass


def default_parent():
    return Path(os.environ.get("HERDR_PROJECTS_ROOT", Path.home() / "Projects"))


def normalize_name(value):
    name = value.strip()
    if not name:
        raise ProjectFailure("Project name must not be empty")
    if name in {".", ".."}:
        raise ProjectFailure("Project name must not be '.' or '..'")
    if any(character in name for character in ("/", "\\", "\0")):
        raise ProjectFailure("Project name must be one directory name and cannot contain '/', '\\', or NUL")
    if any(ord(character) < 32 or ord(character) == 127 for character in name):
        raise ProjectFailure("Project name cannot contain control characters")
    return name


def normalize_parent(value):
    raw = value.strip() if value else str(default_parent())
    try:
        parent = Path(os.path.expandvars(os.path.expanduser(raw))).resolve(strict=False)
    except (OSError, RuntimeError, ValueError) as error:
        raise ProjectFailure(f"Invalid parent directory {raw!r}: {error}") from error
    if not parent.exists():
        raise ProjectFailure(f"Parent directory does not exist: {parent}")
    if not parent.is_dir():
        raise ProjectFailure(f"Parent path is not a directory: {parent}")
    return parent


def destination_for(name, parent):
    name = normalize_name(name)
    parent = normalize_parent(str(parent))
    destination = parent / name
    if destination.exists():
        if destination.is_symlink():
            raise ProjectFailure(f"Project destination must not be a symbolic link: {destination}")
        if not destination.is_dir():
            raise ProjectFailure(f"Project destination exists and is not a directory: {destination}")
        try:
            non_empty = next(destination.iterdir(), None) is not None
        except OSError as error:
            raise ProjectFailure(f"Could not inspect project destination {destination}: {error}") from error
        if non_empty:
            raise ProjectFailure(f"Project destination already exists and is not empty: {destination}")
    return destination


def run_command(command, *, cwd=None):
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as error:
        raise ProjectFailure(f"Could not run {command[0]}: {error}") from error
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip() or "no error output"
        raise ProjectFailure(f"Command failed ({result.returncode}): {' '.join(command)}\n{detail}")
    return result


def create_local_repository(destination):
    destination = Path(destination)
    destination = destination_for(destination.name, destination.parent)
    if not destination.exists():
        try:
            destination.mkdir()
        except OSError as error:
            raise ProjectFailure(f"Could not create project directory {destination}: {error}") from error
    run_command(["git", "init", "-b", "main", str(destination)])
    run_command(["git", "-C", str(destination), "commit", "--allow-empty", "-m", "Initial commit"])
    return canonical(destination)


def create_github_repository(destination, name, visibility):
    if visibility not in {"private", "public"}:
        raise ProjectFailure(f"Invalid GitHub visibility: {visibility}")
    run_command(["gh", "auth", "status"])
    run_command(
        ["gh", "repo", "create", name, f"--{visibility}", "--source", ".", "--remote", "origin"],
        cwd=destination,
    )
    run_command(["git", "push", "-u", "origin", "main"], cwd=destination)


def register_and_open(destination):
    remember_root(destination)
    return dispatcher.open_chat_tab(destination)


def create_project(name, parent, *, github=False, visibility="private"):
    normalized_name = normalize_name(name)
    destination = destination_for(normalized_name, parent)
    log_event(
        "blank_project.started",
        project_name=normalized_name,
        destination=str(destination),
        github=github,
        visibility=visibility if github else None,
    )
    destination = create_local_repository(destination)
    github_error = None
    if github:
        try:
            create_github_repository(destination, normalized_name, visibility)
        except ProjectFailure as error:
            github_error = str(error)
            log_event("blank_project.github_failed", destination=destination, error=github_error)
    try:
        workspace_id = register_and_open(destination)
    except (RuntimeError, OSError) as error:
        log_event("blank_project.open_failed", destination=destination, error=str(error))
        raise ProjectFailure(f"Local repository created at {destination}, but Herdr could not open it: {error}") from error
    log_event(
        "blank_project.succeeded",
        destination=destination,
        workspace_id=workspace_id,
        github=github and github_error is None,
        github_error=github_error,
    )
    return {"destination": destination, "workspace_id": workspace_id, "github_error": github_error}


def prompt(label, *, default=None):
    suffix = f" [{default}]" if default is not None else ""
    try:
        value = input(f"{label}{suffix}: ")
    except (EOFError, KeyboardInterrupt) as error:
        raise Cancelled from error
    return value if value else default


def prompt_choice(label, choices, default):
    rendered = "/".join(choice.upper() if choice == default else choice for choice in choices)
    while True:
        value = prompt(f"{label} ({rendered})", default=default).strip().lower()
        matches = [choice for choice in choices if choice.startswith(value)]
        if len(matches) == 1:
            return matches[0]
        print(f"Choose one of: {', '.join(choices)}", file=sys.stderr)


def interactive():
    print("New blank project\n")
    name = prompt("Project name")
    if name is None:
        raise Cancelled
    parent = prompt("Parent directory", default=str(default_parent()))
    github = prompt_choice("Create GitHub repository", ("no", "yes"), "no") == "yes"
    visibility = prompt_choice("GitHub visibility", ("private", "public"), "private") if github else "private"
    result = create_project(name, parent, github=github, visibility=visibility)
    print(f"\nCreated local repository: {result['destination']}")
    if result["github_error"]:
        message = f"GitHub setup failed; the local repository was kept and opened.\n{result['github_error']}"
        print(f"\n{message}", file=sys.stderr)
        notify("GitHub repository creation failed", f"Local project kept at {result['destination']}. {result['github_error']}")
        return 1
    if github:
        print(f"Created and pushed {visibility} GitHub repository.")
    return 0


def open_pane():
    dispatcher.herdr(
        "plugin", "pane", "open",
        "--plugin", os.environ.get("HERDR_PLUGIN_ID", "wheels.dev-workflow"),
        "--entrypoint", "new-blank-project",
        "--cwd", str(Path.home()),
        "--focus",
    )
    return 0


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("open-pane", "interactive"))
    return parser.parse_args()


def main():
    args = parse_args()
    try:
        return open_pane() if args.command == "open-pane" else interactive()
    except Cancelled:
        print("\nProject creation cancelled. No changes were made.")
        return 0
    except ProjectFailure as error:
        print(str(error), file=sys.stderr)
        if sys.stdin.isatty():
            try:
                input("\nPress enter to close...")
            except (EOFError, KeyboardInterrupt):
                pass
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
