"""--merge archive loading: schema versions, legacy lineage and the bounded archive read."""

import os
import pathlib
import tempfile
import unittest

from nlu_corpus_support import MODULE


class NluCorpusTests(unittest.TestCase):
    def test_load_merge_archive_rejects_a_different_schema_version(self):
        with self.assertRaises(ValueError):
            MODULE.load_merge_archive(
                {
                    "rows": [],
                    "sources": [],
                    "lexicon": {},
                    "schema_version": MODULE.SCHEMA_VERSION - 1,
                },
                "digest",
            )

    def test_load_merge_archive_rejects_a_missing_schema_version(self):
        with self.assertRaises(ValueError):
            MODULE.load_merge_archive({"rows": [], "sources": [], "lexicon": {}}, "digest")

    def test_load_merge_archive_accepts_the_current_schema_version(self):
        rows, _sources, lexicon = MODULE.load_merge_archive(
            {
                "rows": [{"id": 1}],
                "sources": [{"kind": "sqlite", "name": "x"}],
                "lexicon": {"A": "PERSON"},
                "schema_version": MODULE.SCHEMA_VERSION,
            },
            "digest",
        )
        self.assertEqual(rows, [{"id": 1}])
        self.assertEqual(lexicon, {"A": "PERSON"})

    def test_load_merge_archive_namespaces_legacy_provenance_by_archive_and_row_position(self):
        rows, _sources, _lexicon = MODULE.load_merge_archive(
            [{"row": {"id": 2}, "sources": ["old.db"]}], "archive-digest-value"
        )
        self.assertEqual(rows[0]["id"], 2)
        self.assertNotEqual(
            rows[0]["source_refs"],
            ["old.db"],
            "a bare legacy name must never be usable for lineage matching",
        )
        self.assertIn("old.db", rows[0]["source_refs"][0])
        self.assertIn("archive-digest-value"[:12], rows[0]["source_refs"][0])

    def test_legacy_archive_rows_never_auto_attach_even_within_the_same_archive(self):
        content = [
            {
                "row": {
                    "id": 1,
                    "user_id": 1,
                    "chat_id": 1,
                    "role": "user",
                    "content": "Создай встречу завтра",
                    "created_at": "2026-01-01T00:00:00Z",
                },
                "sources": ["old.db"],
            },
            {
                "row": {
                    "id": 2,
                    "user_id": 1,
                    "chat_id": 1,
                    "role": "assistant",
                    "content": '[{"type":"function","function":{"name":"create_event","arguments":"{}"}}]',
                    "created_at": "2026-01-01T00:05:00Z",
                },
                "sources": ["old.db"],
            },
        ]
        rows, _sources, _lexicon = MODULE.load_merge_archive(content, "same-archive-digest")
        candidates, summary = MODULE.audit(rows, b"key", {})
        self.assertEqual(
            candidates[0]["observed_tools"],
            [],
            "legacy pre-versioning provenance predates lineage tracking and must stay unattached even to itself",
        )
        self.assertEqual(summary["evidence_detached_unknown_provenance_rows"], 1)

    def test_two_legacy_archives_sharing_a_bare_name_are_never_treated_as_one_lineage(self):
        rows_a, _, _ = MODULE.load_merge_archive(
            [
                {
                    "row": {
                        "id": 1,
                        "user_id": 1,
                        "chat_id": 1,
                        "role": "user",
                        "content": "Создай встречу завтра",
                        "created_at": "2026-01-01T00:00:00Z",
                    },
                    "sources": ["old.db"],
                }
            ],
            "archive-a-digest",
        )
        rows_b, _, _ = MODULE.load_merge_archive(
            [
                {
                    "row": {
                        "id": 1,
                        "user_id": 1,
                        "chat_id": 1,
                        "role": "assistant",
                        "content": '[{"type":"function","function":{"name":"create_event","arguments":"{}"}}]',
                        "created_at": "2026-01-01T00:05:00Z",
                    },
                    "sources": ["old.db"],
                }
            ],
            "archive-b-digest",
        )
        candidates, summary = MODULE.audit(rows_a + rows_b, b"key", {})
        self.assertEqual(
            candidates[0]["observed_tools"],
            [],
            "two archives sharing a bare provenance name must never look like one lineage",
        )
        self.assertEqual(summary["evidence_detached_unknown_provenance_rows"], 1)

    def test_load_merge_archive_rejects_an_unrecognized_shape(self):
        with self.assertRaises(ValueError):
            MODULE.load_merge_archive({"unexpected": True}, "digest")

    def test_read_bounded_merge_archive_rejects_a_symlinked_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            outside = pathlib.Path(tmp) / "outside.json"
            outside.write_text("{}")
            link = pathlib.Path(tmp) / "merge-link.json"
            link.symlink_to(outside)
            # O_NOFOLLOW makes the kernel itself refuse the open (ELOOP), a
            # stronger guarantee than a prior path-based check-then-open.
            with self.assertRaises(OSError):
                MODULE.read_bounded_merge_archive(link)

    def test_read_bounded_merge_archive_rejects_an_oversized_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            big = pathlib.Path(tmp) / "big.json"
            big.write_bytes(b"0")
            with self.assertRaises(ValueError):
                MODULE.read_bounded_merge_archive(big, max_bytes=0)

    def test_read_bounded_merge_archive_bounds_the_read_even_if_fstat_under_reports_size(self):
        # open_regular_bounded's fstat check only reflects the size at open
        # time; if the file grows afterward (same fd, same inode) the read
        # itself -- not just that earlier check -- must stay bounded.
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "grows.json"
            path.write_bytes(b"y" * 1000)
            original_fstat = os.fstat

            class LyingStat:
                def __init__(self, real):
                    self._real = real

                def __getattr__(self, name):
                    return getattr(self._real, name)

                @property
                def st_size(self):
                    return 10  # lies: claims the file is small

            def fake_fstat(fd):
                return LyingStat(original_fstat(fd))

            os.fstat = fake_fstat
            try:
                with self.assertRaises(ValueError):
                    MODULE.read_bounded_merge_archive(path, max_bytes=10)
            finally:
                os.fstat = original_fstat

    def test_read_bounded_merge_archive_reads_a_regular_file_within_bounds(self):
        with tempfile.TemporaryDirectory() as tmp:
            small = pathlib.Path(tmp) / "small.json"
            small.write_bytes(b'{"a":1}')
            self.assertEqual(MODULE.read_bounded_merge_archive(small), b'{"a":1}')
