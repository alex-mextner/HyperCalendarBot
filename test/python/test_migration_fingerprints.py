"""The migration fingerprint parser must actually recognize the real migrations.ts shape."""

import importlib.util
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class MigrationFingerprintsTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location(
            "migration_fingerprints", ROOT / "scripts/migration-fingerprints.py"
        )
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.real_text = (ROOT / "src/database/migrations.ts").read_text()

    def test_parser_finds_every_migration_in_the_real_file(self):
        # Independent ground truth: a plain count of "name: '...'" occurrences, not the
        # parser's own regex, so a real-world format drift can't fool both at once.
        expected_count = len(re.findall(r"name: '[^']+'", self.real_text))
        fingerprints = self.module.fingerprint_migrations(self.real_text)
        self.assertGreater(expected_count, 50, "sanity check: the real file should have many migrations")
        self.assertEqual(len(fingerprints), expected_count)

    def test_parser_recognizes_the_first_and_a_recent_real_migration_by_name(self):
        names = [name for name, _ in self.module.fingerprint_migrations(self.real_text)]
        self.assertIn("001_create_users", names)
        self.assertIn("063_unconfirm_legacy_verified_locations", names)

    def test_every_fingerprint_has_a_nonempty_name_and_a_64_char_hex_digest(self):
        for name, digest in self.module.fingerprint_migrations(self.real_text):
            self.assertTrue(name)
            self.assertRegex(digest, r"^[0-9a-f]{64}$")

    def test_appending_a_migration_does_not_change_the_previous_last_ones_fingerprint(self):
        appended = self.real_text.replace(
            "\n];\n",
            "\n  {\n    name: '999_test_only',\n    up(db){},\n  },\n];\n",
        )
        before = dict(self.module.fingerprint_migrations(self.real_text))
        after = dict(self.module.fingerprint_migrations(appended))
        last_real_name = re.findall(r"name: '([^']+)'", self.real_text)[-1]
        self.assertEqual(before[last_real_name], after[last_real_name])
        self.assertIn("999_test_only", after)
        self.assertNotIn("999_test_only", before)

    def test_a_reindent_that_breaks_every_split_boundary_raises_instead_of_one_giant_entry(self):
        # If the file were ever reformatted to 4-space indentation, the split boundary
        # ("\n  {\n    name: '") never matches anywhere, so re.split returns the whole file as
        # one chunk. A naive parser would still find the *first* "name: '...'" via a plain
        # search over that one leftover chunk and silently report a single-migration
        # fingerprint table for the entire file, with every other migration invisible.
        drifted = self.real_text.replace("\n  {\n    name: '", "\n    {\n        name: '")
        with self.assertRaises(ValueError):
            self.module.fingerprint_migrations(drifted)

    def test_one_entry_reformatted_to_double_quotes_among_many_good_ones_raises(self):
        # A single migration's name field switched to double quotes: the split boundary for
        # that one entry no longer matches (single quotes are required), merging it into the
        # preceding chunk, so it silently disappears from the table while every other entry
        # still parses normally. The independent ground truth accepts either quote character,
        # so it still counts this one and catches the mismatch.
        drifted = self.real_text.replace("name: '001_create_users'", 'name: "001_create_users"', 1)
        with self.assertRaises(ValueError):
            self.module.fingerprint_migrations(drifted)

    def test_migration_shaped_text_inside_a_body_is_not_cut_out_as_a_phantom_entry(self):
        # Text shaped exactly like a top-level migration boundary can appear inside a real
        # migration's own body (a comment, a seed-data literal). It is only treated as a real
        # boundary when the array opener or a previous element's comma sits directly in front
        # of it -- a body-internal occurrence normally doesn't, so it must not fragment the
        # migration it lives inside into extra phantom entries.
        injected = self.real_text.replace(
            "CREATE TABLE users",
            "CREATE TABLE users\n  {\n    name: 'fake_migration',\n    up(db){},\n  },",
            1,
        )
        expected_count = len(re.findall(r"name: '[^']+'", self.real_text))
        fingerprints = self.module.fingerprint_migrations(injected)
        names = [name for name, _ in fingerprints]
        self.assertEqual(len(fingerprints), expected_count)
        self.assertNotIn("fake_migration", names)

    def test_a_duplicate_migration_name_raises_instead_of_silently_comparing_wrong(self):
        duplicated = self.real_text.replace(
            "name: '001_create_users'", "name: '063_unconfirm_legacy_verified_locations'"
        )
        with self.assertRaises(ValueError):
            self.module.fingerprint_migrations(duplicated)

    def test_a_name_containing_a_tab_raises_instead_of_misaligning_the_tsv_output(self):
        # The name becomes a field in a hand-rolled tab-separated line consumed by awk on the
        # bash side; a literal tab in the name would silently shift that split.
        with_tab = self.real_text.replace("name: '001_create_users'", "name: '001_create\tusers'")
        with self.assertRaises(ValueError):
            self.module.fingerprint_migrations(with_tab)


if __name__ == "__main__":
    unittest.main()
