#!/usr/bin/env python3

import argparse
import contextlib
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import sys
import time


PLUGIN_ID = os.environ.get("HERDR_PLUGIN_ID", "wheels.dev-workflow")
SOURCE = f"plugin:{PLUGIN_ID}"


def canonical(path):
    return os.path.realpath(os.path.abspath(path))


class GitFailure(RuntimeError):
    def __init__(self, command, result=None, message=None):
        self.command = command
        self.result = result
        self.message = message or "Git command failed"
        super().__init__(self.message)

    def record(self):
        return {
            "message": self.message,
            "command": shlex.join(self.command),
            "exit_code": None if self.result is None else self.result.returncode,
            "stdout": "" if self.result is None else self.result.stdout,
            "stderr": "" if self.result is None else self.result.stderr,
        }


def state_dir():
    return Path(os.environ.get("HERDR_PLUGIN_STATE_DIR", Path.home() / ".local/state/herdr-dev-workflow"))


def log_event(kind, **fields):
    try:
        root = state_dir()
        root.mkdir(parents=True, exist_ok=True)
        path = root / "lifecycle.jsonl"
        lock_path = root / "locks" / "lifecycle-log.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "pid": os.getpid(),
            "kind": kind,
            **fields,
        }
        line = json.dumps(record, sort_keys=True, default=str) + "\n"
        with lock_path.open("a+") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            if path.exists() and path.stat().st_size >= 5 * 1024 * 1024:
                backup = path.with_suffix(".jsonl.1")
                backup.unlink(missing_ok=True)
                os.replace(path, backup)
            with path.open("a") as stream:
                stream.write(line)
    except OSError:
        pass


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    os.replace(temporary, path)


def run(command, check=True):
    log_event("command.started", command=command)
    try:
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as error:
        log_event("command.spawn_failed", command=command, error=str(error))
        raise
    log_event(
        "command.finished",
        command=command,
        exit_code=result.returncode,
        stdout=result.stdout,
        stderr=result.stderr,
    )
    if check and result.returncode:
        raise GitFailure(command, result)
    return result


def git(repo, *args, check=True):
    return run(["git", "-C", str(repo), *args], check=check)


def herdr(*args, check=True):
    binary = os.environ.get("HERDR_BIN_PATH", "herdr")
    result = run([binary, *args], check=False)
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or f"herdr {' '.join(args)} failed")
    return result


def response_result(output):
    data = json.loads(output)
    if "error" in data:
        raise RuntimeError(json.dumps(data["error"], sort_keys=True))
    return data.get("result", {})


def notify(title, body):
    log_event("notification", title=title, body=body)
    herdr("notification", "show", title[:80], "--body", body[:240], "--sound", "none", check=False)


def worktrees(repo):
    records = []
    current = None
    result = git(repo, "worktree", "list", "--porcelain")
    for line in result.stdout.splitlines() + [""]:
        if not line:
            if current:
                records.append(current)
            current = None
        elif line.startswith("worktree "):
            current = {"path": line[9:], "locked": False}
        elif current is not None and line.startswith("branch refs/heads/"):
            current["branch"] = line[18:]
        elif current is not None and (line == "locked" or line.startswith("locked ")):
            current["locked"] = True
    return records


def record_for_path(repo, checkout):
    checkout = canonical(checkout)
    return next((item for item in worktrees(repo) if canonical(item["path"]) == checkout), None)


def primary_record(repo):
    if git(repo, "rev-parse", "--is-bare-repository").stdout.strip() == "true":
        return None
    records = worktrees(repo)
    return records[0] if records else None


