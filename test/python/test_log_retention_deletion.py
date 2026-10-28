"""Log retention: no-deletion baseline, deletion order and protected-only violations."""

import os
import unittest
from pathlib import Path

from log_retention_support import AMPLE, DAY, HOUR, Workspace, ample_free


class NoDeletionWhenHealthyTests(Workspace):
    def test_nothing_is_deleted_when_every_criterion_holds_even_with_many_old_files(self):
        for index in range(30):
            self.make_file(f"app-{index}.log", 100, 30 * DAY)
        self.make_dir("release-a", {"deploy.log": 100}, 40 * DAY)
        self.make_dir("failed-a", {"deploy.log": 100}, 41 * DAY)
        before = self.snapshot()

        report = self.lr.apply(
            self.root,
            self.cfg(max_dir_bytes=10**6, max_files=100),
            free_fn=ample_free,
            now=self.now,
        )

        self.assertEqual(report.exit_code, 0)
        self.assertEqual(self.deleted(report), [])
        self.assertEqual(self.snapshot(), before)

    def test_defaults_match_the_documented_values(self):
        args = self.lr.build_parser().parse_args(["--root", "/x"])
        self.assertEqual(
            (
                args.max_dir_mb,
                args.max_file_mb,
                args.max_files,
                args.min_free_mb,
                args.min_free_percent,
            ),
            (1024, 200, 400, 2048, 5),
        )
        self.assertEqual(args.gzip_after_days, 1)
        self.assertEqual(args.env_file, "/opt/hypercal/.env")
        self.assertIsNone(args.state_file)
        self.assertFalse(args.alert or args.dry_run or args.json)


class DeletionOrderTests(Workspace):
    def test_dir_size_cap_removes_oldest_first_and_spares_newest_release_and_failed(self):
        self.make_dir("release-1", {"deploy.log": 1000}, 9 * DAY)
        self.make_dir("release-2", {"deploy.log": 1000}, 8 * DAY)  # newest release: last deploy
        self.make_dir("failed-1", {"deploy.log": 1000}, 7 * DAY)
        self.make_dir("failed-2", {"deploy.log": 1000}, 6 * DAY)  # newest failed: last failure
        self.make_file("l1.log", 1000, 5 * DAY)
        self.make_file("l2.log", 1000, 4 * DAY)
        self.make_file("l3.log", 1000, 3 * DAY)

        report = self.lr.apply(
            self.root, self.cfg(max_dir_bytes=4000), free_fn=ample_free, now=self.now
        )

        self.assertEqual(self.deleted(report), ["release-1", "failed-1", "l1.log"])
        self.assertEqual(self.names(), ["failed-2", "l2.log", "l3.log", "release-2"])
        self.assertEqual({a.reason for a in report.actions if a.kind == "deleted"}, {"size"})
        self.assertEqual(report.exit_code, 0)
        kept = {os.path.basename(a.path): a.protected for a in report.actions if a.kind == "kept"}
        self.assertEqual(kept, {"release-2": "last-deploy", "failed-2": "last-failure"})

    def test_file_count_cap_removes_just_enough_oldest_entries(self):
        for index in range(6):
            self.make_file(f"app-{index}.log", 10, (10 - index) * DAY)

        report = self.lr.apply(self.root, self.cfg(max_files=4), free_fn=ample_free, now=self.now)

        self.assertEqual(self.deleted(report), ["app-0.log", "app-1.log"])
        self.assertEqual({a.reason for a in report.actions if a.kind == "deleted"}, {"files"})
        self.assertEqual(self.names(), ["app-2.log", "app-3.log", "app-4.log", "app-5.log"])

    def test_oversized_file_is_deleted_alone_not_its_whole_directory(self):
        self.make_dir("release-old", {"deploy.log": 100, "dump.bin": 5000}, 5 * DAY)
        self.make_dir("release-new", {"deploy.log": 100}, 1 * DAY)

        report = self.lr.apply(
            self.root, self.cfg(max_file_bytes=1000), free_fn=ample_free, now=self.now
        )

        self.assertEqual(
            self.deleted(report), ["dump.bin.gz"]
        )  # incompressible: still over the cap after gzip
        self.assertTrue((self.root / "release-old/deploy.log").exists())
        self.assertFalse((self.root / "release-old/dump.bin.gz").exists())
        self.assertEqual([a.reason for a in report.actions if a.kind == "deleted"], ["file-size"])

    def test_oversized_only_file_of_a_directory_removes_the_directory(self):
        self.make_dir("release-old", {"dump.bin": 5000}, 5 * DAY)
        self.make_dir("release-new", {"deploy.log": 100}, 1 * DAY)

        self.lr.apply(self.root, self.cfg(max_file_bytes=1000), free_fn=ample_free, now=self.now)

        self.assertEqual(self.names(), ["release-new"])

    def test_oversized_file_in_the_last_deploy_is_kept_and_reported_unresolved(self):
        self.make_dir("release-new", {"dump.bin": 5000}, 5 * DAY)

        report = self.lr.apply(
            self.root, self.cfg(max_file_bytes=1000), free_fn=ample_free, now=self.now
        )

        self.assertTrue((self.root / "release-new/dump.bin.gz").exists())
        self.assertEqual(report.exit_code, 2)
        self.assertIn("file-size", report.violations)

    def test_low_free_space_deletes_oldest_until_the_floor_is_met_then_stops(self):
        base_free = 5000
        for index in range(5):
            self.make_file(f"app-{index}.log", 1000, (10 - index) * DAY)
        initial = 5000

        def free_that_grows_with_deletions(root):
            used = sum(p.stat().st_size for p in Path(root).iterdir())
            return base_free + (initial - used), AMPLE

        report = self.lr.apply(
            self.root,
            self.cfg(min_free_bytes=base_free + 2500),
            free_fn=free_that_grows_with_deletions,
            now=self.now,
        )

        self.assertEqual(self.deleted(report), ["app-0.log", "app-1.log", "app-2.log"])
        self.assertEqual({a.reason for a in report.actions if a.kind == "deleted"}, {"free"})
        self.assertEqual(self.names(), ["app-3.log", "app-4.log"])
        self.assertEqual(report.exit_code, 0)

    def test_free_percent_floor_triggers_deletion_too(self):
        self.make_file("old.log", 1000, 5 * DAY)
        self.make_file("older.log", 1000, 6 * DAY)

        def free(root):
            used = sum(p.stat().st_size for p in Path(root).iterdir())
            return 100 + (2000 - used), 10_000

        report = self.lr.apply(
            self.root, self.cfg(min_free_percent=10.0), free_fn=free, now=self.now
        )

        # 1% free -> delete older.log -> 11% >= 10%, so old.log survives.
        self.assertEqual(self.deleted(report), ["older.log"])
        self.assertEqual(self.names(), ["old.log"])


