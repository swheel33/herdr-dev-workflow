#!/usr/bin/env python3

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest import mock

import lifecycle


def command(*args, cwd=None, check=True):
    return subprocess.run(
        args,
        cwd=cwd,
        check=check,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


class LifecycleIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix="herdr-lifecycle-test-"))
        self.state = self.temp / "state"
        self.remote = self.temp / "remote.git"
        self.repo = self.temp / "repo"
        command("git", "init", "--bare", str(self.remote))
        command("git", "init", "-b", "main", str(self.repo))
        command("git", "config", "user.email", "test@example.com", cwd=self.repo)
        command("git", "config", "user.name", "Test User", cwd=self.repo)
        (self.repo / "README").write_text("initial\n")
        command("git", "add", "README", cwd=self.repo)
        command("git", "commit", "-m", "initial", cwd=self.repo)
        command("git", "remote", "add", "origin", str(self.remote), cwd=self.repo)
        command("git", "push", "-u", "origin", "main", cwd=self.repo)
        command("git", "symbolic-ref", "HEAD", "refs/heads/main", cwd=self.remote)
        self.environment = mock.patch.dict(
            os.environ,
            {
                "HERDR_PLUGIN_STATE_DIR": str(self.state),
                "HERDR_PROTECTED_BRANCHES": "",
            },
            clear=False,
        )
        self.environment.start()
        self.notifications = mock.patch.object(lifecycle, "notify")
        self.notifications.start()

    def tearDown(self):
        self.notifications.stop()
        self.environment.stop()
        shutil.rmtree(self.temp, ignore_errors=True)

    def add_worktree(self, branch="feature/test", dirty=False, push=True):
        checkout = self.temp / branch.replace("/", "-")
        command("git", "worktree", "add", "-b", branch, str(checkout), "main", cwd=self.repo)
        if push:
            command("git", "push", "-u", "origin", branch, cwd=checkout)
        if dirty:
            (checkout / "dirty.txt").write_text("discard me\n")
        return checkout

    def local_branch_exists(self, branch):
        return command(
            "git", "show-ref", "--verify", "--quiet", f"refs/heads/{branch}",
            cwd=self.repo, check=False,
        ).returncode == 0

    def remote_branch_exists(self, branch):
        result = command(
            "git", "ls-remote", "--exit-code", "--heads", "origin", f"refs/heads/{branch}",
            cwd=self.repo, check=False,
        )
        return result.returncode == 0

    def test_normal_close_removes_checkout_remote_local_and_metadata(self):
        checkout = self.add_worktree()
        self.assertTrue(lifecycle.enqueue(self.repo, checkout, "feature/test", label="test"))
        self.assertFalse(checkout.exists())
        self.assertFalse(self.local_branch_exists("feature/test"))
        self.assertFalse(self.remote_branch_exists("feature/test"))
        self.assertIsNone(lifecycle.record_for_path(self.repo, checkout))
        self.assertEqual(lifecycle.load_jobs(), [])

    def test_dirty_checkout_is_force_discarded(self):
        checkout = self.add_worktree("feature/dirty", dirty=True)
        self.assertTrue(lifecycle.enqueue(self.repo, checkout, "feature/dirty"))
        self.assertFalse(checkout.exists())

    def test_cleanup_writes_structured_command_and_phase_log(self):
        checkout = self.add_worktree("feature/logged")
        self.assertTrue(lifecycle.enqueue(self.repo, checkout, "feature/logged"))
        records = [json.loads(line) for line in (self.state / "lifecycle.jsonl").read_text().splitlines()]
        kinds = {record["kind"] for record in records}
        self.assertIn("cleanup.job_created", kinds)
        self.assertIn("cleanup.phase_started", kinds)
        self.assertIn("cleanup.completed", kinds)
        self.assertIn("command.finished", kinds)
        git_results = [
            record for record in records
            if record["kind"] == "command.finished" and record["command"][:1] == ["git"]
        ]
        self.assertTrue(git_results)
        self.assertTrue(all("exit_code" in record and "stdout" in record and "stderr" in record for record in git_results))

    def test_already_removed_worktree_event_finishes_branch_cleanup(self):
        checkout = self.add_worktree("feature/removed")
        command("git", "worktree", "remove", "--force", str(checkout), cwd=self.repo)
        self.assertTrue(lifecycle.enqueue(self.repo, checkout, "feature/removed"))
        self.assertFalse(self.local_branch_exists("feature/removed"))
        self.assertFalse(self.remote_branch_exists("feature/removed"))

    def test_duplicate_event_is_idempotent(self):
        checkout = self.add_worktree("feature/duplicate")
        self.assertTrue(lifecycle.enqueue(self.repo, checkout, "feature/duplicate"))
        self.assertTrue(lifecycle.enqueue(self.repo, checkout, "feature/duplicate"))
        self.assertEqual(lifecycle.load_jobs(), [])

    def test_primary_and_protected_branches_are_never_removed(self):
        primary_job = lifecycle.create_job(self.repo, self.repo, "main", "test")
        self.assertFalse(lifecycle.attempt(primary_job))
        self.assertTrue(self.repo.exists())
        self.assertTrue(self.local_branch_exists("main"))

        checkout = self.add_worktree("develop", push=False)
        with mock.patch.dict(os.environ, {"HERDR_PROTECTED_BRANCHES": "develop"}):
            protected_job = lifecycle.create_job(self.repo, checkout, "develop", "test")
            self.assertFalse(lifecycle.attempt(protected_job))
        self.assertTrue(checkout.exists())
        self.assertTrue(self.local_branch_exists("develop"))

    def test_protected_upstream_is_never_deleted(self):
        checkout = self.add_worktree("feature/tracks-main", push=False)
        command("git", "branch", "--set-upstream-to", "origin/main", cwd=checkout)
        job = lifecycle.create_job(self.repo, checkout, "feature/tracks-main", "test")
        self.assertFalse(lifecycle.attempt(job))
        self.assertTrue(self.remote_branch_exists("main"))
        self.assertTrue(checkout.exists())

    def test_failure_persists_full_git_error_and_manual_retry_resumes(self):
        checkout = self.add_worktree("feature/retry")
        command("git", "remote", "set-url", "origin", str(self.temp / "missing.git"), cwd=self.repo)
        self.assertFalse(lifecycle.enqueue(self.repo, checkout, "feature/retry"))
        failed = lifecycle.load_jobs()[0]
        self.assertEqual(failed["phase"], "remote")
        self.assertIn("ls-remote", failed["error"]["command"])
        self.assertIsNotNone(failed["error"]["exit_code"])
        self.assertTrue(failed["error"]["stderr"])

        command("git", "remote", "set-url", "origin", str(self.remote), cwd=self.repo)
        self.assertTrue(lifecycle.retry_pending())
        self.assertEqual(lifecycle.load_jobs(), [])
        self.assertFalse(checkout.exists())

    def test_workspace_closed_and_removed_payloads_share_cleanup(self):
        checkout = self.add_worktree("feature/event")
        workspace = {
            "workspace_id": "w-event",
            "label": "event",
            "worktree": {
                "repo_root": str(self.repo),
                "checkout_path": str(checkout),
                "is_linked_worktree": True,
            },
        }
        with mock.patch.dict(os.environ, {"HERDR_PLUGIN_EVENT": "workspace.closed"}):
            metadata = lifecycle.event_metadata({"data": {"workspace": workspace}})
        self.assertEqual(metadata[:3], (str(self.repo), str(checkout), "feature/event"))

        removed = {
            "data": {
                "workspace_id": "w-event",
                "workspace": workspace,
                "worktree": {
                    "path": str(checkout),
                    "branch": "feature/event",
                    "label": "event",
                    "is_linked_worktree": True,
                },
            }
        }
        with mock.patch.dict(os.environ, {"HERDR_PLUGIN_EVENT": "worktree.removed"}):
            self.assertEqual(lifecycle.event_metadata(removed), metadata)

    def test_paired_events_after_core_removal_do_not_leave_branchless_job(self):
        checkout = self.add_worktree("feature/paired")
        command("git", "worktree", "remove", "--force", str(checkout), cwd=self.repo)
        workspace_event = {
            "event": "workspace.closed",
            "data": {"workspace": {
                "workspace_id": "w-paired",
                "label": "paired",
                "worktree": {
                    "repo_root": str(self.repo),
                    "checkout_path": str(checkout),
                    "is_linked_worktree": True,
                },
            }},
        }
        with mock.patch.dict(os.environ, {
            "HERDR_PLUGIN_EVENT": "workspace.closed",
            "HERDR_PLUGIN_EVENT_JSON": json.dumps(workspace_event),
        }):
            self.assertEqual(lifecycle.handle_event(), 1)
        self.assertEqual(len(lifecycle.load_jobs()), 1)
        self.assertEqual(lifecycle.load_jobs()[0]["branch"], "")

        removed_event = {
            "event": "worktree.removed",
            "data": {
                "workspace": workspace_event["data"]["workspace"],
                "workspace_id": "w-paired",
                "worktree": {
                    "path": str(checkout),
                    "branch": "feature/paired",
                    "label": "paired",
                    "is_linked_worktree": True,
                },
            },
        }
        with mock.patch.dict(os.environ, {
            "HERDR_PLUGIN_EVENT": "worktree.removed",
            "HERDR_PLUGIN_EVENT_JSON": json.dumps(removed_event),
        }):
            self.assertEqual(lifecycle.handle_event(), 0)
        self.assertEqual(lifecycle.load_jobs(), [])

    def test_reversed_paired_events_do_not_create_late_branchless_failure(self):
        checkout = self.add_worktree("feature/reversed-pair")
        command("git", "worktree", "remove", "--force", str(checkout), cwd=self.repo)
        workspace = {
            "workspace_id": "w-reversed",
            "label": "reversed-pair",
            "worktree": {
                "repo_root": str(self.repo),
                "checkout_path": str(checkout),
                "is_linked_worktree": True,
            },
        }
        removed_event = {
            "event": "worktree.removed",
            "data": {
                "workspace_id": "w-reversed",
                "workspace": workspace,
                "worktree": {
                    "path": str(checkout),
                    "branch": "feature/reversed-pair",
                    "label": "reversed-pair",
                    "is_linked_worktree": True,
                },
            },
        }
        with mock.patch.dict(os.environ, {
            "HERDR_PLUGIN_EVENT": "worktree.removed",
            "HERDR_PLUGIN_EVENT_JSON": json.dumps(removed_event),
        }):
            self.assertEqual(lifecycle.handle_event(), 0)
        workspace_event = {"event": "workspace.closed", "data": {"workspace": workspace}}
        with mock.patch.dict(os.environ, {
            "HERDR_PLUGIN_EVENT": "workspace.closed",
            "HERDR_PLUGIN_EVENT_JSON": json.dumps(workspace_event),
        }):
            self.assertEqual(lifecycle.handle_event(), 0)
        self.assertEqual(lifecycle.load_jobs(), [])

    def test_branchless_workspace_close_remains_visible_for_retry(self):
        checkout = self.add_worktree("feature/detached", push=False)
        command("git", "-C", str(checkout), "checkout", "--detach")
        event = {
            "event": "workspace.closed",
            "data": {"workspace": {
                "label": "detached",
                "workspace_id": "w-detached",
                "worktree": {
                    "repo_root": str(self.repo),
                    "checkout_path": str(checkout),
                    "is_linked_worktree": True,
                },
            }},
        }
        with mock.patch.dict(os.environ, {
            "HERDR_PLUGIN_EVENT": "workspace.closed",
            "HERDR_PLUGIN_EVENT_JSON": json.dumps(event),
        }):
            self.assertEqual(lifecycle.handle_event(), 1)
        pending = lifecycle.load_jobs()
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["phase"], "validate")
        self.assertIn("rather than guessing", pending[0]["error"]["message"])

    def test_bare_repository_source_is_supported(self):
        checkout = self.temp / "bare-feature"
        command("git", "worktree", "add", "-b", "feature/bare", str(checkout), "main", cwd=self.remote)
        self.assertTrue(lifecycle.enqueue(self.remote, checkout, "feature/bare"))
        self.assertFalse(checkout.exists())
        exists = command(
            "git", "show-ref", "--verify", "--quiet", "refs/heads/feature/bare",
            cwd=self.remote, check=False,
        )
        self.assertEqual(exists.returncode, 1)

    def test_concurrent_root_discovery_does_not_lose_updates(self):
        second = self.temp / "second.git"
        command("git", "init", "--bare", str(second))
        threads = [
            threading.Thread(target=lifecycle.remember_root, args=(root,))
            for root in (self.repo, second)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(set(lifecycle.known_roots()), {lifecycle.canonical(self.repo), lifecycle.canonical(second)})

    def test_primary_repository_resolves_linked_checkout(self):
        checkout = self.add_worktree("wheels/adopt", push=False)
        self.assertEqual(lifecycle.primary_repository(checkout), lifecycle.canonical(self.repo))

    def test_adopt_current_workspaces_persists_roots_and_counts_worktrees(self):
        checkout = self.add_worktree("wheels/adopt", push=False)
        result = lifecycle.adopt_current_workspaces(
            [{"worktree": {"repo_root": str(self.repo)}}],
            [{"cwd": str(checkout)}],
            announce=False,
        )
        self.assertEqual(result["repositories"], 1)
        self.assertEqual(result["linked_worktrees"], 1)
        self.assertEqual(lifecycle.known_roots(), [lifecycle.canonical(self.repo)])

    def test_merged_pull_request_requires_matching_head_commit(self):
        response = subprocess.CompletedProcess(
            ["gh"],
            0,
            json.dumps([
                {
                    "number": 1,
                    "url": "https://github.com/example/repo/pull/1",
                    "mergedAt": "2026-08-10T00:00:00Z",
                    "headRefName": "wheels/merged",
                    "headRefOid": "old-head",
                    "isCrossRepository": False,
                },
                {
                    "number": 2,
                    "url": "https://github.com/example/repo/pull/2",
                    "mergedAt": "2026-08-10T01:00:00Z",
                    "headRefName": "wheels/merged",
                    "headRefOid": "current-head",
                    "isCrossRepository": False,
                },
            ]),
            "",
        )
        with mock.patch.object(lifecycle, "run", return_value=response) as run_mock:
            pull_request = lifecycle.merged_pull_request(self.repo, "wheels/merged", "current-head")
        self.assertEqual(pull_request["number"], 2)
        self.assertEqual(run_mock.call_args.kwargs["cwd"], self.repo)

    def test_hourly_scan_closes_clean_idle_merged_workspace(self):
        checkout = self.add_worktree("wheels/merged", push=False)
        lifecycle.remember_root(self.repo)
        workspace = {
            "workspace_id": "w-merged",
            "agent_status": "idle",
            "worktree": {
                "repo_root": str(self.repo),
                "checkout_path": str(checkout),
                "is_linked_worktree": True,
            },
        }
        pull_request = {
            "number": 7,
            "url": "https://github.com/example/repo/pull/7",
        }
        with mock.patch.object(lifecycle, "live_workspaces", return_value=[workspace]), \
             mock.patch.object(lifecycle, "live_panes", return_value=[]), \
             mock.patch.object(lifecycle, "running_session_count", return_value=1), \
             mock.patch.object(lifecycle, "merged_pull_request", return_value=pull_request), \
             mock.patch.object(lifecycle, "herdr") as herdr_mock:
            result = lifecycle.scan_merged_pull_requests()
        self.assertEqual(result, {"checked": 1, "pruned": 1, "blocked": 0, "failures": 0})
        herdr_mock.assert_called_once_with("workspace", "close", "w-merged")

    def test_hourly_scan_notifies_once_and_never_prunes_unsafe_merge(self):
        checkout = self.add_worktree("wheels/unsafe", dirty=True, push=False)
        lifecycle.remember_root(self.repo)
        workspace = {
            "workspace_id": "w-unsafe",
            "agent_status": "working",
            "focused": True,
            "worktree": {
                "repo_root": str(self.repo),
                "checkout_path": str(checkout),
                "is_linked_worktree": True,
            },
        }
        pull_request = {
            "number": 8,
            "url": "https://github.com/example/repo/pull/8",
        }
        lifecycle.notify.reset_mock()
        with mock.patch.object(lifecycle, "live_workspaces", return_value=[workspace]), \
             mock.patch.object(lifecycle, "live_panes", return_value=[]), \
             mock.patch.object(lifecycle, "running_session_count", return_value=2), \
             mock.patch.object(lifecycle, "merged_pull_request", return_value=pull_request), \
             mock.patch.object(lifecycle, "herdr") as herdr_mock:
            first = lifecycle.scan_merged_pull_requests()
            second = lifecycle.scan_merged_pull_requests()
        self.assertEqual(first["blocked"], 1)
        self.assertEqual(second["blocked"], 1)
        lifecycle.notify.assert_called_once()
        herdr_mock.assert_not_called()
        block = next(iter(lifecycle.load_auto_prune_blocks().values()))
        self.assertIn("multiple Herdr sessions are running", block["reasons"])
        self.assertIn("workspace is focused", block["reasons"])
        self.assertIn("checkout has uncommitted changes", block["reasons"])

    def test_event_path_mismatch_is_rejected(self):
        checkout = self.add_worktree("feature/mismatch")
        envelope = {
            "data": {
                "workspace": {"worktree": {
                    "repo_root": str(self.repo),
                    "checkout_path": str(self.temp / "other"),
                    "is_linked_worktree": True,
                }},
                "worktree": {
                    "path": str(checkout),
                    "branch": "feature/mismatch",
                    "is_linked_worktree": True,
                },
            }
        }
        with mock.patch.dict(os.environ, {"HERDR_PLUGIN_EVENT": "worktree.removed"}):
            with self.assertRaisesRegex(ValueError, "path mismatch"):
                lifecycle.event_metadata(envelope)

    def test_startup_attempts_pending_before_reconciliation(self):
        calls = []
        with mock.patch.object(lifecycle, "retry_pending", side_effect=lambda: calls.append("retry") or True), \
             mock.patch.object(lifecycle, "reconcile", side_effect=lambda: calls.append("reconcile")), \
             mock.patch.object(lifecycle, "load_jobs", return_value=[]):
            self.assertEqual(lifecycle.startup(), 0)
        self.assertEqual(calls, ["retry", "reconcile"])

    def test_reconciliation_does_not_reopen_pending_checkout(self):
        checkout = self.add_worktree("feature/pending", push=False)
        job = lifecycle.create_job(self.repo, checkout, "feature/pending", "test")
        lifecycle.remember_root(self.repo)
        workspace_output = json.dumps({"result": {"type": "workspace_list", "workspaces": []}})
        worktree_output = json.dumps({"result": {"type": "worktree_list", "worktrees": [{
            "path": str(checkout),
            "branch": "feature/pending",
            "is_linked_worktree": True,
            "open_workspace_id": None,
            "label": "pending",
        }]}})

        def fake_herdr(*args, **kwargs):
            output = worktree_output if args[:2] == ("worktree", "list") else workspace_output
            return subprocess.CompletedProcess(args, 0, output, "")

        with mock.patch.object(lifecycle, "herdr", side_effect=fake_herdr) as herdr_mock:
            lifecycle.reconcile()
        self.assertFalse(any(call.args[:2] == ("worktree", "open") for call in herdr_mock.call_args_list))
        self.assertEqual(job["phase"], "validate")

    def test_cleanup_closes_exact_checkout_if_reconciliation_reopened_it(self):
        checkout = self.add_worktree("feature/reopened", push=False)
        job = lifecycle.create_job(self.repo, checkout, "feature/reopened", "test")
        listing = json.dumps({"result": {"worktrees": [
            {"path": str(checkout), "open_workspace_id": "w-reopened"},
            {"path": str(self.repo), "open_workspace_id": "w-primary"},
        ]}})

        def fake_herdr(*args, **kwargs):
            output = listing if args[:2] == ("worktree", "list") else json.dumps({"result": {"type": "ok"}})
            return subprocess.CompletedProcess(args, 0, output, "")

        with mock.patch.dict(os.environ, {"HERDR_SOCKET_PATH": "/tmp/fake-herdr.sock"}), \
             mock.patch.object(lifecycle, "herdr", side_effect=fake_herdr) as herdr_mock:
            lifecycle.close_reopened_workspace(job)
        close_calls = [call.args for call in herdr_mock.call_args_list if call.args[:2] == ("workspace", "close")]
        self.assertEqual(close_calls, [("workspace", "close", "w-reopened")])


if __name__ == "__main__":
    unittest.main()