def default_branches(repo):
    protected = {"main", "master"}
    symbolic = git(repo, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD", check=False)
    if symbolic.returncode == 0:
        protected.add(symbolic.stdout.strip().removeprefix("refs/remotes/origin/"))
    primary = primary_record(repo)
    if primary and primary.get("branch"):
        protected.add(primary["branch"])
    protected.update(filter(None, os.environ.get("HERDR_PROTECTED_BRANCHES", "").split(",")))
    return protected


def upstream_for_branch(repo, branch):
    result = git(
        repo,
        "for-each-ref",
        "--format=%(upstream:remotename)%09%(upstream:remoteref)",
        f"refs/heads/{branch}",
    )
    line = result.stdout.strip()
    if line:
        remote, remote_ref = (line.split("\t", 1) + [""])[:2]
        prefix = "refs/heads/"
        if not remote or not remote_ref.startswith(prefix):
            raise GitFailure(
                ["git", "-C", str(repo), "for-each-ref", f"refs/heads/{branch}"],
                message=f"Invalid upstream metadata for branch {branch!r}: {line!r}",
            )
        return remote, remote_ref[len(prefix):]
    remote = git(repo, "remote", "get-url", "origin", check=False)
    return ("origin", branch) if remote.returncode == 0 else (None, None)


def remote_branch_exists(repo, remote, branch):
    command = ["git", "-C", str(repo), "ls-remote", "--exit-code", "--heads", remote, f"refs/heads/{branch}"]
    result = run(command, check=False)
    if result.returncode == 0:
        return True
    if result.returncode == 2 and not result.stdout.strip():
        return False
    raise GitFailure(command, result, "Could not determine whether the remote branch exists")


def local_branch_exists(repo, branch):
    command = ["git", "-C", str(repo), "show-ref", "--verify", "--quiet", f"refs/heads/{branch}"]
    result = run(command, check=False)
    if result.returncode == 0:
        return True
    if result.returncode == 1:
        return False
    raise GitFailure(command, result, "Could not determine whether the local branch exists")


def job_id(repo, checkout, branch):
    value = "\0".join((canonical(repo), canonical(checkout), branch))
    return hashlib.sha256(value.encode()).hexdigest()[:24]


def jobs_dir():
    return state_dir() / "cleanup-jobs"


def job_path(identifier):
    return jobs_dir() / f"{identifier}.json"


def completion_path(event_key):
    identifier = hashlib.sha256(event_key.encode()).hexdigest()[:24]
    return state_dir() / "cleanup-completions" / f"{identifier}.json"


def mark_recent_completion(event_key):
    path = completion_path(event_key)
    atomic_json(path, {"event_key": event_key, "completed_at": time.time()})
    log_event("cleanup.completion_marked", event_key=event_key)


def recently_completed(event_key):
    if not event_key:
        return False
    path = completion_path(event_key)
    if not path.exists():
        return False
    try:
        completed_at = json.loads(path.read_text()).get("completed_at", 0)
    except (OSError, json.JSONDecodeError):
        completed_at = 0
    if time.time() - completed_at <= 60:
        return True
    path.unlink(missing_ok=True)
    return False


def save_job(job):
    job["updated_at"] = int(time.time())
    atomic_json(job_path(job["id"]), job)
    log_event(
        "cleanup.job_saved",
        job_id=job["id"],
        repo_root=job.get("repo_root"),
        checkout_path=job.get("checkout_path"),
        branch=job.get("branch"),
        remote=job.get("remote"),
        remote_branch=job.get("remote_branch"),
        phase=job.get("phase"),
        error=job.get("error"),
    )


def load_jobs():
    jobs = []
    for path in sorted(jobs_dir().glob("*.json")) if jobs_dir().exists() else []:
        try:
            job = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        jobs.append(job)
    return jobs


def remember_root(repo):
    path = state_dir() / "repository-roots.json"
    lock_path = state_dir() / "locks" / "repository-roots.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        roots = []
        if path.exists():
            try:
                roots = json.loads(path.read_text()).get("roots", [])
            except (OSError, json.JSONDecodeError):
                pass
        absolute = canonical(repo)
        if absolute not in roots:
            roots.append(absolute)
            atomic_json(path, {"roots": sorted(roots)})


def known_roots():
    path = state_dir() / "repository-roots.json"
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text()).get("roots", [])
    except (OSError, json.JSONDecodeError):
        return []


