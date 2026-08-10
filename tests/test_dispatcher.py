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

    def add_worktree(self, name="linked"):
        checkout = self.repo / ".worktrees" / name
        checkout.parent.mkdir(exist_ok=True)
        command("git", "worktree", "add", "-b", f"wheels/{name}", str(checkout), "main", cwd=self.repo)
        return checkout

    def test_linked_worktree_resolves_to_primary_repository(self):
        checkout = self.add_worktree()
        context = json.dumps({"focused_pane_cwd": str(checkout)})
        with mock.patch.dict(os.environ, {"HERDR_PLUGIN_CONTEXT_JSON": context}):
            self.assertEqual(dispatcher.current_project_root(), lifecycle.canonical(self.repo))

    def test_picker_sources_deduplicate_and_exclude_worktrees(self):
        checkout = self.add_worktree("picker")
        lifecycle.remember_root(checkout)
        self.assertEqual(dispatcher.discover_project_roots(self.projects), [lifecycle.canonical(self.repo)])

    def test_dispatcher_environment_preserves_normal_config(self):
        inline = {
            "mcp": {"example": {"type": "remote"}},
            "instructions": ["existing.md"],
            "permission": {"bash": {"*": "allow"}},
        }
        tui = self.temp / "tui.json"
        tui.write_text(json.dumps({"theme": "kanagawa", "keybinds": {"session_compact": "ctrl+x,c"}}))
        with mock.patch.dict(os.environ, {
            "XDG_CONFIG_HOME": "/normal/config",
            "OPENCODE_CONFIG": "/normal/opencode.jsonc",
            "OPENCODE_CONFIG_CONTENT": json.dumps(inline),
            "OPENCODE_TUI_CONFIG": str(tui),
        }):
            environment = dispatcher.dispatcher_environment(self.repo)

        self.assertEqual(environment["XDG_CONFIG_HOME"], "/normal/config")
        self.assertEqual(environment["OPENCODE_CONFIG"], "/normal/opencode.jsonc")
        merged = json.loads(environment["OPENCODE_CONFIG_CONTENT"])
        self.assertEqual(merged["mcp"], inline["mcp"])
        self.assertEqual(merged["instructions"], ["existing.md"])
        self.assertEqual(merged["permission"], inline["permission"])
        self.assertIn(dispatcher.CHAT_AGENT, merged["agent"])
        self.assertIn(f"file://{dispatcher.chat_title_plugin_path()}", merged["plugin"])
        self.assertTrue(merged["agent"]["build"]["disable"])
        self.assertTrue(merged["agent"]["plan"]["disable"])
        chat = merged["agent"][dispatcher.CHAT_AGENT]
        self.assertEqual(chat["color"], dispatcher.CHAT_AGENT_COLOR)
        self.assertEqual(chat["permission"]["edit"], "deny")
        self.assertNotIn("*", chat["permission"]["bash"])
        for dispatch_command in dispatcher.CHAT_DISPATCH_COMMANDS:
            self.assertEqual(chat["permission"]["bash"][dispatch_command], "allow")
        chat_tui = json.loads(Path(environment["OPENCODE_TUI_CONFIG"]).read_text())
        self.assertEqual(chat_tui["theme"], "kanagawa")
        self.assertEqual(chat_tui["keybinds"]["session_compact"], "ctrl+x,c")
        for key in dispatcher.CHAT_TUI_DISABLED_KEYBINDS:
            self.assertEqual(chat_tui["keybinds"][key], "none")

    def test_chat_opens_tab_in_existing_primary_workspace(self):
        calls = []
        workspace_list = json.dumps({"result": {"workspaces": [{
            "workspace_id": "w-root",
            "worktree": {"checkout_path": str(self.repo), "is_linked_worktree": False},
        }]}})

        def fake_herdr(*args, **_kwargs):
            calls.append(args)
            output = workspace_list if args[:2] == ("workspace", "list") else json.dumps({"result": {}})
            return subprocess.CompletedProcess(args, 0, output, "")

        with mock.patch.object(dispatcher, "herdr", side_effect=fake_herdr):
            self.assertEqual(dispatcher.open_chat_tab(self.repo), "w-root")

        opened = next(call for call in calls if call[:3] == ("plugin", "pane", "open"))
        self.assertIn("dispatcher-chat", opened)
        self.assertIn("tab", opened)
        self.assertIn("w-root", opened)
        self.assertIn("HERDR_CHAT_TAB_LABEL=New Chat", opened)
        self.assertFalse(any(call[:2] == ("worktree", "open") for call in calls))

    def test_global_chat_history_excludes_worktree_sessions(self):
        checkout = self.add_worktree("implementation")
        sessions = [
            {"id": "general", "title": "General", "updated": 2, "directory": str(self.repo)},
            {"id": "implementation", "title": "Implementation", "updated": 3, "directory": str(checkout)},
        ]
        with mock.patch.object(dispatcher, "discover_project_roots", return_value=[str(self.repo)]), \
             mock.patch.object(dispatcher, "opencode_sessions", return_value=sessions):
            history = dispatcher.general_chat_sessions()

        self.assertEqual([item["id"] for item in history], ["general"])
        self.assertEqual(history[0]["project_root"], str(self.repo))

    def test_resumed_chat_launches_native_session(self):
        captured = {}

        def fake_exec(program, arguments, environment):
            captured.update(program=program, arguments=arguments, environment=environment)

        with mock.patch.dict(os.environ, {
            "HERDR_DISPATCHER_PROJECT_ROOT": str(self.repo),
            "HERDR_DISPATCHER_SESSION_ID": "ses-resume",
            "HERDR_TAB_ID": "w-root:t-chat",
        }), mock.patch.object(dispatcher, "herdr") as herdr_mock:
            dispatcher.run_chat(exec_fn=fake_exec)

        self.assertEqual(captured["arguments"], [
            "opencode", lifecycle.canonical(self.repo), "--agent", dispatcher.CHAT_AGENT,
            "--session", "ses-resume",
        ])
        self.assertEqual(captured["environment"]["HERDR_DISPATCHER"], "1")
        herdr_mock.assert_called_once_with("tab", "rename", "w-root:t-chat", "New Chat", check=False)

    def created_response(self):
        return subprocess.CompletedProcess(
            ["herdr"],
            0,
            json.dumps({"result": {
                "workspace": {"workspace_id": "w-task"},
                "root_pane": {"pane_id": "w-task:p1"},
            }}),
            "",
        )

    def test_successful_dispatch_preserves_sole_tab_workspace_then_closes_chat(self):
        calls = []
        start_attempts = 0

        def fake_herdr(*args, **_kwargs):
            nonlocal start_attempts
            calls.append(args)
            if args[:2] == ("worktree", "create"):
                return self.created_response()
            if args[:2] == ("pane", "split"):
                return subprocess.CompletedProcess(
                    args, 0, json.dumps({"result": {"pane": {"pane_id": "w-task:p2"}}}), ""
                )
            if args[:2] == ("agent", "start"):
                start_attempts += 1
                if start_attempts == 1:
                    return subprocess.CompletedProcess(
                        args, 1, "", "agent_pane_busy: agent target pane w-task:p1 is not an available shell"
                    )
            if args[:2] == ("tab", "list"):
                return subprocess.CompletedProcess(
                    args, 0, json.dumps({"result": {"tabs": [{"tab_id": "w-root:t-chat"}]}}), ""
                )
            return subprocess.CompletedProcess(args, 0, json.dumps({"result": {"type": "ok"}}), "")

        with mock.patch.dict(os.environ, {
            "HERDR_DISPATCHER": "1",
            "HERDR_DISPATCHER_PROJECT_ROOT": str(self.repo),
            "HERDR_TAB_ID": "w-root:t-chat",
            "HERDR_WORKSPACE_ID": "w-root",
        }), mock.patch.object(dispatcher, "herdr", side_effect=fake_herdr), \
             mock.patch.object(dispatcher.time, "sleep") as sleep:
            self.assertEqual(dispatcher.dispatch_task("new feature", "Implement the complete request"), 0)

        create = next(call for call in calls if call[:2] == ("worktree", "create"))
        self.assertIn("wheels/new-feature", create)
        self.assertIn(lifecycle.canonical(self.repo / ".worktrees" / "new-feature"), create)
        split_index = next(index for index, call in enumerate(calls) if call[:2] == ("pane", "split"))
        start_indexes = [index for index, call in enumerate(calls) if call[:2] == ("agent", "start")]
        start_index = start_indexes[0]
        prompt_index = next(index for index, call in enumerate(calls) if call[:2] == ("agent", "prompt"))
        list_index = next(index for index, call in enumerate(calls) if call[:2] == ("tab", "list"))
        create_tab_index = next(index for index, call in enumerate(calls) if call[:2] == ("tab", "create"))
        focus_index = next(index for index, call in enumerate(calls) if call[:2] == ("workspace", "focus"))
        close_index = next(index for index, call in enumerate(calls) if call[:2] == ("tab", "close"))
        self.assertLess(split_index, start_index)
        self.assertLess(start_index, prompt_index)
        self.assertLess(prompt_index, list_index)
        self.assertLess(list_index, create_tab_index)
        self.assertLess(create_tab_index, focus_index)
        self.assertLess(focus_index, close_index)
        self.assertEqual(len(start_indexes), 2)
        for index in start_indexes:
            self.assertEqual(calls[index][calls[index].index("--pane") + 1], "w-task:p1")
            self.assertNotIn("w-task:p2", calls[index])
        sleep.assert_called_once()
        self.assertEqual(calls[create_tab_index], (
            "tab", "create", "--workspace", "w-root", "--cwd", lifecycle.canonical(self.repo), "--no-focus",
        ))
        self.assertEqual(calls[close_index], ("tab", "close", "w-root:t-chat"))

    def test_finish_dispatch_does_not_create_replacement_when_other_tab_exists(self):
        calls = []

        def fake_herdr(*args, **_kwargs):
            calls.append(args)
            if args[:2] == ("tab", "list"):
                output = {"result": {"tabs": [
                    {"tab_id": "w-root:t-chat"},
                    {"tab_id": "w-root:t-shell"},
                ]}}
                return subprocess.CompletedProcess(args, 0, json.dumps(output), "")
            return subprocess.CompletedProcess(args, 0, "", "")

        with mock.patch.object(dispatcher, "herdr", side_effect=fake_herdr):
            dispatcher.finish_dispatch(str(self.repo), "task", "w-task", "w-root:t-chat", "w-root")

        self.assertFalse(any(call[:2] == ("tab", "create") for call in calls))
        self.assertEqual(calls[-2:], [
            ("workspace", "focus", "w-task"),
            ("tab", "close", "w-root:t-chat"),
        ])

    def test_replacement_failure_is_non_fatal_and_leaves_chat_open(self):
        calls = []

        def fake_herdr(*args, **_kwargs):
            calls.append(args)
            if args[:2] == ("worktree", "create"):
                return self.created_response()
            if args[:2] == ("pane", "split"):
                return subprocess.CompletedProcess(
                    args, 0, json.dumps({"result": {"pane": {"pane_id": "w-task:p2"}}}), ""
                )
            if args[:2] == ("tab", "list"):
                output = {"result": {"tabs": [{"tab_id": "w-root:t-chat"}]}}
                return subprocess.CompletedProcess(args, 0, json.dumps(output), "")
            if args[:2] == ("tab", "create"):
                raise dispatcher.DispatchFailure("replacement shell failed")
            return subprocess.CompletedProcess(args, 0, "", "")

        with mock.patch.dict(os.environ, {
            "HERDR_DISPATCHER": "1",
            "HERDR_DISPATCHER_PROJECT_ROOT": str(self.repo),
            "HERDR_TAB_ID": "w-root:t-chat",
            "HERDR_WORKSPACE_ID": "w-root",
        }), mock.patch.object(dispatcher, "herdr", side_effect=fake_herdr), \
             mock.patch.object(dispatcher, "notify") as notify:
            self.assertEqual(dispatcher.dispatch_task("cleanup-warning", "Implement this request"), 0)

        self.assertIn(("workspace", "focus", "w-task"), calls)
        self.assertFalse(any(call[:2] == ("tab", "close") for call in calls))
        notify.assert_called_once()
        self.assertIn("Do not retry", notify.call_args.args[1])

    def test_close_failure_is_non_fatal_and_restores_source_focus(self):
        calls = []

        def fake_herdr(*args, **_kwargs):
            calls.append(args)
            if args[:2] == ("tab", "list"):
                output = {"result": {"tabs": [
                    {"tab_id": "w-root:t-chat"},
                    {"tab_id": "w-root:t-shell"},
                ]}}
                return subprocess.CompletedProcess(args, 0, json.dumps(output), "")
            if args[:2] == ("tab", "close"):
                raise dispatcher.DispatchFailure("confirmation_required")
            return subprocess.CompletedProcess(args, 0, "", "")

        with mock.patch.object(dispatcher, "herdr", side_effect=fake_herdr), \
             mock.patch.object(dispatcher, "notify") as notify:
            dispatcher.finish_dispatch(str(self.repo), "task", "w-task", "w-root:t-chat", "w-root")

        implementation_focus = calls.index(("workspace", "focus", "w-task"))
        close = calls.index(("tab", "close", "w-root:t-chat"))
        restored_focus = calls.index(("workspace", "focus", "w-root"))
        self.assertLess(implementation_focus, close)
        self.assertLess(close, restored_focus)
        self.assertIn("confirmation_required", notify.call_args.args[1])

    def test_stale_source_tab_metadata_skips_close_but_focuses_implementation(self):
        calls = []

        def fake_herdr(*args, **_kwargs):
            calls.append(args)
            if args[:2] == ("tab", "list"):
                output = {"result": {"tabs": [{"tab_id": "w-root:t-other"}]}}
                return subprocess.CompletedProcess(args, 0, json.dumps(output), "")
            return subprocess.CompletedProcess(args, 0, "", "")

        with mock.patch.object(dispatcher, "herdr", side_effect=fake_herdr):
            dispatcher.finish_dispatch(str(self.repo), "task", "w-task", "w-root:t-chat", "w-root")

        self.assertIn(("workspace", "focus", "w-task"), calls)
        self.assertFalse(any(call[:2] == ("tab", "close") for call in calls))

    def test_unexpected_post_prompt_cleanup_failure_does_not_fail_dispatch(self):
        calls = []

        def fake_herdr(*args, **_kwargs):
            calls.append(args)
            if args[:2] == ("worktree", "create"):
                return self.created_response()
            if args[:2] == ("pane", "split"):
                return subprocess.CompletedProcess(
                    args, 0, json.dumps({"result": {"pane": {"pane_id": "w-task:p2"}}}), ""
                )
            return subprocess.CompletedProcess(args, 0, "", "")

        with mock.patch.dict(os.environ, {
            "HERDR_DISPATCHER": "1",
            "HERDR_DISPATCHER_PROJECT_ROOT": str(self.repo),
            "HERDR_TAB_ID": "w-root:t-chat",
            "HERDR_WORKSPACE_ID": "w-root",
        }), mock.patch.object(dispatcher, "herdr", side_effect=fake_herdr), \
             mock.patch.object(dispatcher, "finish_dispatch", side_effect=ValueError("unexpected cleanup failure")), \
             mock.patch.object(dispatcher, "notify") as notify:
            self.assertEqual(dispatcher.dispatch_task("cleanup-boundary", "Implement this request"), 0)

        self.assertTrue(any(call[:2] == ("agent", "prompt") for call in calls))
        self.assertIn("Do not retry", notify.call_args.args[1])

    def test_agent_start_does_not_retry_non_readiness_failures(self):
        failure = subprocess.CompletedProcess(
            ["herdr"], 1, "", "agent_name_conflict: agent already exists"
        )
        with mock.patch.object(dispatcher, "herdr", return_value=failure) as herdr_mock, \
             mock.patch.object(dispatcher.time, "sleep") as sleep:
            with self.assertRaisesRegex(dispatcher.DispatchFailure, "agent_name_conflict"):
                dispatcher.start_agent_when_shell_ready("agent", "w-task:p1", "/checkout")

        herdr_mock.assert_called_once()
        sleep.assert_not_called()

    def test_dispatch_failure_keeps_chat_tab_open(self):
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
            "HERDR_TAB_ID": "w-root:t-chat",
            "HERDR_WORKSPACE_ID": "w-root",
        }), mock.patch.object(dispatcher, "herdr", side_effect=fake_herdr):
            with self.assertRaisesRegex(dispatcher.DispatchFailure, "exact split failure"):
                dispatcher.dispatch_task("broken", "Implement this request")

        self.assertFalse(any(call[:2] == ("workspace", "focus") for call in calls))
        self.assertFalse(any(call[:2] == ("tab", "close") for call in calls))

    def test_dispatch_reports_dirty_primary_main_without_discarding_changes(self):
        dirty = self.repo / "local.txt"
        dirty.write_text("keep me\n")
        with mock.patch.dict(os.environ, {
            "HERDR_DISPATCHER": "1",
            "HERDR_DISPATCHER_PROJECT_ROOT": str(self.repo),
            "HERDR_TAB_ID": "w-root:t-chat",
            "HERDR_WORKSPACE_ID": "w-root",
        }), mock.patch.object(
            dispatcher,
            "synchronize_primary_main",
            return_value={"status": "dirty"},
        ), mock.patch.object(dispatcher, "herdr") as herdr_mock:
            with self.assertRaisesRegex(dispatcher.DispatchFailure, "synchronization blocked: dirty"):
                dispatcher.dispatch_task("blocked", "Implement this request")

        self.assertEqual(dirty.read_text(), "keep me\n")
        herdr_mock.assert_not_called()

    def test_local_only_repository_uses_local_main_as_dispatch_base(self):
        command("git", "remote", "remove", "origin", cwd=self.repo)
        command("git", "branch", "-D", "develop", cwd=self.repo)
        self.assertFalse(dispatcher.has_origin(self.repo))
        self.assertEqual(dispatcher.dispatch_base(self.repo), "main")

    def test_prompt_failure_is_fatal_and_keeps_chat_tab_open(self):
        calls = []

        def fake_herdr(*args, **_kwargs):
            calls.append(args)
            if args[:2] == ("worktree", "create"):
                return self.created_response()
            if args[:2] == ("pane", "split"):
                return subprocess.CompletedProcess(
                    args, 0, json.dumps({"result": {"pane": {"pane_id": "w-task:p2"}}}), ""
                )
            if args[:2] == ("agent", "prompt"):
                raise dispatcher.DispatchFailure("exact prompt failure")
            return subprocess.CompletedProcess(args, 0, "", "")

        with mock.patch.dict(os.environ, {
            "HERDR_DISPATCHER": "1",
            "HERDR_DISPATCHER_PROJECT_ROOT": str(self.repo),
            "HERDR_TAB_ID": "w-root:t-chat",
            "HERDR_WORKSPACE_ID": "w-root",
        }), mock.patch.object(dispatcher, "herdr", side_effect=fake_herdr):
            with self.assertRaisesRegex(dispatcher.DispatchFailure, "exact prompt failure"):
                dispatcher.dispatch_task("prompt-failure", "Implement this request")

        self.assertFalse(any(call[:2] == ("tab", "list") for call in calls))
        self.assertFalse(any(call[:2] == ("workspace", "focus") for call in calls))
        self.assertFalse(any(call[:2] == ("tab", "close") for call in calls))


if __name__ == "__main__":
    unittest.main()
