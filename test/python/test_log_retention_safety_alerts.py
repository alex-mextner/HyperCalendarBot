"""Log retention: root safety, dry run, alerts and output formats."""

import io
import json
import os
import subprocess
import sys
import unittest

from log_retention_support import AMPLE, DAY, SCRIPT, Workspace, ample_free


class SafetyTests(Workspace):
    def test_root_that_is_a_symlink_is_refused_even_with_a_trailing_slash(self):
        link = self.base / "link"
        os.symlink(self.root, link)
        for candidate in (str(link), str(link) + "/"):
            with self.assertRaises(self.lr.RootRefused):
                self.lr.validate_root(candidate)

    def test_filesystem_root_empty_missing_and_file_roots_are_refused(self):
        plain = self.base / "plain.txt"
        plain.write_text("x")
        for candidate in ("/", "//", "/.", "", "   ", str(self.base / "missing"), str(plain)):
            with self.subTest(root=candidate), self.assertRaises(self.lr.RootRefused):
                self.lr.validate_root(candidate)

    def test_main_refuses_with_exit_3_and_touches_nothing(self):
        link = self.base / "link"
        os.symlink(self.root, link)
        self.make_file("old.log", 100, 9 * DAY)
        before = self.snapshot()
        for candidate in (str(link), "/"):
            out, err = io.StringIO(), io.StringIO()
            code = self.lr.main(
                ["--root", candidate, "--max-files", "0"], free_fn=ample_free, out=out, err=err
            )
            self.assertEqual(code, 3)
            self.assertIn("REFUSED", err.getvalue())
        self.assertEqual(self.snapshot(), before)

    def test_cli_refuses_filesystem_root_as_a_subprocess(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--root", "/"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 3)
        self.assertIn("REFUSED", result.stderr)

    def test_usage_errors_do_not_collide_with_the_violation_exit_code(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--bogus"], capture_output=True, text=True, check=False
        )
        self.assertEqual(result.returncode, 64)


class DryRunTests(Workspace):
    def test_dry_run_changes_nothing_but_reports_what_it_would_do(self):
        self.make_dir("release-1", {"deploy.log": 1000}, 9 * DAY)
        self.make_dir("release-2", {"deploy.log": 1000}, 8 * DAY)
        self.make_file("old.log", 1000, 5 * DAY)
        self.make_file("new.log", 1000, 3 * DAY)
        env_file = self.base / "hypercal.env"
        env_file.write_text("BOT_TOKEN=t\nBOT_ADMIN_ID=1\n")
        before = self.snapshot()
        sent = []

        code, out, _ = self.run_main(
            "--dry-run",
            "--alert",
            "--env-file",
            str(env_file),
            "--max-dir-mb",
            "0.002",
            "--gzip-after-days",
            "1",
            sender=lambda *a: sent.append(a),
        )

        self.assertEqual(self.snapshot(), before)
        self.assertFalse((self.root / ".log-retention-state.json").exists())
        self.assertEqual(sent, [])
        self.assertIn("DELETED", out)
        self.assertIn("COMPRESSED", out)
        self.assertEqual(code, 0)

    def test_plan_simulation_credits_freed_bytes_toward_the_free_space_floor(self):
        for index in range(5):
            self.make_file(f"app-{index}.log", 1000, (10 - index) * DAY)
        before = self.snapshot()

        report = self.lr.plan(
            self.root,
            self.cfg(min_free_bytes=5000 + 2500),
            free_fn=lambda r: (5000, AMPLE),
            now=self.now,
        )

        self.assertEqual(self.deleted(report), ["app-0.log", "app-1.log", "app-2.log"])
        self.assertEqual(self.snapshot(), before)


class AlertTests(Workspace):
    def setUp(self):
        super().setUp()
        self.env_file = self.base / "hypercal.env"
        self.env_file.write_text(
            "# comment\nexport BOT_TOKEN='123456:SECRETTOKEN'\nBOT_ADMIN_ID=\"42\"\nOTHER=1\n"
        )
        self.sent = []

    def sender(self, token, chat_id, text):
        self.sent.append((token, chat_id, text))

    def test_deletion_alert_is_sent_exactly_once_and_never_leaks_the_token(self):
        for index in range(4):
            self.make_file(f"app-{index}.log", 100, (10 - index) * DAY)

        code, out, err = self.run_main(
            "--alert", "--env-file", str(self.env_file), "--max-files", "2", sender=self.sender
        )

        self.assertEqual(code, 0)
        self.assertEqual(len(self.sent), 1)
        token, chat_id, text = self.sent[0]
        self.assertEqual((token, chat_id), ("123456:SECRETTOKEN", "42"))
        self.assertNotIn("SECRETTOKEN", text)
        self.assertNotIn("SECRETTOKEN", out + err)
        self.assertIn("deleted 2", text)

    def test_failing_sender_prints_the_exception_name_only_and_keeps_the_exit_code(self):
        for index in range(4):
            self.make_file(f"app-{index}.log", 100, (10 - index) * DAY)

        def failing(token, chat_id, text):
            raise ConnectionRefusedError(f"https://api.telegram.org/bot{token}/sendMessage")

        code, out, err = self.run_main(
            "--alert", "--env-file", str(self.env_file), "--max-files", "2", sender=failing
        )

        self.assertEqual(code, 0)
        self.assertIn("ALERT_FAILED ConnectionRefusedError", out)
        self.assertNotIn("SECRETTOKEN", out + err)
        self.assertNotIn("telegram", out + err)

    def test_failed_alert_is_retried_on_the_next_run(self):
        self.make_dir("release-1", {"a.log": 5000}, DAY)

        def failing(token, chat_id, text):
            raise OSError("down")

        args = ("--alert", "--env-file", str(self.env_file), "--max-dir-mb", "0.001")
        self.run_main(*args, sender=failing)
        self.run_main(*args, sender=self.sender)

        self.assertEqual(len(self.sent), 1)

    def test_missing_credentials_fail_the_alert_without_changing_the_exit_code(self):
        self.make_dir("release-1", {"a.log": 5000}, DAY)
        empty = self.base / "empty.env"
        empty.write_text("OTHER=1\n")

        code, out, _ = self.run_main(
            "--alert", "--env-file", str(empty), "--max-dir-mb", "0.001", sender=self.sender
        )

        self.assertEqual(code, 2)
        self.assertIn("ALERT_FAILED MissingCredentials", out)
        self.assertEqual(self.sent, [])

    def test_free_space_below_the_floor_after_cleanup_alerts_and_exits_2(self):
        self.make_file("old.log", 100, 5 * DAY)
        code, _out, _ = self.run_main(
            "--alert",
            "--env-file",
            str(self.env_file),
            "--min-free-mb",
            "1",
            "--min-free-percent",
            "0",
            sender=self.sender,
            free_fn=lambda root: (1000, AMPLE),
        )

        self.assertEqual(code, 2)
        self.assertEqual(len(self.sent), 1)
        self.assertIn("below the floor", self.sent[0][2])
        self.assertFalse((self.root / "old.log").exists())

    def test_free_space_within_twice_the_floor_sends_an_early_warning_without_deleting(self):
        self.make_file("old.log", 100, 5 * DAY)
        floor_mb = 100
        free = int(1.5 * floor_mb * 1024 * 1024)

        code, _, _ = self.run_main(
            "--alert",
            "--env-file",
            str(self.env_file),
            "--min-free-mb",
            str(floor_mb),
            "--min-free-percent",
            "0",
            sender=self.sender,
            free_fn=lambda root: (free, AMPLE),
        )

        self.assertEqual(code, 0)
        self.assertTrue((self.root / "old.log").exists())
        self.assertEqual(len(self.sent), 1)
        self.assertIn("disk-space watchdog", self.sent[0][2])

    def test_plenty_of_free_space_and_no_deletion_sends_nothing(self):
        self.make_file("old.log", 100, 5 * DAY)

        code, _, _ = self.run_main("--alert", "--env-file", str(self.env_file), sender=self.sender)

        self.assertEqual(code, 0)
        self.assertEqual(self.sent, [])

    def test_two_alert_kinds_in_one_run_share_a_single_message(self):
        for index in range(3):
            self.make_file(f"app-{index}.log", 100, (10 - index) * DAY)

        self.run_main(
            "--alert",
            "--env-file",
            str(self.env_file),
            "--max-files",
            "1",
            "--min-free-mb",
            "100",
            "--min-free-percent",
            "0",
            sender=self.sender,
            free_fn=lambda root: (int(1.5 * 100 * 1024 * 1024), AMPLE),
        )

        self.assertEqual(len(self.sent), 1)
        self.assertIn("deleted 2", self.sent[0][2])
        self.assertIn("disk-space watchdog", self.sent[0][2])

    def test_state_file_option_is_honoured(self):
        self.make_dir("release-1", {"a.log": 5000}, DAY)
        state = self.base / "state.json"

        self.run_main(
            "--alert",
            "--env-file",
            str(self.env_file),
            "--max-dir-mb",
            "0.001",
            "--state-file",
            str(state),
            sender=self.sender,
        )

        self.assertTrue(state.exists())
        self.assertFalse((self.root / ".log-retention-state.json").exists())
        self.assertIn("unresolved", json.loads(state.read_text()))


class OutputTests(Workspace):
    def test_text_output_has_one_line_per_action_and_a_summary(self):
        self.make_file("old.log", 100, 5 * DAY)
        self.make_file("older.log", 100, 6 * DAY)

        code, out, _ = self.run_main("--max-files", "1")

        lines = out.splitlines()
        self.assertEqual(code, 0)
        self.assertEqual(lines[0], f"DELETED {self.root}/older.log reason=files bytes=100")
        self.assertTrue(lines[-1].startswith("SUMMARY "))
        self.assertIn("status=ok", lines[-1])

    def test_json_report_is_machine_readable(self):
        self.make_dir("release-1", {"a.log": 5000}, DAY)

        code, out, _ = self.run_main("--json", "--max-dir-mb", "0.001")

        report = json.loads(out)
        self.assertEqual(code, 2)
        self.assertEqual(report["exit_code"], 2)
        self.assertEqual(report["status"], "violated")
        self.assertEqual(report["violations"], ["size"])
        self.assertEqual(report["actions"][0]["kind"], "kept")

    def test_free_space_override_file_is_read_by_the_cli(self):
        self.make_file("old.log", 100, 5 * DAY)
        self.make_file("older.log", 100, 6 * DAY)
        free_file = self.base / "free.txt"
        free_file.write_text("1000")
        env = dict(os.environ, LOG_RETENTION_FREE_BYTES_FILE=str(free_file))

        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--root",
                str(self.root),
                "--min-free-mb",
                "1",
                "--min-free-percent",
                "0",
            ],
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )

        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.names(), [])


if __name__ == "__main__":
    unittest.main()