class ProtectedOnlyViolationTests(Workspace):
    def setUp(self):
        super().setUp()
        self.make_dir("release-1", {"deploy.log": 5000}, 3 * DAY)
        self.make_dir("failed-1", {"deploy.log": 5000}, 2 * DAY)
        self.env_file = self.base / "hypercal.env"
        self.env_file.write_text("BOT_TOKEN=123456:SECRETTOKEN\nBOT_ADMIN_ID=42\n")
        self.sent = []

    def sender(self, token, chat_id, text):
        self.sent.append((token, chat_id, text))

    def run_alerting(self, now):
        return self.run_main(
            "--alert",
            "--env-file",
            str(self.env_file),
            "--max-dir-mb",
            "0.001",
            sender=self.sender,
            now=now,
        )

    def test_violation_with_only_protected_entries_exits_2_deletes_nothing_and_alerts_once_per_6h(
        self,
    ):
        before = self.snapshot()

        code, out, _ = self.run_alerting(self.now)
        self.assertEqual(code, 2)
        self.assertIn("KEPT", out)
        self.assertIn("protected=last-deploy", out)
        self.assertEqual(len(self.sent), 1)

        code, _, _ = self.run_alerting(self.now + 60)
        self.assertEqual(code, 2)
        self.assertEqual(len(self.sent), 1, "identical alert kind inside 6h must be rate limited")

        code, _, _ = self.run_alerting(self.now + 6 * HOUR + 60)
        self.assertEqual(len(self.sent), 2)

        state = self.root / ".log-retention-state.json"
        self.assertTrue(state.exists())
        after = {
            k: v for k, v in self.snapshot().items() if not k.endswith(".log-retention-state.json")
        }
        self.assertEqual(after, before)

    def test_unmanaged_state_file_never_counts_as_a_managed_entry(self):
        self.run_alerting(self.now)
        report = self.lr.plan(self.root, self.cfg(), free_fn=ample_free, now=self.now)
        self.assertEqual(report.managed_entries, 2)


if __name__ == "__main__":
    unittest.main()