def create_job(repo, checkout, branch, source, label="", event_key=""):
    repo = canonical(repo)
    checkout = canonical(checkout)
    identifier = job_id(repo, checkout, branch)
    existing = job_path(identifier)
    if existing.exists():
        log_event("cleanup.job_reused", job_id=identifier, source=source)
        return json.loads(existing.read_text())
    job = {
        "id": identifier,
        "repo_root": repo,
        "checkout_path": checkout,
        "branch": branch,
        "label": label or os.path.basename(checkout),
        "source": source,
        "event_key": event_key,
        "phase": "validate",
        "remote": None,
        "remote_branch": None,
        "error": None,
        "created_at": int(time.time()),
    }
    save_job(job)
    log_event("cleanup.job_created", job_id=identifier, source=source, label=job["label"])
    return job


def validate_job(job):
    repo = job["repo_root"]
    checkout = job["checkout_path"]
    branch = job.get("branch", "")
    log_event("cleanup.validation_started", job_id=job["id"], repo_root=repo, checkout_path=checkout, branch=branch)
    if not branch:
        raise GitFailure([], message="Event metadata did not include a branch; cleanup stopped rather than guessing")
    bare = git(repo, "rev-parse", "--is-bare-repository").stdout.strip() == "true"
    if not bare:
        top = git(repo, "rev-parse", "--show-toplevel").stdout.strip()
        if canonical(top) != canonical(repo):
            raise GitFailure([], message=f"Repository root mismatch: expected {repo!r}, Git reported {top!r}")
    primary = primary_record(repo)
    if not bare and not primary:
        raise GitFailure([], message=f"No primary checkout found for {repo}")
    if primary and canonical(primary["path"]) == canonical(checkout):
        raise GitFailure([], message=f"Refusing to remove primary checkout {checkout}")
    if branch in default_branches(repo):
        raise GitFailure([], message=f"Refusing to remove protected branch {branch}")
    current = record_for_path(repo, checkout)
    if current and current.get("branch") != branch:
        raise GitFailure([], message=f"Worktree metadata mismatch: {checkout} has {current.get('branch')!r}, expected {branch!r}")
    if not current and os.path.exists(checkout):
        raise GitFailure([], message=f"Path exists but is not the expected registered worktree: {checkout}")
    remote, remote_branch = upstream_for_branch(repo, branch)
    if remote_branch and remote_branch in default_branches(repo):
        raise GitFailure([], message=f"Refusing to remove protected upstream branch {remote}/{remote_branch}")
    job.update({
        "remote": remote,
        "remote_branch": remote_branch,
        "phase": "remote",
        "error": None,
    })
    save_job(job)
    log_event(
        "cleanup.validation_succeeded",
        job_id=job["id"],
        remote=remote,
        remote_branch=remote_branch,
    )


def run_phase(job):
    repo = job["repo_root"]
    checkout = job["checkout_path"]
    branch = job["branch"]
    phase = job["phase"]
    log_event("cleanup.phase_started", job_id=job["id"], phase=phase)
    if branch in default_branches(repo):
        raise GitFailure([], message=f"Refusing to remove protected branch {branch}")
    if job.get("remote_branch") in default_branches(repo):
        raise GitFailure(
            [],
            message=f"Refusing to remove protected upstream branch {job.get('remote')}/{job['remote_branch']}",
        )
    if phase == "remote":
        remote = job.get("remote")
        remote_branch = job.get("remote_branch")
        if remote and remote_branch and remote_branch_exists(repo, remote, remote_branch):
            git(repo, "push", remote, "--delete", remote_branch)
        job["phase"] = "checkout"
    elif phase == "checkout":
        current = record_for_path(repo, checkout)
        if current:
            if current.get("branch") != branch:
                raise GitFailure([], message=f"Worktree path/branch mismatch: {checkout} now has {current.get('branch')!r}")
            if current.get("locked"):
                git(repo, "worktree", "unlock", checkout)
            git(repo, "worktree", "remove", "--force", checkout)
        elif os.path.exists(checkout):
            raise GitFailure([], message=f"Path exists without matching worktree metadata: {checkout}")
        job["phase"] = "branch"
    elif phase == "branch":
        if local_branch_exists(repo, branch):
            git(repo, "branch", "-D", branch)
        job["phase"] = "prune"
    elif phase == "prune":
        git(repo, "worktree", "prune", "--expire", "now")
        job_path(job["id"]).unlink(missing_ok=True)
        log_event("cleanup.completed", job_id=job["id"])
        return
    job["error"] = None
    save_job(job)
    log_event("cleanup.phase_succeeded", job_id=job["id"], phase=phase, next_phase=job["phase"])


