"""The deploy schema gate: migrations.ts parsing, the migration doc contract and the decision."""

import hashlib
import importlib.util
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

HEAD = "// src/database/migrations.ts\nimport type { Migration } from './schema.ts';\n\nexport const migrations: Migration[] = [\n"
SHIPPED = "  {\n    name: '001_x',\n    up(db) {\n      db.exec('CREATE TABLE x (id INTEGER)');\n    },\n  },\n"
ADDED = "  {\n    name: '002_y',\n    up(db) {\n      db.exec('CREATE TABLE y (id INTEGER)');\n    },\n  },\n"
TAIL = "];\n"
RUNNING = (HEAD + SHIPPED + TAIL).encode()
RELEASE = (HEAD + SHIPPED + ADDED + TAIL).encode()
# A line starting with "];" inside a migration (a multi-line template literal), not the array close.
SHIPPED_WITH_CLOSE_SHAPED_LINE = SHIPPED.replace(
    "    up(db) {\n", "    up(db) {\n      db.exec(`INSERT INTO seeds(json) VALUES ('[\n];')`);\n"
)


def doc(name="002_y", rollback="yes", deletion="no", body="Creates table y.\n"):
    front = f"---\nmigration: {name}\nrollback-compatible: {rollback}\ndata-deletion: {deletion}\n---\n"
    return (front + "\n# Migration\n\n" + body).encode()


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_gate():
    spec = importlib.util.spec_from_file_location("migration_gate", ROOT / "scripts/migration-gate.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class MigrationParserTests(unittest.TestCase):
    def setUp(self):
        self.gate = load_gate()
        self.real_text = (ROOT / "src/database/migrations.ts").read_text()

    def parse(self, text):
        return self.gate.parse_migrations(text)

    def test_parser_finds_every_migration_in_the_real_file(self):
        # Independent ground truth: a plain count of "name: '...'" occurrences, not the
        # parser's own regex, so a real-world format drift can't fool both at once.
        expected = re.findall(r"name: '([^']+)'", self.real_text)
        self.assertGreater(len(expected), 50, "sanity check: the real file should have many migrations")
        self.assertEqual(list(self.parse(self.real_text).names), expected)

    def test_every_fingerprint_is_a_64_char_hex_digest(self):
        parsed = self.parse(self.real_text)
        for name in parsed.names:
            self.assertRegex(parsed.digests[name], r"^[0-9a-f]{64}$")
        self.assertRegex(parsed.outside, r"^[0-9a-f]{64}$")

    def test_appending_a_migration_changes_neither_the_previous_last_entry_nor_the_outside_code(self):
        appended = self.real_text.replace("\n];\n", "\n  {\n    name: '999_test_only',\n    up(db){},\n  },\n];\n")
        before, after = self.parse(self.real_text), self.parse(appended)
        last = before.names[-1]
        self.assertEqual(before.digests[last], after.digests[last])
        self.assertEqual(before.outside, after.outside)
        self.assertEqual(after.names[-1], "999_test_only")

    def test_code_before_the_array_changes_only_the_outside_fingerprint(self):
        edited = self.real_text.replace(
            "export const migrations", "globalThis.probe = 1;\nexport const migrations", 1
        )
        before, after = self.parse(self.real_text), self.parse(edited)
        self.assertNotEqual(before.outside, after.outside)
        self.assertEqual(before.digests, after.digests)

    def test_code_after_the_array_changes_the_outside_fingerprint_not_the_last_migration(self):
        edited = self.real_text + "migrations.push({ name: '999_hidden', up(db) {} });\n"
        before, after = self.parse(self.real_text), self.parse(edited)
        self.assertNotEqual(before.outside, after.outside)
        self.assertEqual(before.digests, after.digests)

    def test_a_close_shaped_line_inside_the_last_migration_does_not_end_the_array(self):
        # Appending after such an entry leaves its digest and the outside fingerprint alone;
        # otherwise every later release reads as an edit of that shipped migration.
        shipped = self.parse(HEAD + SHIPPED_WITH_CLOSE_SHAPED_LINE + TAIL)
        appended = self.parse(HEAD + SHIPPED_WITH_CLOSE_SHAPED_LINE + ADDED + TAIL)
        self.assertEqual(appended.digests["001_x"], shipped.digests["001_x"])
        self.assertEqual(appended.outside, shipped.outside)

    def test_a_concatenated_name_raises_instead_of_parsing_its_first_literal(self):
        concatenated = self.real_text.replace(
            "\n];\n", "\n  {\n    name: '064' + '_drop_data',\n    up(db){},\n  },\n];\n"
        )
        with self.assertRaisesRegex(ValueError, "064"):
            self.parse(concatenated)

    def test_an_entry_named_by_a_constant_raises_instead_of_hiding_in_the_previous_entry(self):
        hidden = self.real_text.replace("\n];\n", "\n  {\n    name: HIDDEN_NAME,\n    up(db){},\n  },\n];\n")
        with self.assertRaises(ValueError):
            self.parse(hidden)

    def test_a_reindent_that_breaks_every_split_boundary_raises(self):
        drifted = self.real_text.replace("\n  {\n    name: '", "\n    {\n        name: '")
        with self.assertRaises(ValueError):
            self.parse(drifted)

    def test_one_entry_reformatted_to_double_quotes_among_many_good_ones_raises(self):
        drifted = self.real_text.replace("name: '001_create_users'", 'name: "001_create_users"', 1)
        with self.assertRaises(ValueError):
            self.parse(drifted)

    def test_migration_shaped_text_inside_a_body_is_not_cut_out_as_a_phantom_entry(self):
        injected = self.real_text.replace(
            "CREATE TABLE users",
            "CREATE TABLE users\n  {\n    name: 'fake_migration',\n    up(db){},\n  },",
            1,
        )
        names = self.parse(injected).names
        self.assertEqual(len(names), len(re.findall(r"name: '[^']+'", self.real_text)))
        self.assertNotIn("fake_migration", names)

    def test_a_duplicate_migration_name_raises(self):
        duplicated = self.real_text.replace(
            "name: '001_create_users'", "name: '063_unconfirm_legacy_verified_locations'"
        )
        with self.assertRaises(ValueError):
            self.parse(duplicated)

    def test_names_outside_ascii_letters_digits_and_underscore_raise(self):
        for name in ["001_create\tusers", "001_создать", "001-x"]:
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    self.parse(self.real_text.replace("name: '001_create_users'", f"name: '{name}'"))


class MigrationDocContractTests(unittest.TestCase):
    def setUp(self):
        self.gate = load_gate()

    def test_front_matter_declarations_are_read_with_the_doc_digest(self):
        raw = doc(rollback="no", deletion="yes", body="Drops y.\n\n## Rollback\n\nRestore the backup.\n")
        contract = self.gate.parse_doc(raw, "002_y")
        self.assertFalse(contract.rollback_compatible)
        self.assertTrue(contract.data_deletion)
        self.assertEqual(contract.sha256, sha(raw))

    def test_an_empty_or_blank_doc_is_rejected(self):
        for raw in [b"", b"  \n\t\n"]:
            with self.subTest(raw=raw):
                with self.assertRaisesRegex(ValueError, "empty"):
                    self.gate.parse_doc(raw, "002_y")

    def test_a_doc_whose_front_matter_is_not_exactly_the_contract_is_rejected(self):
        cases = {
            "declarations in the body": b"# 002\n\nmigration: 002_y\nrollback-compatible: yes\ndata-deletion: no\n",
            "another migration's doc": doc(name="062_retire_desktop_agent"),
            "keys out of order": b"---\nmigration: 002_y\ndata-deletion: no\nrollback-compatible: yes\n---\n\nBody.\n",
            "a key missing": b"---\nmigration: 002_y\nrollback-compatible: yes\n---\n\nBody.\n",
            "no closing line": b"---\nmigration: 002_y\nrollback-compatible: yes\ndata-deletion: no\n\nBody.\n",
            "not yes or no": doc(rollback="mostly"),
            "capitalised": doc().replace(b"rollback-compatible", b"Rollback-compatible"),
            "CRLF": doc().replace(b"\n", b"\r\n"),
            "nothing after the front matter": b"---\nmigration: 002_y\nrollback-compatible: yes\ndata-deletion: no\n---\n \n",
            "incompatible without a Rollback section": doc(rollback="no", body="Drops y.\n"),
        }
        for label, raw in cases.items():
            with self.subTest(label):
                with self.assertRaises(ValueError):
                    self.gate.parse_doc(raw, "002_y")

    def test_a_doc_that_is_not_utf8_is_rejected(self):
        with self.assertRaises(ValueError):
            self.gate.parse_doc(doc() + b"\xff\xfe", "002_y")

    def test_every_checked_in_migration_doc_passes_the_contract(self):
        # A doc the gate would refuse fails here, before its migration reaches a deploy.
        names = self.gate.parse_migrations((ROOT / "src/database/migrations.ts").read_text()).names
        paths = sorted((ROOT / "docs/reference/migrations").glob("*.md"))
        self.assertTrue(paths)
        for path in paths:
            with self.subTest(path.name):
                self.assertIn(path.stem, names)
                self.gate.parse_doc(path.read_bytes(), path.stem)


class GateDecisionTests(unittest.TestCase):
    PARSED = object()

    def setUp(self):
        self.gate = load_gate()

    def decide(self, running=RUNNING, release=RELEASE, applied=("001_x",), exported=PARSED, docs=None, reviewed=""):
        if exported is self.PARSED:
            exported = self.gate.parse_migrations(release.decode()).names
        return self.gate.decide(
            running,
            release,
            None if applied is None else list(applied),
            None if exported is None else list(exported),
            {"002_y.md": doc()} if docs is None else docs,
            reviewed,
        )

    def pair(self, release=RELEASE, running=RUNNING):
        return sha(running) + ":" + sha(release)

    def test_unchanged_migrations_are_accepted_without_any_other_input(self):
        decision = self.gate.decide(RUNNING, RUNNING, None, None, None, "")
        self.assertEqual(decision.mode, "unchanged")
        self.assertTrue(decision.accepted)

    def test_a_documented_safe_new_migration_is_accepted_automatically(self):
        decision = self.decide()
        self.assertEqual((decision.mode, decision.refusals), ("automatic", []))
        self.assertEqual([m.name for m in decision.migrations], ["002_y"])
        self.assertEqual(decision.rollback_guard, [])

    def test_a_risky_declaration_needs_the_reviewed_override(self):
        for raw in [doc(rollback="no", body="## Rollback\n\nSteps.\n"), doc(deletion="yes")]:
            with self.subTest(raw=raw):
                decision = self.decide(docs={"002_y.md": raw})
                self.assertFalse(decision.accepted)
                self.assertIn("002_y", "\n".join(decision.refusals))

    def test_only_the_exact_transition_pair_overrides_a_risky_declaration(self):
        risky = {"002_y.md": doc(rollback="no", deletion="yes", body="## Rollback\n\nSteps.\n")}
        pair = self.pair()
        for reviewed in [pair[::-1], sha(RELEASE) + ":" + sha(RUNNING), sha(RUNNING), ":" + sha(RELEASE), pair + " ", ""]:
            with self.subTest(reviewed=reviewed):
                self.assertFalse(self.decide(docs=risky, reviewed=reviewed).accepted)
        decision = self.decide(docs=risky, reviewed=pair)
        self.assertEqual(decision.mode, "reviewed-override")
        self.assertEqual(decision.rollback_guard, ["002_y"])
        self.assertTrue(decision.refusals, "the override still reports why automatic activation was refused")

    def test_a_rollback_compatible_deletion_needs_no_rollback_guard(self):
        decision = self.decide(docs={"002_y.md": doc(deletion="yes")}, reviewed=self.pair())
        self.assertEqual((decision.mode, decision.rollback_guard), ("reviewed-override", []))

    def test_a_migration_the_database_is_ahead_on_still_needs_its_doc(self):
        # The override accepts a database that already records 002_y while the running image lacks
        # it, but only with 002_y's reviewed doc, which the audit line names. The old image already
        # runs on that database, so the migration does not join the rollback guard.
        applied = ("001_x", "002_y")
        missing = self.decide(applied=applied, docs={}, reviewed=self.pair())
        self.assertEqual(missing.mode, "refused", missing.refusals)
        risky = {"002_y.md": doc(rollback="no", body="## Rollback\n\nSteps.\n")}
        decision = self.decide(applied=applied, docs=risky, reviewed=self.pair())
        self.assertEqual(decision.mode, "reviewed-override")
        self.assertEqual([m.name for m in decision.migrations], ["002_y"])
        self.assertEqual(decision.rollback_guard, [])

    def test_new_is_judged_by_the_database_not_the_running_image(self):
        # After an image-only rollback the database records 002_y but the running image lacks
        # it: the release's 002_y never runs, so neither its doc nor its body can vouch for it.
        decision = self.decide(applied=("001_x", "002_y"))
        self.assertFalse(decision.accepted)
        self.assertRegex("\n".join(decision.refusals), "002_y.*applied")
        self.assertEqual(self.decide(applied=("001_x", "002_y"), reviewed=self.pair()).mode, "reviewed-override")

    def test_database_records_unknown_to_both_images_are_ignored(self):
        decision = self.decide(applied=("001_x", "000_renumbered_long_ago"))
        self.assertEqual(decision.mode, "automatic")

    def test_code_outside_the_entries_needs_the_reviewed_override(self):
        release = RELEASE.replace(b"export const", b"globalThis.probe = 1;\nexport const")
        decision = self.decide(release=release)
        self.assertFalse(decision.accepted)
        self.assertIn("outside", "\n".join(decision.refusals))
        self.assertEqual(self.decide(release=release, reviewed=self.pair(release)).mode, "reviewed-override")

    def test_refusals_the_override_cannot_attest_to(self):
        # The override vouches for a reviewed decision. It cannot make a migration run that never
        # will (edited, renamed or reordered shipped entries), supply a missing doc, or stand in
        # for input the gate could not read or parse.
        edited = (HEAD + SHIPPED.replace("id INTEGER", "id TEXT") + ADDED + TAIL).encode()
        removed = (HEAD + ADDED + TAIL).encode()
        reordered = (HEAD + ADDED + SHIPPED + TAIL).encode()
        concatenated = (HEAD + SHIPPED + ADDED.replace("'002_y'", "'002' + '_y'") + TAIL).encode()
        cases = {
            "missing doc": dict(docs={}),
            "invalid doc": dict(docs={"002_y.md": doc(name="001_x")}),
            "edited shipped entry": dict(release=edited),
            "removed shipped entry": dict(release=removed),
            "reordered entries": dict(release=reordered),
            "unparseable name": dict(release=concatenated, exported=["001_x", "002_y"]),
            "exports differ from the source": dict(exported=["001_x", "002_y", "003_hidden"]),
            "applied migrations unreadable": dict(applied=None),
            "exports unreadable": dict(exported=None),
            "docs unreadable": dict(docs=None),
        }
        for label, case in cases.items():
            with self.subTest(label):
                release = case.pop("release", RELEASE)
                if "docs" in case and case["docs"] is None:
                    decision = self.gate.decide(RUNNING, release, ["001_x"], ["001_x", "002_y"], None, self.pair(release))
                else:
                    decision = self.decide(release=release, reviewed=self.pair(release), **case)
                self.assertEqual(decision.mode, "refused", decision.refusals)

    def test_an_edit_below_a_close_shaped_line_in_the_last_shipped_migration_is_never_overridable(self):
        # That "];" line is not the array close, so the edit is one of the shipped entry, which the
        # runner never re-runs, not a change to the code outside the entries.
        running = (HEAD + SHIPPED_WITH_CLOSE_SHAPED_LINE + TAIL).encode()
        release = (HEAD + SHIPPED_WITH_CLOSE_SHAPED_LINE.replace("id INTEGER", "id TEXT") + TAIL).encode()
        decision = self.decide(running=running, release=release, reviewed=self.pair(release, running))
        self.assertEqual(decision.mode, "refused", decision.refusals)
        self.assertIn("001_x", "\n".join(decision.refusals))

    def test_unreadable_docs_are_not_reported_as_a_missing_doc(self):
        # 002_y's doc may well ship; the gate could not read the directory and says only that.
        decision = self.gate.decide(RUNNING, RELEASE, ["001_x"], ["001_x", "002_y"], None, self.pair())
        self.assertEqual(decision.mode, "refused")
        self.assertEqual(len(decision.refusals), 1, decision.refusals)
        self.assertNotIn("002_y", decision.refusals[0])

    def test_an_unreadable_or_empty_migrations_file_is_never_overridable(self):
        for running, release in [(None, RELEASE), (RUNNING, None), (b"", RELEASE)]:
            with self.subTest(running=running, release=release):
                reviewed = sha(running or b"") + ":" + sha(release or b"")
                decision = self.gate.decide(running, release, ["001_x"], ["001_x", "002_y"], {}, reviewed)
                self.assertFalse(decision.accepted)


if __name__ == "__main__":
    unittest.main()
