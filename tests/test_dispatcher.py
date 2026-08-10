#!/usr/bin/env python3

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import dispatcher
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


class DispatcherTest(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix="herdr-dispatcher-test-"))
        self.state = self.temp / "state"
        self.projects = self.temp / "Projects"
        self.projects.mkdir()
        self.remote = self.temp / "remote.git"
        self.repo = self.projects / "project"
        command("git", "init", "--bare", str(self.remote))
        command("git", "init", "-b", "main", str(self.repo))
        command("git", "config", "user.email", "test@example.com", cwd=self.repo)
        command("git", "config", "user.name", "Test User", cwd=self.repo)
        (self.repo / "README").write_text("initial\n")
        command("git", "add", "README", cwd=self.repo)
        command("git", "commit", "-m", "initial", cwd=self.repo)
        command("git", "branch", "develop", cwd=self.repo)
        command("git", "remote", "add", "origin", str(self.remote), cwd=self.repo)
        command("git", "push", "-u", "origin", "main", "develop", cwd=self.repo)
        command("git", "symbolic-ref", "HEAD", "refs/heads/main", cwd=self.remote)
        self.environment = mock.patch.dict(
            os.environ,
            {
                "HERDR_PLUGIN_STATE_DIR": str(self.state),
                "HERDR_PROJECTS_ROOT": str(self.projects),
            },
            clear=False,
        )
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        shutil.rmtree(self.temp, ignore_errors=True)

    def test_current_primary_repository_resolution(self):
        context = json.dumps({"focused_pane_cwd": str(self.repo)})
        with mock.patch.dict(os.environ, {"HERDR_PLUGIN_CONTEXT_JSON": context}):
            self.assertEqual(dispatcher.current_project_root(), lifecycle.canonical(self.repo))

    def test_linked_worktree_resolves_to_primary_repository(self):
        checkout = self.repo / ".worktrees" / "linked"
        checkout.parent.mkdir()
        command("git", "worktree", "add", "-b", "wheels/linked", str(checkout), "main", cwd=self.repo)
        self.assertEqual(dispatcher.primary_repository(checkout), lifecycle.canonical(self.repo))

    def test_picker_sources_deduplicate_and_exclude_worktrees(self):
        checkout = self.repo / ".worktrees" / "picker"
        checkout.parent.mkdir()
        command("git", "worktree", "add", "-b", "wheels/picker", str(checkout), "main", cwd=self.repo)
        lifecycle.remember_root(checkout)
        roots = dispatcher.discover_project_roots(self.projects)
        self.assertEqual(roots, [lifecycle.canonical(self.repo)])
        self.assertFalse(any(".worktrees" in Path(root).parts for root in roots))

    def test_no_repository_falls_back_to_picker(self):
        with mock.patch.object(dispatcher, "current_project_root", return_value=None), \
             mock.patch.object(dispatcher, "pick_project", return_value=str(self.repo)) as picker, \
             mock.patch.object(dispatcher, "launch_fresh_session") as launch:
            self.assertEqual(dispatcher.chat_current(), 0)
        picker.assert_called_once_with()
        launch.assert_called_once_with(str(self.repo))

    def test_runtime_instruction_injection_and_fresh_session_launch(self):
        captured = {}

        def fake_exec(program, arguments, environment):
            captured.update(program=program, arguments=arguments, environment=environment)

        dispatcher.launch_fresh_session(self.repo, exec_fn=fake_exec)
        self.assertEqual(captured["program"], "opencode")
        self.assertEqual(captured["arguments"], ["opencode", lifecycle.canonical(self.repo)])
        self.assertNotIn("--continue", captured["arguments"])
        self.assertNotIn("--session", captured["arguments"])
        self.assertEqual(captured["environment"]["HERDR_DISPATCHER"], "1")
        self.assertEqual(
            captured["environment"]["XDG_CONFIG_HOME"],
            str(self.state / "dispatcher-config"),
        )
        self.assertEqual(
            captured["environment"]["HERDR_DISPATCHER_PROJECT_ROOT"],
            lifecycle.canonical(self.repo),
        )
        inline = json.loads(captured["environment"]["OPENCODE_CONFIG_CONTENT"])
        self.assertEqual(inline, {"instructions": [dispatcher.dispatcher_instruction_path()]})

    def test_dispatcher_policy_keeps_non_code_requests_in_popup(self):
        policy = Path(dispatcher.dispatcher_instruction_path()).read_text()
        self.assertIn("discussion, questions, code review, exploration, and planning stay in this popup", policy)
        self.assertIn("Do not create a worktree for those requests", policy)
        self.assertIn("dispatcher.py\" dispatch", policy)

    def created_response(self):
        return subprocess.CompletedProcess(
            ["herdr"],
            0,
            json.dumps({
                "result": {
                    "workspace": {"workspace_id": "w-task"},
                    "root_pane": {"pane_id": "w-task:p1"},
                }
            }),
            "",
        )

    def test_successful_dispatch_focuses_then_closes_popup(self):
        calls = []

        def fake_herdr(*args, **_kwargs):
            calls.append(args)
            if args[:2] == ("worktree", "create"):
                return self.created_response()
            return subprocess.CompletedProcess(args, 0, json.dumps({"result": {"type": "ok"}}), "")

        with mock.patch.dict(os.environ, {
            "HERDR_DISPATCHER": "1",
            "HERDR_DISPATCHER_PROJECT_ROOT": str(self.repo),
        }), mock.patch.object(dispatcher, "herdr", side_effect=fake_herdr), \
             mock.patch.object(dispatcher, "socket_request", return_value={}) as socket_call:
            self.assertEqual(dispatcher.dispatch_task("new feature", "Implement the complete request"), 0)

        create = next(call for call in calls if call[:2] == ("worktree", "create"))
        self.assertIn("wheels/new-feature", create)
        self.assertIn(lifecycle.canonical(self.repo / ".worktrees" / "new-feature"), create)
        split_index = next(index for index, call in enumerate(calls) if call[:2] == ("pane", "split"))
        start_index = next(index for index, call in enumerate(calls) if call[:2] == ("agent", "start"))
        prompt_index = next(index for index, call in enumerate(calls) if call[:2] == ("agent", "prompt"))
        focus_index = next(index for index, call in enumerate(calls) if call[:2] == ("workspace", "focus"))
        self.assertLess(split_index, start_index)
        self.assertLess(start_index, prompt_index)
        self.assertLess(prompt_index, focus_index)
        self.assertEqual(calls[prompt_index][-1], "Implement the complete request")
        self.assertEqual(calls[focus_index], ("workspace", "focus", "w-task"))
        socket_call.assert_called_once_with("popup.close", {})

    def test_dispatch_failure_keeps_popup_open_and_does_not_focus(self):
        calls = []

        def fake_herdr(*args, **_kwargs):
            calls.append(args)
            if args[:2] == ("worktree", "create"):
                return self.created_response()
            if args[:2] == ("pane", "split"):
                raise dispatcher.DispatchFailure("exact split failure")
            return subprocess.CompletedProcess(args, 0, "", "")

        with mock.patch.dict(os.environ, {
            "HERDR_DISPATCHER": "1",
            "HERDR_DISPATCHER_PROJECT_ROOT": str(self.repo),
        }), mock.patch.object(dispatcher, "herdr", side_effect=fake_herdr), \
             mock.patch.object(dispatcher, "socket_request") as socket_call:
            with self.assertRaisesRegex(dispatcher.DispatchFailure, "exact split failure"):
                dispatcher.dispatch_task("broken", "Implement this request")

        self.assertFalse(any(call[:2] == ("workspace", "focus") for call in calls))
        socket_call.assert_not_called()

    def test_popup_close_failure_restores_original_workspace_focus(self):
        calls = []

        def fake_herdr(*args, **_kwargs):
            calls.append(args)
            if args[:2] == ("worktree", "create"):
                return self.created_response()
            return subprocess.CompletedProcess(args, 0, json.dumps({"result": {"type": "ok"}}), "")

        context = json.dumps({"workspace_id": "w-original"})
        with mock.patch.dict(os.environ, {
            "HERDR_DISPATCHER": "1",
            "HERDR_DISPATCHER_PROJECT_ROOT": str(self.repo),
            "HERDR_PLUGIN_CONTEXT_JSON": context,
        }), mock.patch.object(dispatcher, "herdr", side_effect=fake_herdr), \
             mock.patch.object(
                 dispatcher,
                 "socket_request",
                 side_effect=dispatcher.DispatchFailure("exact popup close failure"),
             ):
            with self.assertRaisesRegex(dispatcher.DispatchFailure, "exact popup close failure"):
                dispatcher.dispatch_task("close-fails", "Implement this request")

        focus_calls = [call for call in calls if call[:2] == ("workspace", "focus")]
        self.assertEqual(focus_calls, [
            ("workspace", "focus", "w-task"),
            ("workspace", "focus", "w-original"),
        ])


if __name__ == "__main__":
    unittest.main()