@contextlib.contextmanager
def repository_lock(repo):
    lock_id = hashlib.sha256(canonical(repo).encode()).hexdigest()[:24]
    path = state_dir() / "locks" / f"{lock_id}.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def close_reopened_workspace(job):
    if not os.environ.get("HERDR_SOCKET_PATH"):
        return
    try:
        listing = response_result(
            herdr("worktree", "list", "--cwd", job["repo_root"], "--json").stdout
        )
        for tree in listing.get("worktrees", []):
            if canonical(tree.get("path", "")) != canonical(job["checkout_path"]):
                continue
            workspace_id = tree.get("open_workspace_id")
            if workspace_id:
                log_event(
                    "cleanup.reopened_workspace_closing",
                    job_id=job["id"],
                    workspace_id=workspace_id,
                    checkout_path=job["checkout_path"],
                )
                herdr("workspace", "close", workspace_id)
    except (RuntimeError, OSError, json.JSONDecodeError) as error:
        raise GitFailure([], message=f"Could not close a workspace reopened during cleanup: {error}") from error


def attempt_locked(job):
    path = job_path(job["id"])
    if not path.exists():
        log_event("cleanup.already_complete", job_id=job["id"])
        return True
    latest = json.loads(path.read_text())
    log_event("cleanup.attempt_started", job_id=latest["id"], phase=latest.get("phase"))
    try:
        if latest.get("phase") == "validate":
            validate_job(latest)
        close_reopened_workspace(latest)
        while job_path(latest["id"]).exists():
            run_phase(latest)
        log_event("cleanup.attempt_succeeded", job_id=latest["id"])
        return True
    except GitFailure as error:
        latest["error"] = error.record()
        save_job(latest)
        log_event("cleanup.attempt_failed", job_id=latest["id"], phase=latest.get("phase"), error=latest["error"])
        notify("Worktree cleanup failed", f"{latest['label']}: {error.message}. Use Show cleanup failures for details.")
        return False


def attempt(job):
    with repository_lock(job["repo_root"]):
        return attempt_locked(job)


def enqueue(repo, checkout, branch, source="manual", label="", event_key=""):
    remember_root(repo)
    with repository_lock(repo):
        if not branch and recently_completed(event_key):
            log_event(
                "cleanup.branchless_job_skipped_after_completion",
                event_key=event_key,
                repo_root=repo,
                checkout_path=checkout,
            )
            return True
        replaced = []
        if branch:
            for pending in load_jobs():
                if (
                    not pending.get("branch")
                    and (
                        (event_key and pending.get("event_key") == event_key)
                        or (
                            canonical(pending.get("repo_root", "")) == canonical(repo)
                            and canonical(pending.get("checkout_path", "")) == canonical(checkout)
                        )
                    )
                ):
                    replaced.append(pending["id"])
        job = create_job(repo, checkout, branch, source, label, event_key)
        for identifier in replaced:
            job_path(identifier).unlink(missing_ok=True)
            log_event("cleanup.branchless_job_replaced", job_id=identifier, replacement_job_id=job["id"])
        succeeded = attempt_locked(job)
        if succeeded and event_key:
            mark_recent_completion(event_key)
        return succeeded


