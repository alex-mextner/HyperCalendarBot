"""Log retention: size/free-space rotation that never touches the last deploy/failure evidence."""

import gzip
import hashlib
import importlib.util
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/log-retention.py"

HOUR = 3600
DAY = 86400
AMPLE = 10**12


def load_module():
    spec = importlib.util.spec_from_file_location("log_retention", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ample_free(_root):
    return AMPLE, AMPLE


class Workspace(unittest.TestCase):
    """A real temp --root plus helpers that stamp mtimes relative to a fixed NOW."""

    def setUp(self):
        self.lr = load_module()
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name).resolve()
        self.root = self.base / "logs"
        self.root.mkdir()
        self.now = time.time()

    def cfg(self, **overrides):
        # Every limit is off unless a test turns one on, so each test exercises one criterion.
        values = {
            "max_dir_bytes": AMPLE,
            "max_file_bytes": AMPLE,
            "max_files": 10**6,
            "min_free_bytes": 0,
            "min_free_percent": 0.0,
            "gzip_after_seconds": 10**9,
        }
        values.update(overrides)
        return self.lr.Config(**values)

    def stamp(self, path, age):
        moment = self.now - age
        os.utime(path, (moment, moment))

    def make_file(self, relative, size, age, content=None):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content if content is not None else os.urandom(size))
        self.stamp(path, age)
        return path

    def make_dir(self, name, files, age):
        directory = self.root / name
        directory.mkdir()
        for file_name, size in files.items():
            self.make_file(f"{name}/{file_name}", size, age)
        self.stamp(directory, age)
        return directory

    def names(self):
        return sorted(p.name for p in self.root.iterdir())

    def snapshot(self):
        state = {}
        for path in sorted(self.root.rglob("*")):
            st = path.lstat()
            digest = (
                hashlib.sha256(path.read_bytes()).hexdigest()
                if path.is_file() and not path.is_symlink()
                else ""
            )
            state[str(path)] = (st.st_size, st.st_mtime_ns, stat.S_IMODE(st.st_mode), digest)
        return state

    def deleted(self, report):
        return [os.path.basename(a.path) for a in report.actions if a.kind == "deleted"]

    def run_main(self, *args, sender=None, free_fn=ample_free, now=None):
        out, err = io.StringIO(), io.StringIO()
        code = self.lr.main(
            # Compression is pushed out of the way unless a test passes its own --gzip-after-days (last one wins).
            ["--root", str(self.root), "--gzip-after-days", "100000", *args],
            free_fn=free_fn,
            sender=sender,
            now=self.now if now is None else now,
            out=out,
            err=err,
        )
        return code, out.getvalue(), err.getvalue()


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
