"""Log retention: compression, managed-set boundary, --only globs and recent files."""

import gzip
import os
import stat
import unittest

from log_retention_support import AMPLE, DAY, Workspace, ample_free


class CompressionTests(Workspace):
    def test_old_plain_log_is_gzipped_readable_mode_and_mtime_preserved(self):
        content = os.urandom(64) * 100
        path = self.make_file("app.log", 0, 3 * DAY, content=content)
        os.chmod(path, 0o640)
        mtime = path.stat().st_mtime_ns

        report = self.lr.apply(
            self.root, self.cfg(gzip_after_seconds=DAY), free_fn=ample_free, now=self.now
        )

        gz = self.root / "app.log.gz"
        self.assertFalse(path.exists())
        with gzip.open(gz, "rb") as opened:
            self.assertEqual(opened.read(), content)
        self.assertEqual(stat.S_IMODE(gz.stat().st_mode), 0o640)
        self.assertEqual(gz.stat().st_mtime_ns, mtime)
        self.assertEqual(
            [os.path.basename(a.path) for a in report.actions if a.kind == "compressed"],
            ["app.log"],
        )
        self.assertEqual(self.names(), ["app.log.gz"])

    def test_original_is_removed_only_after_the_gzip_verifies(self):
        path = self.make_file("app.log", 500, 3 * DAY)
        seen = {}

        def verify(gz_path, source_path):
            seen["source_exists"] = os.path.exists(source_path)
            seen["gz_exists"] = os.path.exists(gz_path)
            return True

        self.lr.gzip_in_place(str(path), verify=verify)

        self.assertEqual(seen, {"source_exists": True, "gz_exists": True})
        self.assertFalse(path.exists())

    def test_failed_verification_keeps_the_original_and_leaves_no_gzip_behind(self):
        path = self.make_file("app.log", 500, 3 * DAY)
        before = path.read_bytes()

        with self.assertRaises(self.lr.CompressionError):
            self.lr.gzip_in_place(str(path), verify=lambda gz, src: False)

        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(self.names(), ["app.log"])

    def test_verify_that_raises_keeps_the_original_too(self):
        path = self.make_file("app.log", 500, 3 * DAY)

        def verify(gz, src):
            raise OSError("read back failed")

        with self.assertRaises(OSError):
            self.lr.gzip_in_place(str(path), verify=verify)

        self.assertEqual(self.names(), ["app.log"])

    def test_apply_reports_a_failed_compression_and_keeps_the_original(self):
        path = self.make_file("app.log", 500, 3 * DAY)

        def broken(_path):
            raise OSError("disk full")

        report = self.lr.apply(
            self.root,
            self.cfg(gzip_after_seconds=DAY),
            free_fn=ample_free,
            now=self.now,
            compress=broken,
        )

        self.assertTrue(path.exists())
        failed = [a for a in report.actions if a.kind == "compress-failed"]
        self.assertEqual(
            [(os.path.basename(a.path), a.detail) for a in failed], [("app.log", "OSError")]
        )
        self.assertEqual(report.exit_code, 0)

    def test_existing_gzip_target_is_never_overwritten(self):
        path = self.make_file("app.log", 500, 3 * DAY)
        (self.root / "app.log.gz").write_bytes(b"precious")

        with self.assertRaises(FileExistsError):
            self.lr.gzip_in_place(str(path))

        self.assertEqual((self.root / "app.log.gz").read_bytes(), b"precious")
        self.assertTrue(path.exists())

    def test_large_young_file_is_gzipped_by_size_but_a_file_modified_minutes_ago_is_not(self):
        self.make_file("big.log", 0, 10 * 60, content=b"x" * 5000)
        self.make_file("active.log", 5000, 60)

        self.lr.apply(self.root, self.cfg(max_file_bytes=1000), free_fn=ample_free, now=self.now)

        self.assertEqual(self.names(), ["active.log", "big.log.gz"])

    def test_plain_files_inside_evidence_dirs_are_gzipped_and_the_dir_mtime_is_kept(self):
        directory = self.make_dir("release-1", {"deploy.log": 400, "notes.txt": 400}, 3 * DAY)
        mtime = directory.stat().st_mtime_ns

        self.lr.apply(self.root, self.cfg(gzip_after_seconds=DAY), free_fn=ample_free, now=self.now)

        self.assertEqual(
            sorted(p.name for p in directory.iterdir()), ["deploy.log.gz", "notes.txt.gz"]
        )
        self.assertEqual(directory.stat().st_mtime_ns, mtime)

    def test_already_compressed_files_are_not_compressed_again(self):
        self.make_dir("release-1", {"deploy.log.gz": 400}, 3 * DAY)

        self.lr.apply(self.root, self.cfg(gzip_after_seconds=DAY), free_fn=ample_free, now=self.now)

        self.assertEqual([p.name for p in (self.root / "release-1").iterdir()], ["deploy.log.gz"])


