#!/usr/bin/env python3

import argparse
from concurrent.futures import as_completed, ThreadPoolExecutor
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


def run(command, check=True, cwd=None):
    log_event("command.started", command=command, cwd=cwd)
    try:
        result = subprocess.run(command, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as error:
        log_event("command.spawn_failed", command=command, error=str(error))
        raise
    log_event(
        "command.finished",
        command=command,
        cwd=cwd,
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


def primary_repository(path):
    common = git(path, "rev-parse", "--path-format=absolute", "--git-common-dir", check=False)
    if common.returncode:
        return None
    common_path = Path(canonical(common.stdout.strip()))
    if common_path.name == ".git":
        return canonical(common_path.parent)
    bare = git(path, "rev-parse", "--is-bare-repository", check=False)
    return canonical(common_path) if bare.returncode == 0 and bare.stdout.strip() == "true" else None


def live_panes():
    output = herdr("pane", "list").stdout
    return response_result(output).get("panes", [])


def adopt_current_workspaces(workspaces=None, panes=None, *, announce=True):
    workspaces = live_workspaces() if workspaces is None else workspaces
    panes = live_panes() if panes is None else panes
    roots = set(known_roots())
    for workspace in workspaces:
        provenance = workspace.get("worktree") or {}
        if provenance.get("repo_root"):
            roots.add(canonical(provenance["repo_root"]))
    for pane in panes:
        cwd = pane.get("foreground_cwd") or pane.get("cwd")
        if cwd:
            root = primary_repository(cwd)
            if root:
                roots.add(root)
    for root in roots:
        remember_root(root)
    linked = 0
    for root in roots:
        try:
            primary = primary_record(root)
            primary_path = canonical(primary["path"]) if primary else None
            linked += sum(canonical(item["path"]) != primary_path for item in worktrees(root))
        except (GitFailure, OSError):
            continue
    log_event("adoption.completed", repositories=len(roots), linked_worktrees=linked, roots=sorted(roots))
    if announce:
        notify("Workspaces adopted", f"Tracking {len(roots)} repositories and {linked} linked worktrees.")
    return {"repositories": len(roots), "linked_worktrees": linked, "roots": sorted(roots)}


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


def running_session_count():
    result = herdr("session", "list", "--json")
    try:
        sessions = json.loads(result.stdout).get("sessions", [])
    except json.JSONDecodeError as error:
        raise GitFailure([], message=f"Invalid Herdr session list JSON: {error}") from error
    return sum(bool(session.get("running")) for session in sessions)


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


def auto_prune_blocks_path():
    return state_dir() / "auto-prune-blocks.json"


def load_auto_prune_blocks():
    path = auto_prune_blocks_path()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text()).get("blocks", {})
    except (OSError, json.JSONDecodeError):
        return {}


def auto_prune_key(repo, checkout, branch, head_oid):
    value = "\0".join((canonical(repo), canonical(checkout), branch, head_oid))
    return hashlib.sha256(value.encode()).hexdigest()[:24]


def block_auto_prune(repo, checkout, branch, head_oid, pull_request, reasons):
    path = auto_prune_blocks_path()
    lock_path = state_dir() / "locks" / "auto-prune-blocks.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    key = auto_prune_key(repo, checkout, branch, head_oid)
    with lock_path.open("a+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        blocks = load_auto_prune_blocks()
        if key in blocks:
            return False
        blocks[key] = {
            "repo_root": canonical(repo),
            "checkout_path": canonical(checkout),
            "branch": branch,
            "head_oid": head_oid,
            "pull_request": pull_request,
            "reasons": reasons,
            "created_at": int(time.time()),
        }
        atomic_json(path, {"blocks": blocks})
    return True


def merged_pull_request(repo, branch, head_oid):
    command = [
        "gh", "pr", "list",
        "--state", "merged",
        "--head", branch,
        "--limit", "20",
        "--json", "number,url,mergedAt,headRefName,headRefOid,isCrossRepository",
    ]
    result = run(command, check=False, cwd=repo)
    if result.returncode:
        raise GitFailure(command, result, "Could not query merged pull requests")
    try:
        pull_requests = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise GitFailure(command, result, f"Invalid GitHub pull request JSON: {error}") from error
    return next(
        (
            pull_request for pull_request in pull_requests
            if pull_request.get("mergedAt")
            and pull_request.get("headRefName") == branch
            and pull_request.get("headRefOid") == head_oid
            and pull_request.get("isCrossRepository") is False
        ),
        None,
    )


def checkout_is_dirty(checkout):
    result = git(checkout, "status", "--porcelain", "--untracked-files=all")
    return bool(result.stdout.strip())


def scan_merged_pull_requests():
    workspaces = live_workspaces()
    adoption = adopt_current_workspaces(workspaces, live_panes(), announce=False)
    workspace_by_checkout = {
        canonical(provenance["checkout_path"]): workspace
        for workspace in workspaces
        for provenance in [workspace.get("worktree") or {}]
        if provenance.get("is_linked_worktree") and provenance.get("checkout_path")
    }
    blocks = load_auto_prune_blocks()
    sessions = running_session_count()
    checked = pruned = blocked = failures = 0
    for repo in adoption["roots"]:
        try:
            primary = primary_record(repo)
            primary_path = canonical(primary["path"]) if primary else None
            records = worktrees(repo)
        except (GitFailure, OSError) as error:
            failures += 1
            log_event("auto_prune.repository_failed", repo_root=repo, error=str(error))
            continue
        for record in records:
            checkout = canonical(record["path"])
            branch = record.get("branch", "")
            if checkout == primary_path or not branch.startswith("wheels/"):
                continue
            checked += 1
            head = git(repo, "rev-parse", f"refs/heads/{branch}", check=False)
            if head.returncode:
                continue
            head_oid = head.stdout.strip()
            key = auto_prune_key(repo, checkout, branch, head_oid)
            if key in blocks:
                blocked += 1
                continue
            try:
                pull_request = merged_pull_request(repo, branch, head_oid)
            except (GitFailure, OSError) as error:
                failures += 1
                log_event("auto_prune.github_failed", repo_root=repo, branch=branch, error=str(error))
                continue
            if not pull_request:
                continue
            workspace = workspace_by_checkout.get(checkout)
            reasons = []
            if sessions != 1:
                reasons.append("multiple Herdr sessions are running")
            if not workspace:
                reasons.append("worktree is not open in this Herdr session")
            elif workspace.get("focused"):
                reasons.append("workspace is focused")
            elif workspace.get("agent_status") not in {"idle", "done"}:
                reasons.append(f"agent is {workspace.get('agent_status', 'unknown')}")
            try:
                if checkout_is_dirty(checkout):
                    reasons.append("checkout has uncommitted changes")
            except (GitFailure, OSError) as error:
                reasons.append(f"checkout status failed: {error}")
            if reasons:
                blocked += 1
                if block_auto_prune(repo, checkout, branch, head_oid, pull_request, reasons):
                    notify(
                        "Merged worktree needs manual cleanup",
                        f"{branch}: {', '.join(reasons)}. Close it manually when ready.",
                    )
                log_event(
                    "auto_prune.blocked",
                    repo_root=repo,
                    checkout_path=checkout,
                    branch=branch,
                    pull_request=pull_request,
                    reasons=reasons,
                )
                continue
            try:
                herdr("workspace", "close", workspace["workspace_id"])
            except (RuntimeError, OSError) as error:
                failures += 1
                log_event("auto_prune.workspace_close_failed", workspace_id=workspace["workspace_id"], error=str(error))
                continue
            pruned += 1
            log_event(
                "auto_prune.started",
                repo_root=repo,
                checkout_path=checkout,
                branch=branch,
                pull_request=pull_request,
                via_workspace=True,
            )
    result = {"checked": checked, "pruned": pruned, "blocked": blocked, "failures": failures}
    log_event("auto_prune.scan_finished", **result)
    return result


def watch_merged_pull_requests():
    lock_path = state_dir() / "locks" / "auto-prune-watcher.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+") as handle:
        log_event("auto_prune.watcher_waiting")
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            interval = max(60, int(os.environ.get("HERDR_AUTO_PRUNE_INTERVAL_SECONDS", "3600")))
        except ValueError:
            interval = 3600
        log_event("auto_prune.watcher_started", interval_seconds=interval)
        while True:
            try:
                scan_merged_pull_requests()
            except (RuntimeError, GitFailure, OSError, json.JSONDecodeError) as error:
                log_event("auto_prune.scan_failed", error=str(error))
            deadline = time.monotonic() + interval
            while time.monotonic() < deadline:
                socket_path = os.environ.get("HERDR_SOCKET_PATH")
                if socket_path and not Path(socket_path).exists():
                    log_event("auto_prune.watcher_stopped", reason="Herdr socket disappeared")
                    return 0
                time.sleep(min(30, max(0, deadline - time.monotonic())))


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


def live_workspaces():
    output = herdr("workspace", "list").stdout
    return response_result(output).get("workspaces", [])


def worktree_label(tree, path):
    return Path(path).name or tree.get("branch") or tree.get("label") or "worktree"


def setup_workspaces(workspaces):
    if not workspaces:
        return
    script = Path(__file__).with_name("dev-workflow.sh")
    errors = []
    log_event("workspace_setup.batch_started", workspaces=len(workspaces))
    with ThreadPoolExecutor(max_workers=len(workspaces)) as executor:
        futures = {
            executor.submit(
                run,
                [str(script), "setup-workspace", workspace_id, path, label],
            ): path
            for workspace_id, path, label in workspaces
        }
        for future in as_completed(futures):
            path = futures[future]
            try:
                future.result()
            except (RuntimeError, GitFailure, OSError) as error:
                log_event("workspace_setup.failed", checkout_path=path, error=str(error))
                errors.append(f"{path}: {error}")
    log_event("workspace_setup.batch_finished", workspaces=len(workspaces), failures=len(errors))
    if errors:
        raise RuntimeError("; ".join(errors))


def reconcile():
    log_event("reconciliation.started")
    workspaces = live_workspaces()
    adoption = adopt_current_workspaces(workspaces, live_panes(), announce=False)
    errors = []
    setup = []
    for repo in adoption["roots"]:
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
                        label = worktree_label(tree, path)
                        log_event("reconciliation.opening_worktree", repo_root=repo, checkout_path=path)
                        opened = response_result(
                            herdr(
                                "worktree", "open", "--cwd", repo, "--path", path,
                                "--label", label, "--no-focus", "--json",
                            ).stdout
                        )
                        workspace = opened.get("workspace", {})
                        if workspace.get("workspace_id"):
                            setup.append((workspace["workspace_id"], path, label))
                    except (RuntimeError, GitFailure, OSError, json.JSONDecodeError) as error:
                        log_event("reconciliation.worktree_failed", repo_root=repo, checkout_path=path, error=str(error))
                        errors.append(f"{path}: {error}")
        except (RuntimeError, GitFailure, OSError, json.JSONDecodeError) as error:
            log_event("reconciliation.repository_failed", repo_root=repo, error=str(error))
            errors.append(f"{repo}: {error}")
    try:
        setup_workspaces(setup)
    except (RuntimeError, GitFailure, OSError) as error:
        errors.append(str(error))
    if errors:
        log_event("reconciliation.failed", errors=errors)
        raise RuntimeError("; ".join(errors))
    log_event("reconciliation.succeeded")


def startup():
    log_event("startup.started")
    retry_pending()
    try:
        reconcile()
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
    subparsers.add_parser("adopt")
    subparsers.add_parser("watch-merged")
    subparsers.add_parser("show")
    subparsers.add_parser("show-pane")
    subparsers.add_parser("show-log-pane")
    setup_parser = subparsers.add_parser("setup-workspaces")
    setup_parser.add_argument("--workspace", action="append", nargs=3, required=True)
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
    if args.command == "adopt":
        result = adopt_current_workspaces()
        print(json.dumps(result, sort_keys=True))
        return 0
    if args.command == "watch-merged":
        return watch_merged_pull_requests()
    if args.command == "show":
        return show_failures()
    if args.command == "show-pane":
        return show_failures_pane()
    if args.command == "show-log-pane":
        return show_log_pane()
    if args.command == "setup-workspaces":
        setup_workspaces(args.workspace)
        return 0
    if args.command == "enqueue":
        return 0 if enqueue(args.repo, args.checkout, args.branch, label=args.label) else 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