def event_metadata(envelope):
    data = envelope.get("data", {})
    event = os.environ.get("HERDR_PLUGIN_EVENT") or envelope.get("event")
    try:
        context = json.loads(os.environ.get("HERDR_PLUGIN_CONTEXT_JSON", "{}"))
    except json.JSONDecodeError:
        context = {}
    if event == "workspace.closed":
        workspace = data.get("workspace") or {}
        event_key = data.get("workspace_id") or workspace.get("workspace_id") or ""
        provenance = workspace.get("worktree") or {}
        if not provenance.get("is_linked_worktree"):
            return None
        repo = provenance.get("repo_root")
        checkout = provenance.get("checkout_path")
        if not repo or not checkout:
            raise ValueError("workspace.closed linked-worktree metadata is incomplete")
        record = record_for_path(repo, checkout)
        branch = record.get("branch", "") if record else ""
        return repo, checkout, branch, workspace.get("label", ""), event_key
    if event == "worktree.removed":
        tree = data.get("worktree") or {}
        workspace = data.get("workspace") or {}
        event_key = data.get("workspace_id") or workspace.get("workspace_id") or ""
        provenance = workspace.get("worktree") or {}
        checkout = tree.get("path")
        branch = tree.get("branch")
        context_provenance = context.get("worktree") or {}
        repo = provenance.get("repo_root") or context_provenance.get("repo_root")
        if not repo or not checkout or not branch or not tree.get("is_linked_worktree"):
            raise ValueError("worktree.removed linked-worktree metadata is incomplete")
        if provenance and canonical(provenance.get("checkout_path", "")) != canonical(checkout):
            raise ValueError("event workspace/worktree path mismatch")
        return repo, checkout, branch, tree.get("label", ""), event_key
    return None


def handle_event():
    try:
        envelope = json.loads(os.environ.get("HERDR_PLUGIN_EVENT_JSON", "{}"))
        log_event(
            "hook.received",
            event=os.environ.get("HERDR_PLUGIN_EVENT") or envelope.get("event"),
            payload=envelope,
        )
        metadata = event_metadata(envelope)
        if metadata is None:
            log_event("hook.ignored", reason="not a linked-worktree cleanup event")
            return 0
        repo, checkout, branch, label, event_key = metadata
        if not branch:
            if recently_completed(event_key):
                log_event(
                    "hook.branchless_event_ignored_after_completion",
                    repo_root=repo,
                    checkout_path=checkout,
                    event_key=event_key,
                )
                return 0
            matching = next(
                (
                    job for job in load_jobs()
                    if canonical(job.get("repo_root", "")) == canonical(repo)
                    and canonical(job.get("checkout_path", "")) == canonical(checkout)
                ),
                None,
            )
            log_event(
                "hook.branchless_event",
                repo_root=repo,
                checkout_path=checkout,
                matched_job=None if matching is None else matching["id"],
            )
            if matching is not None:
                return 0 if attempt(matching) else 1
            return 0 if enqueue(
                repo,
                checkout,
                "",
                source=os.environ.get("HERDR_PLUGIN_EVENT", "event"),
                label=label,
                event_key=event_key,
            ) else 1
        succeeded = enqueue(
            repo,
            checkout,
            branch,
            source=os.environ.get("HERDR_PLUGIN_EVENT", "event"),
            label=label,
            event_key=event_key,
        )
        return 0 if succeeded else 1
    except (ValueError, KeyError, json.JSONDecodeError, GitFailure) as error:
        log_event("hook.rejected", error=str(error))
        notify("Worktree cleanup rejected", str(error))
        print(str(error), file=sys.stderr)
        return 1


def retry_pending():
    pending = load_jobs()
    branch_event_keys = {job.get("event_key") for job in pending if job.get("branch") and job.get("event_key")}
    for job in pending:
        if not job.get("branch") and job.get("event_key") in branch_event_keys:
            job_path(job["id"]).unlink(missing_ok=True)
            log_event("cleanup.obsolete_branchless_job_removed", job_id=job["id"], event_key=job.get("event_key"))
    pending = load_jobs()
    log_event("cleanup.retry_all_started", job_ids=[job["id"] for job in pending])
    failures = 0
    for job in pending:
        failures += not attempt(job)
    if pending:
        notify(
            "Cleanup retry complete" if not failures else "Cleanup failures remain",
            f"Attempted {len(pending)} cleanup job(s); {failures} remain failed.",
        )
    log_event("cleanup.retry_all_finished", attempted=len(pending), failures=failures)
    return failures == 0