class ManagedSetBoundaryTests(Workspace):
    def test_unmanaged_files_and_dirs_are_untouched_and_never_counted(self):
        self.make_file("chats/alice/history.json", 10**6, 90 * DAY)
        self.make_file("notes.txt", 10**6, 90 * DAY)
        self.make_file("data.db", 10**6, 90 * DAY)
        self.make_file("app.log", 100, 2 * DAY)
        before = self.snapshot()

        report = self.lr.apply(
            self.root,
            self.cfg(max_dir_bytes=1000, max_files=1, gzip_after_seconds=10**9),
            free_fn=ample_free,
            now=self.now,
        )

        self.assertEqual(report.exit_code, 0)
        self.assertEqual(report.managed_entries, 1)
        self.assertEqual(self.snapshot(), before)

    def test_unmanaged_files_survive_a_cleanup_that_deletes_managed_ones(self):
        self.make_file("chats/alice/history.json", 100, 90 * DAY)
        self.make_file("notes.txt", 100, 90 * DAY)
        for index in range(4):
            self.make_file(f"app-{index}.log", 100, (10 - index) * DAY)

        self.lr.apply(self.root, self.cfg(max_files=1), free_fn=ample_free, now=self.now)

        self.assertEqual(self.names(), ["app-3.log", "chats", "notes.txt"])
        self.assertTrue((self.root / "chats/alice/history.json").exists())

    def test_managed_name_patterns(self):
        for name in (
            "healthcheck-2026.log.1",
            "backup-db.log.gz",
            "x.log",
            "y.log.gz",
            "healthcheck.log",
        ):
            self.make_file(name, 10, 2 * DAY)
        for name in ("readme.md", "x.log.bak", "backup.sql", "healthcheck.txt"):
            self.make_file(name, 10, 2 * DAY)
        self.make_dir("release-9", {"a": 1}, 2 * DAY)
        self.make_dir("failed-9", {"a": 1}, 2 * DAY)
        self.make_dir("other-9", {"a": 1}, 2 * DAY)

        report = self.lr.plan(self.root, self.cfg(), free_fn=ample_free, now=self.now)

        self.assertEqual(report.managed_entries, 7)

    def test_symlinks_inside_root_are_skipped_and_their_targets_untouched(self):
        outside = self.base / "outside"
        outside.mkdir()
        target_file = outside / "secret.log"
        target_file.write_text("keep me")
        self.stamp(target_file, 90 * DAY)
        (outside / "inner.log").write_text("keep me too")
        os.symlink(target_file, self.root / "link.log")
        os.symlink(outside, self.root / "release-linked")
        self.make_file("real.log", 100, 5 * DAY)
        self.make_file("real2.log", 100, 4 * DAY)

        report = self.lr.apply(self.root, self.cfg(max_files=1), free_fn=ample_free, now=self.now)

        self.assertEqual(self.deleted(report), ["real.log"])
        self.assertEqual(target_file.read_text(), "keep me")
        self.assertTrue((outside / "inner.log").exists())
        self.assertTrue((self.root / "link.log").is_symlink())
        self.assertTrue((self.root / "release-linked").is_symlink())

    def test_symlink_inside_an_evidence_dir_is_skipped(self):
        outside = self.base / "outside.log"
        outside.write_text("keep me")
        directory = self.make_dir("release-old", {"a.log": 100}, 5 * DAY)
        os.symlink(outside, directory / "link.log")
        self.stamp(directory, 5 * DAY)
        self.make_dir("release-new", {"a.log": 100}, 1 * DAY)

        report = self.lr.apply(self.root, self.cfg(max_files=1), free_fn=ample_free, now=self.now)

        self.assertEqual(self.deleted(report), ["release-old"])
        self.assertEqual(outside.read_text(), "keep me")


