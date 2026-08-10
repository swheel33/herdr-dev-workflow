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

    def test_history_collapses_dispatch_chain_to_latest_combined_session(self):
        checkout = self.add_worktree("combined-history")
        dispatcher.record_dispatch_thread(
            self.repo,
            "ses-source",
            "ses-source",
            "ses-implementation",
            "combined-history",
            "wheels/combined-history",
            checkout,
        )
        sessions = [
            {"id": "ses-source", "title": "Original discussion", "updated": 2, "directory": str(self.repo)},
            {"id": "ses-implementation", "title": "Implemented fix", "updated": 4, "directory": str(checkout)},
            {"id": "general", "title": "Unrelated chat", "updated": 3, "directory": str(self.repo)},
        ]

        with mock.patch.object(dispatcher, "discover_project_roots", return_value=[str(self.repo)]), \
             mock.patch.object(dispatcher, "opencode_sessions", return_value=sessions):
            history = dispatcher.general_chat_sessions()

        self.assertEqual([item["id"] for item in history], ["ses-implementation", "general"])
        combined = history[0]
        self.assertTrue(combined["fork_on_open"])
        self.assertEqual(combined["thread_id"], "ses-source")
        self.assertEqual(combined["project_root"], lifecycle.canonical(self.repo))

    def test_history_picker_receives_rows_and_uses_full_popup(self):
        session = {
            "id": "ses-history",
            "title": "Visible history row",
            "updated": 1_786_396_551_406,
            "project_root": str(self.repo),
        }
        selected = f"project\tVisible history row\t2026-08-10 17:29\tses-history\n"
        response = subprocess.CompletedProcess(["fzf"], 0, selected, "")

        with mock.patch.object(dispatcher, "general_chat_sessions", return_value=[session]), \
             mock.patch.object(dispatcher, "run_command", return_value=response) as run_mock:
            result = dispatcher.pick_chat()

        command_args = run_mock.call_args.args[0]
        self.assertNotIn("--height", command_args)
        self.assertIn("Visible history row", run_mock.call_args.kwargs["input_text"])
        self.assertEqual(result, (str(self.repo), "ses-history", "Visible history row", False, None))

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

    def test_history_continuation_forks_into_project_chat(self):
        captured = {}

        def fake_exec(program, arguments, environment):
            captured.update(program=program, arguments=arguments, environment=environment)

        with mock.patch.dict(os.environ, {
            "HERDR_DISPATCHER_PROJECT_ROOT": str(self.repo),
            "HERDR_DISPATCHER_SESSION_ID": "ses-implementation",
            "HERDR_DISPATCHER_FORK_SESSION": "1",
            "HERDR_DISPATCH_THREAD_ID": "ses-source",
        }), mock.patch.object(dispatcher, "herdr"):
            dispatcher.run_chat(exec_fn=fake_exec)

        self.assertEqual(captured["arguments"], [
            "opencode", lifecycle.canonical(self.repo), "--agent", dispatcher.CHAT_AGENT,
            "--session", "ses-implementation", "--fork",
        ])
        self.assertEqual(captured["environment"]["HERDR_DISPATCH_THREAD_ID"], "ses-source")

    def test_live_history_fork_identity_wins_over_launch_parent(self):
        response = subprocess.CompletedProcess(
            ["herdr"],
            0,
            json.dumps({"result": {"pane": {"agent_session": {"value": "ses-review"}}}}),
            "",
        )
        with mock.patch.dict(os.environ, {"HERDR_DISPATCHER_SESSION_ID": "ses-implementation"}), \
             mock.patch.object(dispatcher, "herdr", return_value=response):
            self.assertEqual(dispatcher.current_chat_session("w-root:p-chat"), "ses-review")

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

    def agent_response(self, args, *, status="idle", state_change_seq=10, session=False, interactive_ready=True):
        agent = {
            "agent": "opencode",
            "agent_status": status,
            "interactive_ready": interactive_ready,
            "name": args[2],
            "pane_id": "w-task:p1",
            "state_change_seq": state_change_seq,
        }
        if session:
            agent["agent_session"] = {
                "source": "herdr:opencode",
                "agent": "opencode",
                "kind": "id",
                "value": "ses-dispatched",
            }
        return subprocess.CompletedProcess(
            args, 0, json.dumps({"result": {"agent": agent}}), ""
        )

    def pane_response(self, args):
        return subprocess.CompletedProcess(
            args,
            0,
            json.dumps({"result": {"pane": {"agent_session": {"value": "ses-source"}}}}),
            "",
        )

    def test_successful_dispatch_forks_context_and_resets_project_chat_without_focus(self):
        calls = []
        start_attempts = 0

        def fake_herdr(*args, **_kwargs):
            nonlocal start_attempts
            calls.append(args)
            if args[:2] == ("worktree", "create"):
                return self.created_response()
            if args[:2] == ("pane", "get"):
                return self.pane_response(args)
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
                return self.agent_response(args)
            if args[:2] == ("agent", "prompt"):
                return self.agent_response(args, status="working", state_change_seq=11, session=True)
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
            "HERDR_PANE_ID": "w-root:p-chat",
            "HERDR_DISPATCHER_SESSION_ID": "ses-source",
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
        replacement_index = next(index for index, call in enumerate(calls) if call[:3] == ("plugin", "pane", "open"))
        close_index = next(index for index, call in enumerate(calls) if call[:2] == ("tab", "close"))
        self.assertLess(split_index, start_index)
        self.assertLess(start_index, prompt_index)
        self.assertEqual(len(start_indexes), 2)
        for index in start_indexes:
            self.assertEqual(calls[index][calls[index].index("--pane") + 1], "w-task:p1")
            self.assertNotIn("w-task:p2", calls[index])
            self.assertIn("--timeout", calls[index])
        final_start = calls[start_indexes[-1]]
        self.assertEqual(final_start[-3:], ("--session", "ses-source", "--fork"))
        self.assertEqual(calls[prompt_index][-5:], (
            "--wait", "--until", "working", "--timeout", str(dispatcher.PROMPT_DELIVERY_TIMEOUT_MS),
        ))
        sleep.assert_called_once()
        self.assertLess(prompt_index, replacement_index)
        self.assertLess(replacement_index, close_index)
        replacement = calls[replacement_index]
        self.assertIn("dispatcher-chat", replacement)
        self.assertIn("--no-focus", replacement)
        self.assertNotIn("HERDR_DISPATCHER_SESSION_ID=ses-source", replacement)
        self.assertEqual(calls[close_index], ("tab", "close", "w-root:t-chat"))
        self.assertFalse(any(call[:2] in {("workspace", "focus"), ("tab", "focus")} for call in calls))
        threads = dispatcher.load_dispatch_threads()
        self.assertEqual(len(threads), 1)
        self.assertEqual(threads[0]["sessions"], ["ses-source", "ses-dispatched"])
        self.assertEqual(threads[0]["latest_session_id"], "ses-dispatched")

    def test_dispatch_requires_source_chat_metadata_before_creating_worktree(self):
        with mock.patch.dict(os.environ, {
            "HERDR_DISPATCHER": "1",
            "HERDR_DISPATCHER_PROJECT_ROOT": str(self.repo),
        }, clear=True), mock.patch.object(dispatcher, "herdr") as herdr_mock:
            with self.assertRaisesRegex(dispatcher.DispatchFailure, "metadata is missing"):
                dispatcher.dispatch_task("metadata-free", "Implement this request")

        herdr_mock.assert_not_called()

    def test_replacement_failure_leaves_used_project_chat_open(self):
        calls = []

        def fake_herdr(*args, **_kwargs):
            calls.append(args)
            if args[:2] == ("tab", "list"):
                return subprocess.CompletedProcess(
                    args, 0, json.dumps({"result": {"tabs": [{"tab_id": "w-root:t-chat"}]}}), ""
                )
            if args[:3] == ("plugin", "pane", "open"):
                raise dispatcher.DispatchFailure("replacement failed")
            return subprocess.CompletedProcess(args, 0, "", "")

        with mock.patch.object(dispatcher, "herdr", side_effect=fake_herdr):
            with self.assertRaisesRegex(dispatcher.DispatchFailure, "replacement failed"):
                dispatcher.replace_source_chat(str(self.repo), "w-root:t-chat", "w-root")

        self.assertFalse(any(call[:2] == ("tab", "close") for call in calls))

    def test_registered_history_continuation_becomes_latest_thread_session(self):
        dispatcher.update_dispatch_thread("thread", self.repo, "ses-implementation")

        dispatcher.register_chat_session("thread", "ses-review", str(self.repo))

        thread = dispatcher.load_dispatch_threads()[0]
        self.assertEqual(thread["sessions"], ["ses-implementation", "ses-review"])
        self.assertEqual(thread["latest_session_id"], "ses-review")

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

    def test_agent_start_requires_structured_idle_readiness(self):
        response = self.agent_response(
            ("agent", "start", "agent"), interactive_ready=False
        )
        with mock.patch.object(dispatcher, "herdr", return_value=response):
            with self.assertRaisesRegex(dispatcher.DispatchFailure, "authoritative idle readiness"):
                dispatcher.start_agent_when_shell_ready("agent", "w-task:p1", "/checkout")

    def test_dispatch_failure_keeps_chat_tab_open(self):
        calls = []

        def fake_herdr(*args, **_kwargs):
            calls.append(args)
            if args[:2] == ("pane", "get"):
                return self.pane_response(args)
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
            "HERDR_PANE_ID": "w-root:p-chat",
            "HERDR_DISPATCHER_SESSION_ID": "ses-source",
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
            "HERDR_PANE_ID": "w-root:p-chat",
            "HERDR_DISPATCHER_SESSION_ID": "ses-source",
        }), mock.patch.object(
            dispatcher,
            "synchronize_primary_main",
            return_value={"status": "dirty"},
        ), mock.patch.object(
            dispatcher,
            "herdr",
            side_effect=lambda *args, **_kwargs: self.pane_response(args),
        ) as herdr_mock:
            with self.assertRaisesRegex(dispatcher.DispatchFailure, "synchronization blocked: dirty"):
                dispatcher.dispatch_task("blocked", "Implement this request")

        self.assertEqual(dirty.read_text(), "keep me\n")
        self.assertFalse(any(call.args[:2] == ("worktree", "create") for call in herdr_mock.call_args_list))

    def test_local_only_repository_uses_local_main_as_dispatch_base(self):
        command("git", "remote", "remove", "origin", cwd=self.repo)
        command("git", "branch", "-D", "develop", cwd=self.repo)
        self.assertFalse(dispatcher.has_origin(self.repo))
        self.assertEqual(dispatcher.dispatch_base(self.repo), "main")

    def test_prompt_failure_is_fatal_and_keeps_chat_tab_open(self):
        calls = []

        def fake_herdr(*args, **_kwargs):
            calls.append(args)
            if args[:2] == ("pane", "get"):
                return self.pane_response(args)
            if args[:2] == ("worktree", "create"):
                return self.created_response()
            if args[:2] == ("pane", "split"):
                return subprocess.CompletedProcess(
                    args, 0, json.dumps({"result": {"pane": {"pane_id": "w-task:p2"}}}), ""
                )
            if args[:2] == ("agent", "start"):
                return self.agent_response(args)
            if args[:2] == ("agent", "prompt"):
                raise dispatcher.DispatchFailure("exact prompt failure")
            return subprocess.CompletedProcess(args, 0, "", "")

        with mock.patch.dict(os.environ, {
            "HERDR_DISPATCHER": "1",
            "HERDR_DISPATCHER_PROJECT_ROOT": str(self.repo),
            "HERDR_TAB_ID": "w-root:t-chat",
            "HERDR_WORKSPACE_ID": "w-root",
            "HERDR_PANE_ID": "w-root:p-chat",
            "HERDR_DISPATCHER_SESSION_ID": "ses-source",
        }), mock.patch.object(dispatcher, "herdr", side_effect=fake_herdr):
            with self.assertRaisesRegex(dispatcher.DispatchFailure, "exact prompt failure"):
                dispatcher.dispatch_task("prompt-failure", "Implement this request")

        self.assertFalse(any(call[:2] == ("tab", "list") for call in calls))
        self.assertFalse(any(call[:2] == ("workspace", "focus") for call in calls))
        self.assertFalse(any(call[:2] == ("tab", "close") for call in calls))

    def test_prompt_delivery_timeout_submits_once_and_keeps_chat_open(self):
        calls = []

        def fake_herdr(*args, **_kwargs):
            calls.append(args)
            if args[:2] == ("pane", "get"):
                return self.pane_response(args)
            if args[:2] == ("worktree", "create"):
                return self.created_response()
            if args[:2] == ("pane", "split"):
                return subprocess.CompletedProcess(args, 0, "", "")
            if args[:2] == ("agent", "start"):
                return self.agent_response(args)
            if args[:2] == ("agent", "prompt"):
                raise dispatcher.DispatchFailure("agent_prompt_stalled: no observed state change")
            return subprocess.CompletedProcess(args, 0, "", "")

        with mock.patch.dict(os.environ, {
            "HERDR_DISPATCHER": "1",
            "HERDR_DISPATCHER_PROJECT_ROOT": str(self.repo),
            "HERDR_TAB_ID": "w-root:t-chat",
            "HERDR_WORKSPACE_ID": "w-root",
            "HERDR_PANE_ID": "w-root:p-chat",
            "HERDR_DISPATCHER_SESSION_ID": "ses-source",
        }), mock.patch.object(dispatcher, "herdr", side_effect=fake_herdr):
            with self.assertRaisesRegex(dispatcher.DispatchFailure, "agent_prompt_stalled"):
                dispatcher.dispatch_task("delivery-timeout", "Implement this request")

        prompts = [call for call in calls if call[:2] == ("agent", "prompt")]
        self.assertEqual(len(prompts), 1)
        self.assertEqual(prompts[0][-5:], (
            "--wait", "--until", "working", "--timeout", str(dispatcher.PROMPT_DELIVERY_TIMEOUT_MS),
        ))
        self.assertFalse(any(call[:2] == ("tab", "list") for call in calls))
        self.assertFalse(any(call[:2] == ("workspace", "focus") for call in calls))
        self.assertFalse(any(call[:2] == ("tab", "close") for call in calls))

    def test_prompt_exit_zero_without_session_confirmation_is_fatal(self):
        response = self.agent_response(
            ("agent", "prompt", "agent"), status="working", state_change_seq=11
        )
        with mock.patch.object(dispatcher, "herdr", return_value=response) as herdr_mock:
            with self.assertRaisesRegex(dispatcher.DispatchFailure, "not confirmed"):
                dispatcher.prompt_agent_and_confirm_delivery("agent", "request", 10)

        herdr_mock.assert_called_once_with(
            "agent", "prompt", "agent", "request",
            "--wait", "--until", "working",
            "--timeout", str(dispatcher.PROMPT_DELIVERY_TIMEOUT_MS),
        )

    def test_prompt_confirmation_requires_a_new_state_transition(self):
        response = self.agent_response(
            ("agent", "prompt", "agent"), status="working", state_change_seq=10, session=True
        )
        with mock.patch.object(dispatcher, "herdr", return_value=response) as herdr_mock:
            with self.assertRaisesRegex(dispatcher.DispatchFailure, "not confirmed"):
                dispatcher.prompt_agent_and_confirm_delivery("agent", "request", 10)

        herdr_mock.assert_called_once()


if __name__ == "__main__":
    unittest.main()