def show_failures():
    pending = load_jobs()
    print(f"Lifecycle log: {state_dir() / 'lifecycle.jsonl'}")
    if not pending:
        print("\nNo pending worktree cleanup failures.")
        return 0
    print(f"\nPending worktree cleanup jobs: {len(pending)}\n")
    for job in pending:
        error = job.get("error") or {}
        print(f"{job.get('label')} [{job.get('phase')}]")
        print(f"  repo:   {job.get('repo_root')}")
        print(f"  path:   {job.get('checkout_path')}")
        print(f"  branch: {job.get('branch') or '(missing)'}")
        print(f"  error:  {error.get('message', 'pending retry')}")
        if error.get("command"):
            print(f"  command: {error['command']}")
            print(f"  exit:    {error.get('exit_code')}")
        if error.get("stdout"):
            print("  stdout:")
            print(error["stdout"].rstrip())
        if error.get("stderr"):
            print("  stderr:")
            print(error["stderr"].rstrip())
        print()
    return 1


def show_failures_pane():
    status = show_failures()
    try:
        input("Press enter to close...")
    except EOFError:
        pass
    return status


def show_log_pane():
    path = state_dir() / "lifecycle.jsonl"
    print(f"Lifecycle log: {path}\n")
    if not path.exists():
        print("No lifecycle log entries yet.")
    else:
        lines = path.read_text(errors="replace").splitlines()
        for line in lines[-1000:]:
            print(line)
        if len(lines) > 1000:
            print(f"\nShowing the newest 1000 of {len(lines)} entries. The file contains the full current log.")
        if path.with_suffix(".jsonl.1").exists():
            print(f"Rotated log: {path.with_suffix('.jsonl.1')}")
    try:
        input("\nPress enter to close...")
    except EOFError:
        pass
    return 0


def socket_request(method, params):
    path = os.environ.get("HERDR_SOCKET_PATH")
    if not path:
        raise RuntimeError("HERDR_SOCKET_PATH is not set")
    request = json.dumps({"id": f"{PLUGIN_ID}-{os.getpid()}", "method": method, "params": params}) + "\n"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.connect(path)
        connection.sendall(request.encode())
        stream = connection.makefile()
        response = json.loads(stream.readline())
    if "error" in response:
        raise RuntimeError(json.dumps(response["error"], sort_keys=True))
    return response.get("result", {})


def apply_agent_view():
    socket_request(
        "agent.view.set",
        {
            "source": SOURCE,
            "label": "workspaces",
            "sort": [
                {"field": "workspace_order", "order": "asc"},
                {"field": "tab_order", "order": "asc"},
                {"field": "pane_order", "order": "asc"},
            ],
        },
    )


def live_workspaces():
    output = herdr("workspace", "list").stdout
    return response_result(output).get("workspaces", [])


def report_agent_metadata(workspaces):
    by_id = {workspace["workspace_id"]: workspace for workspace in workspaces}
    agents = response_result(herdr("agent", "list").stdout).get("agents", [])
    for agent in agents:
        workspace = by_id.get(agent.get("workspace_id"), {})
        provenance = workspace.get("worktree") or {}
        repo = provenance.get("repo_name") or workspace.get("label", "")
        branch = ""
        checkout = provenance.get("checkout_path")
        repo_root = provenance.get("repo_root")
        if checkout and repo_root:
            record = record_for_path(repo_root, checkout)
            branch = (record or {}).get("branch", "")
        elif agent.get("foreground_cwd") or agent.get("cwd"):
            cwd = agent.get("foreground_cwd") or agent["cwd"]
            discovered_root = git(cwd, "rev-parse", "--show-toplevel", check=False)
            discovered_branch = git(cwd, "symbolic-ref", "--quiet", "--short", "HEAD", check=False)
            if discovered_root.returncode == 0:
                repo = Path(discovered_root.stdout.strip()).name
            if discovered_branch.returncode == 0:
                branch = discovered_branch.stdout.strip()
        arguments = [
            "pane", "report-metadata", agent["pane_id"], "--source", SOURCE,
            "--token", f"repo={repo}",
        ]
        if branch:
            arguments.extend(("--token", f"branch={branch}"))
        else:
            arguments.extend(("--clear-token", "branch"))
        herdr(*arguments)