class OnlyGlobTests(Workspace):
    """--only-glob exists for writers (pm2) that hold the CURRENT log open: only rotated files are fair game."""

    PM2_GLOBS = ("*__*.log", "*__*.log.gz")

    def pm2_cfg(self, **overrides):
        return self.cfg(only_globs=self.PM2_GLOBS, **overrides)

    def current_logs(self):
        return {
            name: self.make_file(name, 0, 30 * DAY, content=b"live" * 5000)
            for name in ("out.log", "error.log")
        }

    def test_default_config_has_no_narrowing_and_the_cli_defaults_to_it(self):
        self.assertEqual(
            (self.lr.Config().only_globs, self.lr.Config().manage_evidence_dirs), ((), False)
        )
        args = self.lr.build_parser().parse_args(["--root", "/x"])
        self.assertEqual(self.lr.config_from_args(args).only_globs, ())
        self.assertFalse(args.manage_evidence_dirs)

    def test_cli_collects_every_repeated_flag(self):
        args = self.lr.build_parser().parse_args(
            [
                "--root",
                "/x",
                "--only-glob",
                "*__*.log",
                "--only-glob",
                "*__*.log.gz",
                "--manage-evidence-dirs",
            ]
        )
        cfg = self.lr.config_from_args(args)
        self.assertEqual(cfg.only_globs, ("*__*.log", "*__*.log.gz"))
        self.assertTrue(cfg.manage_evidence_dirs)

    def test_only_rotated_pm2_names_are_managed(self):
        live = self.current_logs()
        self.make_file("out__2026-01-01_00-00-00.log", 100, 5 * DAY)
        self.make_file("error__2026-01-01_00-00-00.log.gz", 100, 5 * DAY)
        self.make_file("other.log", 100, 5 * DAY)
        self.make_file("healthcheck.log", 100, 5 * DAY)

        report = self.lr.plan(self.root, self.pm2_cfg(), free_fn=ample_free, now=self.now)

        self.assertEqual(report.managed_entries, 2)
        self.assertTrue(all(path.exists() for path in live.values()))

    def test_current_logs_are_never_compressed_or_deleted_even_when_old_and_over_every_cap(self):
        live = self.current_logs()
        before = {name: (p.read_bytes(), p.stat().st_mtime_ns) for name, p in live.items()}
        for index in range(4):
            self.make_file(
                f"out__2026-01-0{index + 1}_00-00-00.log",
                0,
                (20 - index) * DAY,
                content=b"r" * 5000,
            )

        report = self.lr.apply(
            self.root,
            self.pm2_cfg(
                max_dir_bytes=1,
                max_files=1,
                max_file_bytes=1000,
                gzip_after_seconds=DAY,
                min_free_bytes=AMPLE * 2,
            ),
            free_fn=ample_free,
            now=self.now,
        )

        self.assertEqual(report.exit_code, 2)
        for name, (content, mtime) in before.items():
            path = self.root / name
            self.assertEqual((path.read_bytes(), path.stat().st_mtime_ns), (content, mtime))
        self.assertEqual(self.names().count("out.log"), 1)
        self.assertFalse(any(name.startswith(("out.log.", "error.log.")) for name in self.names()))
        touched = {os.path.basename(a.path) for a in report.actions if a.kind != "kept"}
        self.assertFalse(touched & {"out.log", "error.log"})

    def test_rotated_files_are_still_gzipped_and_deleted_oldest_first(self):
        self.current_logs()
        for index in range(4):
            self.make_file(
                f"out__2026-01-0{index + 1}_00-00-00.log", 0, (20 - index) * DAY, content=b"r" * 500
            )

        report = self.lr.apply(
            self.root,
            self.pm2_cfg(max_files=3, gzip_after_seconds=DAY),
            free_fn=ample_free,
            now=self.now,
        )

        self.assertEqual(self.deleted(report), ["out__2026-01-01_00-00-00.log.gz"])
        self.assertEqual(
            self.names(),
            [
                "error.log",
                "out.log",
                "out__2026-01-02_00-00-00.log.gz",
                "out__2026-01-03_00-00-00.log.gz",
                "out__2026-01-04_00-00-00.log.gz",
            ],
        )

    def test_evidence_dirs_are_unmanaged_by_default_with_only_glob(self):
        self.make_dir("release-1", {"deploy.log": 1000}, 9 * DAY)
        self.make_dir("release-2", {"deploy.log": 1000}, 8 * DAY)
        self.make_dir("failed-1", {"deploy.log": 1000}, 7 * DAY)
        self.make_file("out__1.log", 100, 5 * DAY)
        self.make_file("out__2.log", 100, 4 * DAY)
        before = {k: v for k, v in self.snapshot().items() if "release-" in k or "failed-" in k}

        report = self.lr.apply(
            self.root,
            self.pm2_cfg(max_files=1, max_dir_bytes=150),
            free_fn=ample_free,
            now=self.now,
        )

        self.assertEqual(report.managed_entries, 1)
        self.assertEqual(self.deleted(report), ["out__1.log"])
        self.assertEqual(
            {k: v for k, v in self.snapshot().items() if "release-" in k or "failed-" in k}, before
        )
        self.assertEqual([a for a in report.actions if a.kind == "kept"], [])

    def test_manage_evidence_dirs_flag_brings_back_release_and_failed_dirs_with_protection(self):
        self.make_dir("release-1", {"deploy.log": 1000}, 9 * DAY)
        self.make_dir("release-2", {"deploy.log": 1000}, 8 * DAY)
        self.make_dir("failed-1", {"deploy.log": 1000}, 7 * DAY)
        self.make_dir("failed-2", {"deploy.log": 1000}, 6 * DAY)
        self.make_dir("keep-me", {"deploy.log": 1000}, 20 * DAY)
        self.current_logs()

        report = self.lr.apply(
            self.root,
            self.pm2_cfg(manage_evidence_dirs=True, max_dir_bytes=2000),
            free_fn=ample_free,
            now=self.now,
        )

        self.assertEqual(self.deleted(report), ["release-1", "failed-1"])
        self.assertEqual(self.names(), ["error.log", "failed-2", "keep-me", "out.log", "release-2"])

    def test_evidence_dir_matching_a_pattern_is_managed_without_the_flag(self):
        self.make_dir("release-1", {"deploy.log": 1000}, 9 * DAY)
        self.make_dir("release-2", {"deploy.log": 1000}, 8 * DAY)
        self.make_dir("failed-1", {"deploy.log": 1000}, 7 * DAY)

        report = self.lr.apply(
            self.root,
            self.cfg(only_globs=("release-*",), max_files=1),
            free_fn=ample_free,
            now=self.now,
        )

        self.assertEqual(self.deleted(report), ["release-1"])
        self.assertEqual(self.names(), ["failed-1", "release-2"])

    def test_a_pattern_never_manages_a_dir_that_is_not_an_evidence_dir(self):
        self.make_dir("chats", {"history.json": 1000}, 90 * DAY)

        report = self.lr.apply(
            self.root, self.cfg(only_globs=("*",), max_files=0), free_fn=ample_free, now=self.now
        )

        self.assertEqual(report.managed_entries, 0)
        self.assertEqual(self.names(), ["chats"])

    def test_cli_only_glob_leaves_the_live_logs_alone(self):
        live = self.current_logs()
        self.make_file("out__1.log", 100, 5 * DAY)
        self.make_file("out__2.log", 100, 4 * DAY)

        code, out, _ = self.run_main(
            "--only-glob", "*__*.log", "--only-glob", "*__*.log.gz", "--max-files", "1"
        )

        self.assertEqual(code, 0)
        self.assertIn("DELETED", out)
        self.assertTrue(all(path.exists() for path in live.values()))
        self.assertEqual(self.names(), ["error.log", "out.log", "out__2.log"])


class RecentFileTests(Workspace):
    def test_file_modified_within_five_minutes_is_never_deleted(self):
        self.make_file("active.log", 5000, 60)

        report = self.lr.apply(
            self.root, self.cfg(max_dir_bytes=100), free_fn=ample_free, now=self.now
        )

        self.assertTrue((self.root / "active.log").exists())
        self.assertEqual(report.exit_code, 2)
        kept = [a for a in report.actions if a.kind == "kept"]
        self.assertEqual(
            [(os.path.basename(a.path), a.protected) for a in kept], [("active.log", "recent")]
        )

    def test_evidence_dir_with_a_recent_member_is_protected_whole(self):
        self.make_dir("release-old", {"a.log": 100}, 5 * DAY)
        self.make_dir("release-new", {"a.log": 100}, 4 * DAY)
        self.make_file("failed-x/a.log", 100, 60)
        self.stamp(self.root / "failed-x", 5 * DAY)
        self.make_dir("failed-newer", {"a.log": 100}, 1 * DAY)

        self.lr.apply(self.root, self.cfg(max_files=3), free_fn=ample_free, now=self.now)

        self.assertEqual(self.names(), ["failed-newer", "failed-x", "release-new"])


if __name__ == "__main__":
    unittest.main()
