"""Log retention: internal scan/victim/compression phase characterization."""

import json
import os
import unittest

from log_retention_support import DAY, HOUR, Workspace, ample_free


class InternalPhaseCharacterizationTests(Workspace):
    """Pins the scan / candidate / victim-choice / deletion-failure / CLI-output behavior phase by phase."""

    def entries_summary(self, entries):
        return sorted(
            (
                os.path.relpath(e.path, self.root),
                e.kind,
                e.size,
                e.protected,
                sorted(os.path.basename(f.path) for f in e.files),
            )
            for e in entries
        )

    def test_scan_root_assigns_sizes_kinds_and_protection(self):
        self.make_file("app.log", 10, 3 * DAY)
        self.make_file("fresh.log", 20, 60)
        self.make_file("notes.txt", 30, 3 * DAY)
        self.make_file("chats/c.log", 40, 3 * DAY)
        self.make_dir("release-1", {"a.log": 100, "sub/b.txt": 50}, 5 * DAY)
        self.make_dir("release-2", {"a.log": 7}, 4 * DAY)
        self.make_dir("failed-1", {"a.log": 8}, 6 * DAY)
        self.make_dir("failed-2", {"a.log": 9}, 3 * DAY)
        self.make_file("failed-3/live.log", 5, 60)
        self.stamp(self.root / "failed-3", 7 * DAY)
        (self.root / "link.log").symlink_to(self.root / "app.log")

        entries = self.lr.scan_root(str(self.root), self.now, self.cfg())

        self.assertEqual(
            self.entries_summary(entries),
            [
                ("app.log", "file", 10, None, ["app.log"]),
                ("failed-1", "dir", 8, None, ["a.log"]),
                ("failed-2", "dir", 9, "last-failure", ["a.log"]),
                ("failed-3", "dir", 5, "recent", ["live.log"]),
                ("fresh.log", "file", 20, "recent", ["fresh.log"]),
                ("release-1", "dir", 150, None, ["a.log", "b.txt"]),
                ("release-2", "dir", 7, "last-deploy", ["a.log"]),
            ],
        )

    def test_scan_root_protects_the_newest_evidence_dir_even_when_it_is_recent_and_honours_only_globs(
        self,
    ):
        self.make_dir("release-1", {"a.log": 1}, 2 * DAY)
        self.make_dir("release-2", {"a.log": 1}, 60)
        self.make_file("out__1.log", 1, 3 * DAY)
        self.make_file("out.log", 1, 3 * DAY)

        narrowed = self.lr.scan_root(str(self.root), self.now, self.cfg(only_globs=("*__*.log",)))
        evidence = self.lr.scan_root(
            str(self.root), self.now, self.cfg(only_globs=("*__*.log",), manage_evidence_dirs=True)
        )

        self.assertEqual(
            self.entries_summary(narrowed), [("out__1.log", "file", 1, None, ["out__1.log"])]
        )
        self.assertEqual(
            self.entries_summary(evidence),
            [
                ("out__1.log", "file", 1, None, ["out__1.log"]),
                ("release-1", "dir", 1, None, ["a.log"]),
                ("release-2", "dir", 1, "last-deploy", ["a.log"]),
            ],
        )

    def test_compression_candidates_cover_every_exclusion(self):
        cfg = self.cfg(gzip_after_seconds=DAY, max_file_bytes=1000)
        self.make_file("old.log", 10, 2 * DAY)
        self.make_file("healthcheck.log.3", 10, 2 * DAY)
        self.make_file("old.log.gz", 10, 2 * DAY)
        self.make_file("healthcheck.log.zst", 10, 2 * DAY)
        self.make_file("young.log", 10, HOUR)
        self.make_file("big-young.log", 5000, HOUR)
        self.make_file("big-recent.log", 5000, 60)
        self.make_dir(
            "release-1", {"a.txt": 10, "b.gz": 10, "c.tmp": 10, "d.zip": 10, "e.log": 10}, 2 * DAY
        )
        self.make_dir("failed-1", {"big.dat": 5000, "small.dat": 10}, HOUR)
        entries = self.lr.scan_root(str(self.root), self.now, cfg)

        found = self.lr._compression_candidates(entries, cfg, self.now)

        self.assertEqual(
            sorted((e.kind, os.path.relpath(i.path, self.root)) for e, i in found),
            [
                ("dir", "failed-1/big.dat"),
                ("dir", "release-1/a.txt"),
                ("dir", "release-1/e.log"),
                ("file", "big-young.log"),
                ("file", "healthcheck.log.3"),
                ("file", "old.log"),
            ],
        )

    def victim(self, entries, cfg, violated, skip=(), now=None):
        picked = self.lr._pick_victim(
            entries, cfg, violated, set(skip), self.now if now is None else now
        )
        if picked is None:
            return None
        entry, info, reason = picked
        return (
            os.path.relpath(entry.path, self.root),
            None if info is None else os.path.relpath(info.path, self.root),
            reason,
        )

    def test_pick_victim_chooses_per_violation_with_protection_and_skip(self):
        cfg = self.cfg(max_file_bytes=1000)
        self.make_file("a.log", 5000, 5 * DAY)
        self.make_file("b.log", 5000, 6 * DAY)
        self.make_file("small.log", 10, 9 * DAY)
        self.make_dir("release-1", {"deploy.log": 5000, "x.log": 5000}, 8 * DAY)
        self.make_dir("release-2", {"deploy.log": 5000}, 4 * DAY)
        self.make_dir("failed-1", {"big.log": 5000, "other.log": 5000}, 7 * DAY)
        self.make_file("failed-1/fresh.log", 5000, 60)
        self.stamp(self.root / "failed-1", 7 * DAY)
        entries = self.lr.scan_root(str(self.root), self.now, cfg)

        # Oldest oversized unprotected file wins and is deleted alone (release-2 is the last deploy).
        self.assertEqual(
            self.victim(entries, cfg, ["file-size"]),
            ("release-1", "release-1/deploy.log", "file-size"),
        )
        self.assertEqual(
            self.victim(
                entries, cfg, ["file-size"], skip={str(self.root / "release-1/deploy.log")}
            ),
            ("release-1", "release-1/x.log", "file-size"),
        )
        # failed-1 is protected as last-failure, so its oversized files are never chosen.
        skip = {
            str(self.root / p)
            for p in ("release-1/deploy.log", "release-1/x.log", "b.log", "a.log")
        }
        self.assertIsNone(self.victim(entries, cfg, ["file-size"], skip=skip))
        # With a deletion reason too, the oldest whole unprotected entry takes over, labelled by the first reason.
        self.assertEqual(
            self.victim(entries, cfg, ["file-size", "free", "size"], skip=skip),
            ("small.log", None, "free"),
        )
        self.assertEqual(self.victim(entries, cfg, ["size", "files"]), ("small.log", None, "size"))
        self.assertEqual(
            self.victim(entries, cfg, ["files", "free"], skip={str(self.root / "small.log")}),
            ("release-1", None, "files"),
        )

    def test_pick_victim_returns_none_without_a_deletion_reason_or_candidate(self):
        cfg = self.cfg()
        self.make_file("a.log", 10, 5 * DAY)
        entries = self.lr.scan_root(str(self.root), self.now, cfg)

        self.assertIsNone(self.victim(entries, cfg, []))
        self.assertIsNone(self.victim(entries, cfg, ["file-size"]))
        self.assertIsNone(self.victim(entries, cfg, ["size"], skip={str(self.root / "a.log")}))
        self.assertEqual(self.victim(entries, cfg, ["size"]), ("a.log", None, "size"))

    def failing_delete(self, name, target):
        original = getattr(self.lr, name)

        def wrapper(root_real, victim):
            if os.path.basename(victim.path) == target:
                raise PermissionError("denied")
            return original(root_real, victim)

        return wrapper

    def test_failed_entry_deletion_is_reported_skipped_and_the_next_oldest_goes(self):
        for index in range(4):
            self.make_file(f"app-{index}.log", 100, (10 - index) * DAY)
        self.lr._delete_entry = self.failing_delete("_delete_entry", "app-0.log")

        report = self.lr.apply(self.root, self.cfg(max_files=2), free_fn=ample_free, now=self.now)

        self.assertEqual(
            [
                (a.kind, os.path.basename(a.path), a.reason, a.bytes, a.detail)
                for a in report.actions
            ],
            [
                ("delete-failed", "app-0.log", "files", None, "PermissionError"),
                ("deleted", "app-1.log", "files", 100, None),
                ("deleted", "app-2.log", "files", 100, None),
            ],
        )
        self.assertEqual(self.names(), ["app-0.log", "app-3.log"])
        self.assertEqual((report.exit_code, report.violations, report.managed_entries), (0, [], 2))

    def test_failed_member_deletion_skips_that_file_and_a_violation_stays_when_nothing_else_can_go(
        self,
    ):
        self.make_dir("release-1", {"big.gz": 5000, "ok.gz": 10}, 5 * DAY)
        self.make_dir("release-2", {"a.gz": 10}, 4 * DAY)
        self.lr._delete_member = lambda root_real, info: (_ for _ in ()).throw(
            PermissionError("denied")
        )

        report = self.lr.apply(
            self.root, self.cfg(max_file_bytes=1000), free_fn=ample_free, now=self.now
        )

        kinds = [
            (a.kind, os.path.relpath(a.path, self.root), a.reason, a.detail, a.protected)
            for a in report.actions
        ]
        self.assertEqual(
            kinds,
            [
                ("delete-failed", "release-1/big.gz", "file-size", "PermissionError", None),
                ("kept", "release-2", None, None, "last-deploy"),
            ],
        )
        self.assertEqual(report.violations, ["file-size"])
        self.assertTrue((self.root / "release-1/big.gz").exists())
        self.assertEqual(report.exit_code, 2)

    def test_a_dir_with_a_single_oversized_file_is_failed_whole_and_skipped_by_every_member(self):
        self.make_dir("release-1", {"big.gz": 5000}, 5 * DAY)
        self.make_dir("release-2", {"a.gz": 10}, 4 * DAY)
        self.lr._delete_entry = self.failing_delete("_delete_entry", "release-1")

        report = self.lr.apply(
            self.root, self.cfg(max_file_bytes=1000), free_fn=ample_free, now=self.now
        )

        self.assertEqual(
            [
                (a.kind, os.path.relpath(a.path, self.root), a.reason, a.bytes)
                for a in report.actions
            ],
            [("delete-failed", "release-1", "file-size", None), ("kept", "release-2", None, None)],
        )

    def test_kept_actions_appear_only_when_a_criterion_was_violated_at_the_start(self):
        self.make_dir("release-1", {"a.log": 5000}, 3 * DAY)
        self.make_dir("failed-1", {"a.log": 5000}, 2 * DAY)
        self.make_file("active.log", 10, 60)

        quiet = self.lr.plan(self.root, self.cfg(), free_fn=ample_free, now=self.now)
        loud = self.lr.plan(self.root, self.cfg(max_files=1), free_fn=ample_free, now=self.now)

        self.assertEqual(quiet.actions, [])
        self.assertEqual(
            [(a.kind, os.path.basename(a.path), a.protected) for a in loud.actions],
            [
                ("kept", "active.log", "recent"),
                ("kept", "failed-1", "last-failure"),
                ("kept", "release-1", "last-deploy"),
            ],
        )
        self.assertEqual((loud.initial_violations, loud.violations), (["files"], ["files"]))

    def test_compression_rescans_so_the_report_counts_the_gz_names_and_sizes(self):
        content = b"a" * 100000
        self.make_file("old.log", 0, 3 * DAY, content=content)
        self.make_file("keep.log", 10, HOUR)

        report = self.lr.apply(
            self.root, self.cfg(gzip_after_seconds=DAY), free_fn=ample_free, now=self.now
        )

        self.assertEqual(
            [(a.kind, os.path.basename(a.path)) for a in report.actions],
            [("compressed", "old.log")],
        )
        self.assertEqual(self.names(), ["keep.log", "old.log.gz"])
        self.assertEqual(report.managed_entries, 2)
        self.assertEqual(report.managed_bytes, (self.root / "old.log.gz").stat().st_size + 10)

    def test_dry_run_compression_is_reported_without_touching_anything(self):
        self.make_file("old.log", 100, 3 * DAY)
        before = self.snapshot()

        report = self.lr.plan(
            self.root, self.cfg(gzip_after_seconds=DAY), free_fn=ample_free, now=self.now
        )

        self.assertEqual([(a.kind, a.dry_run) for a in report.actions], [("compressed", True)])
        self.assertEqual(self.snapshot(), before)

    def test_alert_state_write_failure_is_printed_and_json_carries_the_alert(self):
        self.make_dir("release-1", {"a.log": 5000}, DAY)
        env_file = self.base / "hypercal.env"
        env_file.write_text("BOT_TOKEN=1:T\nBOT_ADMIN_ID=42\n")
        sent = []
        missing = self.base / "no-such-dir" / "state.json"
        args = (
            "--alert",
            "--env-file",
            str(env_file),
            "--max-dir-mb",
            "0.001",
            "--state-file",
            str(missing),
        )

        code, out, _ = self.run_main(*args, sender=lambda *a: sent.append(a))
        self.assertEqual(code, 2)
        self.assertEqual(len(sent), 1)
        self.assertIn("ALERT_STATE_FAILED FileNotFoundError", out)
        self.assertNotIn("ALERT_FAILED", out)

        code, out, _ = self.run_main(*args, "--json", sender=lambda *a: sent.append(a))
        document = json.loads(out)
        self.assertEqual(document["alert"]["sent"], ["unresolved"])
        self.assertEqual(document["alert"]["state_error"], "FileNotFoundError")
        self.assertEqual(document["alert"]["failed"], None)

    def test_dry_run_never_alerts_and_json_has_no_alert_key_without_the_flag(self):
        self.make_dir("release-1", {"a.log": 5000}, DAY)
        sent = []

        code, out, _ = self.run_main(
            "--alert",
            "--dry-run",
            "--json",
            "--max-dir-mb",
            "0.001",
            sender=lambda *a: sent.append(a),
        )

        self.assertEqual((code, sent), (2, []))
        self.assertNotIn("alert", json.loads(out))
        self.assertFalse((self.root / ".log-retention-state.json").exists())


if __name__ == "__main__":
    unittest.main()
