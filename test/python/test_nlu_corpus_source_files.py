"""Source and output file safety: private output files, symlink/size/WAL guards of collect()."""

import os
import pathlib
import sqlite3
import stat
import tempfile
import unittest

from nlu_corpus_support import MODULE


class NluCorpusTests(unittest.TestCase):
    def test_private_json_creates_file_without_a_permissive_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "out.json"
            old_umask = os.umask(0)
            original_chmod = os.chmod
            os.chmod = lambda *a, **k: None  # sabotage any reliance on a follow-up chmod
            try:
                MODULE.private_json(path, {"a": 1})
            finally:
                os.chmod = original_chmod
                os.umask(old_umask)
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)

    def test_private_bytes_creates_file_without_a_permissive_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "key.bin"
            old_umask = os.umask(0)
            original_chmod = os.chmod
            os.chmod = lambda *a, **k: None
            try:
                MODULE.private_bytes(path, b"secret-key-bytes")
            finally:
                os.chmod = original_chmod
                os.umask(old_umask)
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
            self.assertEqual(path.read_bytes(), b"secret-key-bytes")

    def test_symlinked_source_file_outside_root_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / "root"
            (root / "data").mkdir(parents=True)
            outside = pathlib.Path(tmp) / "outside.db"
            outside.write_text("not really a database")
            link = root / "data" / "evil.db"
            link.symlink_to(outside)
            self.assertFalse(MODULE.is_safe_source_file(link, root))

    def test_regular_source_file_within_root_is_safe(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / "data").mkdir()
            real = root / "data" / "real.db"
            real.write_bytes(b"")
            self.assertTrue(MODULE.is_safe_source_file(real, root))

    def test_collect_records_a_symlinked_database_as_skipped_not_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / "root"
            (root / "data").mkdir(parents=True)
            (root / "logs").mkdir()
            outside = pathlib.Path(tmp) / "outside.db"
            outside.write_bytes(b"not a real db")
            (root / "data" / "evil.db").symlink_to(outside)
            _rows, sources, _lexicon = MODULE.collect(root)
            evil = [s for s in sources if s["name"] == "data/evil.db"]
            self.assertEqual(len(evil), 1)
            self.assertEqual(evil[0]["status"], "skipped_unsafe_path")

    def test_collect_excludes_wal_and_shm_sidecars_of_a_pre_backup_database_from_standalone_sources(
        self,
    ):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / "root"
            (root / "data").mkdir(parents=True)
            (root / "logs").mkdir()
            main = root / "data" / "calendar.db.pre-intent-seed-backup"
            conn = sqlite3.connect(str(main))
            try:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("PRAGMA wal_autocheckpoint=0")
                conn.execute(
                    "CREATE TABLE chat_history (id INTEGER PRIMARY KEY, user_id INTEGER, chat_id INTEGER, role TEXT, content TEXT, created_at TEXT)"
                )
                conn.execute(
                    "INSERT INTO chat_history (user_id, chat_id, role, content, created_at) VALUES (1, 1, 'user', 'Привет', '2026-01-01T00:00:00Z')"
                )
                conn.commit()
                shm = root / "data" / "calendar.db.pre-intent-seed-backup-shm"
                wal = root / "data" / "calendar.db.pre-intent-seed-backup-wal"
                self.assertTrue(
                    shm.exists() and wal.exists(),
                    "WAL mode must actually create the real sidecars this test exercises",
                )
                _rows, sources, _lexicon = MODULE.collect(root)
                # Checked with the writer connection still open: collect() itself must
                # never delete or move these -- unlike closing the last writer
                # connection (below), which triggers SQLite's own unrelated
                # auto-checkpoint cleanup and is not something this tool controls.
                self.assertTrue(shm.exists(), "collect() must never delete or move a WAL sidecar")
                self.assertTrue(wal.exists(), "collect() must never delete or move a WAL sidecar")
            finally:
                conn.close()
            names = {s["name"] for s in sources}
            self.assertNotIn(
                "data/calendar.db.pre-intent-seed-backup-shm",
                names,
                "a WAL shared-memory sidecar must never be classified as its own standalone database source",
            )
            self.assertNotIn(
                "data/calendar.db.pre-intent-seed-backup-wal",
                names,
                "a WAL sidecar must never be classified as its own standalone database source",
            )
            main_source = next(
                s for s in sources if s["name"] == "data/calendar.db.pre-intent-seed-backup"
            )
            self.assertEqual(main_source["status"], "read")
            self.assertEqual(
                main_source["rows"],
                1,
                "the parent db's own committed row must still be read correctly, including via its real WAL sidecar",
            )

    def test_collect_rejects_an_oversized_wal_sidecar_instead_of_reading_it_unbounded(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / "root"
            (root / "data").mkdir(parents=True)
            (root / "logs").mkdir()
            main = root / "data" / "calendar.db"
            main.write_bytes(b"")  # zero bytes: well under any bound on its own
            wal = root / "data" / "calendar.db-wal"
            wal.write_bytes(b"0" * 2000)  # larger than the bound this test sets below
            original_bound = MODULE.MAX_DATABASE_BYTES
            MODULE.MAX_DATABASE_BYTES = 1000
            try:
                _rows, sources, _lexicon = MODULE.collect(root)
            finally:
                MODULE.MAX_DATABASE_BYTES = original_bound
            main_source = next(s for s in sources if s["name"] == "data/calendar.db")
            self.assertEqual(
                main_source["status"],
                "unreadable",
                "an oversized -wal sidecar must be rejected by the same byte-ceiling invariant as the main db file, not read without any bound",
            )

    def test_collect_includes_committed_wal_only_rows_from_a_live_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / "root"
            (root / "data").mkdir(parents=True)
            (root / "logs").mkdir()
            db_path = root / "data" / "calendar.db"
            conn = sqlite3.connect(str(db_path))
            try:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("PRAGMA wal_autocheckpoint=0")
                conn.execute(
                    "CREATE TABLE chat_history (id INTEGER PRIMARY KEY, user_id INTEGER, chat_id INTEGER, role TEXT, content TEXT, created_at TEXT)"
                )
                conn.execute(
                    "INSERT INTO chat_history (user_id, chat_id, role, content, created_at) VALUES (1, 1, 'user', 'Привет', '2026-01-01T00:00:00Z')"
                )
                conn.commit()
                # Connection stays open (WAL row not checkpointed into the main .db file) while collect() runs.
                rows, sources, _lexicon = MODULE.collect(root)
            finally:
                conn.close()
            db_source = next(s for s in sources if s["name"] == "data/calendar.db")
            self.assertEqual(db_source["status"], "read")
            self.assertEqual(
                db_source["rows"],
                1,
                "collect() must see the committed WAL-only row via a real read-only SQLite transaction, not silently drop it by byte-copying only the main .db file",
            )
            self.assertEqual(len(rows), 1)

    def test_open_regular_bounded_rejects_a_symlink_via_no_follow(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "target.db"
            target.write_bytes(b"data")
            link = pathlib.Path(tmp) / "link.db"
            link.symlink_to(target)
            with self.assertRaises(OSError):
                MODULE.open_regular_bounded(link, 1024)

    def test_open_regular_bounded_rejects_an_oversized_regular_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            big = pathlib.Path(tmp) / "big.db"
            big.write_bytes(b"0123456789")
            with self.assertRaises(ValueError):
                MODULE.open_regular_bounded(big, 5)

    def test_open_regular_bounded_returns_a_readable_fd_for_a_safe_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            small = pathlib.Path(tmp) / "small.db"
            small.write_bytes(b"hello")
            fd = MODULE.open_regular_bounded(small, 1024)
            try:
                self.assertEqual(os.read(fd, 1024), b"hello")
            finally:
                os.close(fd)

    def test_collect_still_rejects_a_symlinked_database_end_to_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / "root"
            (root / "data").mkdir(parents=True)
            (root / "logs").mkdir()
            outside = pathlib.Path(tmp) / "outside.db"
            outside.write_bytes(b"not a real db")
            (root / "data" / "evil.db").symlink_to(outside)
            _rows, sources, _lexicon = MODULE.collect(root)
            evil = [s for s in sources if s["name"] == "data/evil.db"]
            self.assertEqual(len(evil), 1)
            self.assertIn(evil[0]["status"], {"skipped_unsafe_path", "unreadable"})
