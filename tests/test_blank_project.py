#!/usr/bin/env python3

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import blank_project
import lifecycle


def command(*args, cwd=None):
    return subprocess.run(
        args,
        cwd=cwd,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


class BlankProjectTest(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix="herdr-blank-project-test-"))
        self.projects = self.temp / "Projects"
        self.projects.mkdir()
        self.state = self.temp / "state"
        self.environment = mock.patch.dict(os.environ, {
            "HERDR_PLUGIN_STATE_DIR": str(self.state),
            "HERDR_PROJECTS_ROOT": str(self.projects),
            "GIT_AUTHOR_NAME": "Test User",
            "GIT_AUTHOR_EMAIL": "test@example.com",
            "GIT_COMMITTER_NAME": "Test User",
            "GIT_COMMITTER_EMAIL": "test@example.com",
        })
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        shutil.rmtree(self.temp, ignore_errors=True)

    def test_name_and_parent_validation(self):
        self.assertEqual(blank_project.normalize_name("  useful project  "), "useful project")
        for invalid in ("", "  ", ".", "..", "one/two", "one\\two", "bad\0name", "bad\nname"):
            with self.subTest(invalid=invalid):
                with self.assertRaises(blank_project.ProjectFailure):
                    blank_project.normalize_name(invalid)
        with self.assertRaisesRegex(blank_project.ProjectFailure, "does not exist"):
            blank_project.normalize_parent(str(self.temp / "missing"))

    def test_existing_non_empty_and_symlink_destinations_are_rejected(self):
        occupied = self.projects / "occupied"
        occupied.mkdir()
        (occupied / "keep.txt").write_text("keep\n")
        with self.assertRaisesRegex(blank_project.ProjectFailure, "not empty"):
            blank_project.destination_for("occupied", self.projects)

        target = self.temp / "target"
        target.mkdir()
        (self.projects / "linked").symlink_to(target, target_is_directory=True)
        with self.assertRaisesRegex(blank_project.ProjectFailure, "symbolic link"):
            blank_project.destination_for("linked", self.projects)

    def test_local_creation_has_only_git_metadata_and_empty_initial_commit(self):
        destination = blank_project.destination_for("blank", self.projects)
        created = blank_project.create_local_repository(destination)

        self.assertEqual(created, lifecycle.canonical(destination))
        self.assertEqual({path.name for path in destination.iterdir()}, {".git"})
        self.assertEqual(command("git", "branch", "--show-current", cwd=destination).stdout.strip(), "main")
        self.assertEqual(command("git", "log", "-1", "--format=%s", cwd=destination).stdout.strip(), "Initial commit")
        self.assertEqual(command("git", "show", "--format=", "--name-only", "HEAD", cwd=destination).stdout.strip(), "")

    def test_existing_empty_destination_can_be_initialized(self):
        destination = self.projects / "existing"
        destination.mkdir()
        self.assertEqual(
            blank_project.create_local_repository(blank_project.destination_for("existing", self.projects)),
            lifecycle.canonical(destination),
        )

    def test_github_failure_keeps_registers_and_opens_local_repository(self):
        opened = []

        def fail_github(*_args):
            raise blank_project.ProjectFailure("gh auth status failed precisely")

        with mock.patch.object(blank_project, "create_github_repository", side_effect=fail_github), \
             mock.patch.object(blank_project, "register_and_open", side_effect=lambda path: opened.append(path) or "w-new"):
            result = blank_project.create_project(
                "kept", self.projects, github=True, visibility="public"
            )

        destination = self.projects / "kept"
        self.assertTrue((destination / ".git").is_dir())
        self.assertEqual(result["github_error"], "gh auth status failed precisely")
        self.assertEqual(opened, [lifecycle.canonical(destination)])

    def test_github_commands_authenticate_create_connect_and_push_in_order(self):
        calls = []

        def fake_run(command, *, cwd=None):
            calls.append((command, cwd))
            return subprocess.CompletedProcess(command, 0, "", "")

        with mock.patch.object(blank_project, "run_command", side_effect=fake_run):
            blank_project.create_github_repository(self.projects, "sample", "private")

        self.assertEqual(calls, [
            (["gh", "auth", "status"], None),
            (["gh", "repo", "create", "sample", "--private", "--source", ".", "--remote", "origin"], self.projects),
            (["git", "push", "-u", "origin", "main"], self.projects),
        ])

    def test_local_then_github_then_registration_orchestration(self):
        calls = []
        destination = lifecycle.canonical(self.projects / "ordered")
        with mock.patch.object(
            blank_project, "create_local_repository", side_effect=lambda path: calls.append(("local", path)) or destination
        ), mock.patch.object(
            blank_project, "create_github_repository", side_effect=lambda *args: calls.append(("github", *args))
        ), mock.patch.object(
            blank_project, "register_and_open", side_effect=lambda path: calls.append(("open", path)) or "w-ordered"
        ):
            result = blank_project.create_project("ordered", self.projects, github=True, visibility="public")

        self.assertEqual([call[0] for call in calls], ["local", "github", "open"])
        self.assertEqual(result["workspace_id"], "w-ordered")
        self.assertIsNone(result["github_error"])

    def test_registration_precedes_primary_workspace_chat_opening(self):
        calls = []
        with mock.patch.object(blank_project, "remember_root", side_effect=lambda path: calls.append(("register", path))), \
             mock.patch.object(
                 blank_project.dispatcher, "open_chat_tab", side_effect=lambda path: calls.append(("chat", path)) or "w-project"
             ):
            workspace_id = blank_project.register_and_open(self.projects)

        self.assertEqual(workspace_id, "w-project")
        self.assertEqual(calls, [("register", self.projects), ("chat", self.projects)])

    def test_cancellation_before_creation_is_non_destructive(self):
        with mock.patch("builtins.input", side_effect=EOFError), \
             mock.patch.object(blank_project, "create_project") as create_mock:
            with self.assertRaises(blank_project.Cancelled):
                blank_project.interactive()
        create_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