def reconcile():
    log_event("reconciliation.started")
    workspaces = live_workspaces()
    for workspace in workspaces:
        provenance = workspace.get("worktree") or {}
        if provenance.get("repo_root"):
            remember_root(provenance["repo_root"])
    errors = []
    for repo in known_roots():
        if not Path(repo).is_dir():
            continue
        try:
            with repository_lock(repo):
                pending_paths = {
                    canonical(job["checkout_path"])
                    for job in load_jobs()
                    if canonical(job["repo_root"]) == canonical(repo)
                }
                listing = response_result(herdr("worktree", "list", "--cwd", repo, "--json").stdout)
                for tree in listing.get("worktrees", []):
                    path = canonical(tree.get("path", ""))
                    if (
                        not tree.get("is_linked_worktree")
                        or tree.get("open_workspace_id")
                        or path in pending_paths
                        or not Path(path).is_dir()
                    ):
                        continue
                    try:
                        log_event("reconciliation.opening_worktree", repo_root=repo, checkout_path=path)
                        opened = response_result(
                            herdr(
                                "worktree", "open", "--cwd", repo, "--path", path,
                                "--label", tree.get("label") or Path(path).name, "--no-focus", "--json",
                            ).stdout
                        )
                        workspace = opened.get("workspace", {})
                        if workspace.get("workspace_id"):
                            script = Path(__file__).with_name("dev-workflow.sh")
                            run(
                                [
                                    str(script),
                                    "setup-workspace",
                                    workspace["workspace_id"],
                                    path,
                                    tree.get("label") or Path(path).name,
                                ]
                            )
                    except (RuntimeError, GitFailure, OSError, json.JSONDecodeError) as error:
                        log_event("reconciliation.worktree_failed", repo_root=repo, checkout_path=path, error=str(error))
                        errors.append(f"{path}: {error}")
        except (RuntimeError, GitFailure, OSError, json.JSONDecodeError) as error:
            log_event("reconciliation.repository_failed", repo_root=repo, error=str(error))
            errors.append(f"{repo}: {error}")
    try:
        report_agent_metadata(live_workspaces())
    except (RuntimeError, GitFailure, OSError, json.JSONDecodeError) as error:
        errors.append(f"agent metadata: {error}")
    if errors:
        log_event("reconciliation.failed", errors=errors)
        raise RuntimeError("; ".join(errors))
    log_event("reconciliation.succeeded")


def startup():
    log_event("startup.started")
    retry_pending()
    try:
        reconcile()
        apply_agent_view()
    except (RuntimeError, GitFailure, OSError, json.JSONDecodeError) as error:
        log_event("startup.failed", error=str(error))
        notify("Workflow startup reconciliation failed", str(error))
        print(str(error), file=sys.stderr)
        return 1
    pending = load_jobs()
    if pending:
        notify("Worktree cleanup pending", f"{len(pending)} cleanup job(s) still require attention.")
    log_event("startup.succeeded", pending_jobs=len(pending))
    return 0


def parse_args():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("event")
    subparsers.add_parser("startup")
    subparsers.add_parser("retry")
    subparsers.add_parser("show")
    subparsers.add_parser("show-pane")
    subparsers.add_parser("show-log-pane")
    subparsers.add_parser("metadata")
    enqueue_parser = subparsers.add_parser("enqueue")
    enqueue_parser.add_argument("repo")
    enqueue_parser.add_argument("checkout")
    enqueue_parser.add_argument("branch")
    enqueue_parser.add_argument("--label", default="")
    return parser.parse_args()


def main():
    args = parse_args()
    if args.command == "event":
        return handle_event()
    if args.command == "startup":
        return startup()
    if args.command == "retry":
        return 0 if retry_pending() else 1
    if args.command == "show":
        return show_failures()
    if args.command == "show-pane":
        return show_failures_pane()
    if args.command == "show-log-pane":
        return show_log_pane()
    if args.command == "metadata":
        report_agent_metadata(live_workspaces())
        return 0
    if args.command == "enqueue":
        return 0 if enqueue(args.repo, args.checkout, args.branch, label=args.label) else 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
