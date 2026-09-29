import gzip
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('nlu_corpus', ROOT / 'scripts' / 'nlu_corpus.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

class NluCorpusTests(unittest.TestCase):
    def test_known_person_contact_and_coordinates_are_not_published(self):
        text = 'Пригласи Ивана @synthetic_user test@example.invalid в 14:00 на 44.8125, 20.4612'
        safe = MODULE.redact_candidate(text, b'synthetic-key', {'Ивана': 'PERSON'})
        for private in ['Ивана', '@synthetic_user', 'test@example.invalid', '44.8125', '20.4612']:
            self.assertNotIn(private, safe)
        self.assertIn('14:00', safe)
    def test_one_secret_marker_quarantines_neighbouring_auth_replies(self):
        rows = [{'scope':'a','at':0,'text':'/connect_telegram'}, {'scope':'a','at':10,'text':'12345'}, {'scope':'b','at':10,'text':'14:00'}]
        self.assertEqual(MODULE.quarantined_indices(rows), {0, 1})
    def test_negative_command_is_not_a_creation_request(self):
        self.assertNotIn('event.create', MODULE.suggest_labels('Не создавай встречу завтра'))
    def test_compound_operation_retains_both_classes(self):
        labels = MODULE.suggest_labels('Создай встречу завтра и пригласи @synthetic_user')
        self.assertIn('event.create', labels)
        self.assertIn('invitation.send', labels)
    def test_bot_action_is_not_user_intent_gold(self):
        result = MODULE.candidate_record('Покажи расписание', ['delete_event'], b'synthetic-key')
        self.assertEqual(result['gold'], None)
        self.assertFalse(result['train_eligible'])
        self.assertEqual(result['observed_tools'], ['delete_event'])
        self.assertNotIn('event.delete', result['intent_candidates'])

    def test_calendar_literals_survive_redaction(self):
        text = 'Встреча 2026-09-29 в 14:00'
        safe = MODULE.redact_candidate(text, b'key', {})
        self.assertIn('2026-09-29', safe)
        self.assertIn('14:00', safe)

    def test_hyphenated_day_month_year_dates_survive_redaction(self):
        # The production bot itself parses DD-MM(-YYYY) as a calendar date
        # (src/bot/handlers/group-message-filter.ts NUMERIC_DATE_CANDIDATE_RE);
        # the NUMBER-redaction rule must not destroy it as a fake phone number.
        safe = MODULE.redact_candidate('Встреча 29-09-2026 в 14:00', b'key', {})
        self.assertIn('29-09-2026', safe)
        safe_short = MODULE.redact_candidate('Событие 5-3-2026 утром', b'key', {})
        self.assertIn('5-3-2026', safe_short)

    def test_invalid_month_hyphenated_digit_run_is_still_redacted(self):
        safe = MODULE.redact_candidate('код 12-34-56-78', b'key', {})
        self.assertNotIn('12-34-56-78', safe)

    def test_debug_history_is_not_mistaken_for_new_messages(self):
        text = ('[2026-09-28T10:00:00Z]\nCHAT: 12 | USER: uid:34\nSUPPLEMENT: false\nMESSAGE: создай встречу\n' + '='*50 + '\nHISTORY: old message\nTOOL CALL: create_event\nTOOL RESULT: create_event → OK\nResponse (6 chars):\nГотово\n' + '='*50 + '\n')
        rows = MODULE.parse_debug_runs(text)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['content'], 'создай встречу')
        self.assertEqual(rows[0]['tools'], ['create_event'])
        self.assertEqual(MODULE.parse_debug_runs(text.replace('SUPPLEMENT: false','SUPPLEMENT: true')), [])

    def test_pseudonyms_are_stable_only_with_the_same_key(self):
        one = MODULE.pseudonym('Person', b'key', 'PERSON')
        self.assertEqual(one, MODULE.pseudonym('person', b'key', 'PERSON'))
        self.assertNotEqual(one, MODULE.pseudonym('Person', b'other', 'PERSON'))

    def test_tool_names_are_separate_from_validated_outcomes(self):
        text = '[{"type":"function","function":{"name":"send_invitation","arguments":"{}"}}]'
        self.assertEqual(MODULE.observed_tools(text), ['send_invitation'])
        record = MODULE.candidate_record('Кто приглашён?', MODULE.observed_tools(text), b'key')
        self.assertEqual(record['outcome_status'], 'not_inferred_from_prose')
        self.assertFalse(record['train_eligible'])

    def test_private_json_creates_file_without_a_permissive_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / 'out.json'
            old_umask = os.umask(0)
            original_chmod = os.chmod
            os.chmod = lambda *a, **k: None  # sabotage any reliance on a follow-up chmod
            try:
                MODULE.private_json(path, {'a': 1})
            finally:
                os.chmod = original_chmod
                os.umask(old_umask)
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)

    def test_private_bytes_creates_file_without_a_permissive_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / 'key.bin'
            old_umask = os.umask(0)
            original_chmod = os.chmod
            os.chmod = lambda *a, **k: None
            try:
                MODULE.private_bytes(path, b'secret-key-bytes')
            finally:
                os.chmod = original_chmod
                os.umask(old_umask)
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
            self.assertEqual(path.read_bytes(), b'secret-key-bytes')

    def test_tool_row_within_the_same_session_and_lineage_is_attached(self):
        rows = [
            {'id': 1, 'user_id': 1, 'chat_id': 1, 'role': 'user', 'content': 'Создай встречу завтра', 'created_at': '2026-01-01T00:00:00Z', 'source_refs': ['data/calendar.db#aaa111']},
            {'id': 2, 'user_id': 1, 'chat_id': 1, 'role': 'assistant', 'content': '[{"type":"function","function":{"name":"create_event","arguments":"{}"}}]', 'created_at': '2026-01-01T00:05:00Z', 'source_refs': ['data/calendar.db#aaa111']},
        ]
        candidates, summary = MODULE.audit(rows, b'key', {})
        self.assertEqual(candidates[0]['observed_tools'], ['create_event'])
        self.assertEqual(summary['evidence_detached_unknown_provenance_rows'], 0)

    def test_far_future_tool_row_is_not_attached_to_a_stale_earlier_request(self):
        rows = [
            {'id': 1, 'user_id': 1, 'chat_id': 1, 'role': 'user', 'content': 'Создай встречу завтра', 'created_at': '2026-01-01T00:00:00Z', 'source_refs': ['data/calendar.db#aaa111']},
            {'id': 2, 'user_id': 1, 'chat_id': 1, 'role': 'assistant', 'content': '[{"type":"function","function":{"name":"create_event","arguments":"{}"}}]', 'created_at': '2026-01-05T00:00:00Z', 'source_refs': ['data/calendar.db#aaa111']},
        ]
        candidates, summary = MODULE.audit(rows, b'key', {})
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]['observed_tools'], [])
        self.assertEqual(candidates[0]['observed_responses'], [])

    def test_cross_snapshot_tool_row_is_not_attached_even_within_the_same_time_window(self):
        rows = [
            {'id': 1, 'user_id': 1, 'chat_id': 1, 'role': 'user', 'content': 'Создай встречу завтра', 'created_at': '2026-01-01T00:00:00Z', 'source_refs': ['data/backups/calendar-2025-12-01.db.gz#old999']},
            {'id': 1, 'user_id': 1, 'chat_id': 1, 'role': 'assistant', 'content': '[{"type":"function","function":{"name":"create_event","arguments":"{}"}}]', 'created_at': '2026-01-01T00:05:00Z', 'source_refs': ['data/calendar.db#live222']},
        ]
        candidates, summary = MODULE.audit(rows, b'key', {})
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]['observed_tools'], [], 'a different snapshot lineage must never be stitched into the same causal turn')
        self.assertEqual(summary['evidence_detached_unknown_provenance_rows'], 1)

    def test_ambiguous_provenance_without_recorded_source_is_not_attached(self):
        rows = [
            {'id': 1, 'user_id': 1, 'chat_id': 1, 'role': 'user', 'content': 'Создай встречу завтра', 'created_at': '2026-01-01T00:00:00Z'},
            {'id': 2, 'user_id': 1, 'chat_id': 1, 'role': 'assistant', 'content': '[{"type":"function","function":{"name":"create_event","arguments":"{}"}}]', 'created_at': '2026-01-01T00:05:00Z'},
        ]
        candidates, summary = MODULE.audit(rows, b'key', {})
        self.assertEqual(candidates[0]['observed_tools'], [])
        self.assertEqual(summary['evidence_detached_unknown_provenance_rows'], 1)

    def test_load_merge_archive_rejects_a_different_schema_version(self):
        with self.assertRaises(ValueError):
            MODULE.load_merge_archive({'rows': [], 'sources': [], 'lexicon': {}, 'schema_version': MODULE.SCHEMA_VERSION - 1}, 'digest')

    def test_load_merge_archive_rejects_a_missing_schema_version(self):
        with self.assertRaises(ValueError):
            MODULE.load_merge_archive({'rows': [], 'sources': [], 'lexicon': {}}, 'digest')

    def test_load_merge_archive_accepts_the_current_schema_version(self):
        rows, sources, lexicon = MODULE.load_merge_archive({'rows': [{'id': 1}], 'sources': [{'kind': 'sqlite', 'name': 'x'}], 'lexicon': {'A': 'PERSON'}, 'schema_version': MODULE.SCHEMA_VERSION}, 'digest')
        self.assertEqual(rows, [{'id': 1}])
        self.assertEqual(lexicon, {'A': 'PERSON'})

    def test_load_merge_archive_namespaces_legacy_provenance_by_archive_and_row_position(self):
        rows, sources, lexicon = MODULE.load_merge_archive([{'row': {'id': 2}, 'sources': ['old.db']}], 'archive-digest-value')
        self.assertEqual(rows[0]['id'], 2)
        self.assertNotEqual(rows[0]['source_refs'], ['old.db'], 'a bare legacy name must never be usable for lineage matching')
        self.assertIn('old.db', rows[0]['source_refs'][0])
        self.assertIn('archive-digest-value'[:12], rows[0]['source_refs'][0])

    def test_legacy_archive_rows_never_auto_attach_even_within_the_same_archive(self):
        content = [
            {'row': {'id': 1, 'user_id': 1, 'chat_id': 1, 'role': 'user', 'content': 'Создай встречу завтра', 'created_at': '2026-01-01T00:00:00Z'}, 'sources': ['old.db']},
            {'row': {'id': 2, 'user_id': 1, 'chat_id': 1, 'role': 'assistant', 'content': '[{"type":"function","function":{"name":"create_event","arguments":"{}"}}]', 'created_at': '2026-01-01T00:05:00Z'}, 'sources': ['old.db']},
        ]
        rows, sources, lexicon = MODULE.load_merge_archive(content, 'same-archive-digest')
        candidates, summary = MODULE.audit(rows, b'key', {})
        self.assertEqual(candidates[0]['observed_tools'], [], 'legacy pre-versioning provenance predates lineage tracking and must stay unattached even to itself')
        self.assertEqual(summary['evidence_detached_unknown_provenance_rows'], 1)

    def test_two_legacy_archives_sharing_a_bare_name_are_never_treated_as_one_lineage(self):
        rows_a, _, _ = MODULE.load_merge_archive([{'row': {'id': 1, 'user_id': 1, 'chat_id': 1, 'role': 'user', 'content': 'Создай встречу завтра', 'created_at': '2026-01-01T00:00:00Z'}, 'sources': ['old.db']}], 'archive-a-digest')
        rows_b, _, _ = MODULE.load_merge_archive([{'row': {'id': 1, 'user_id': 1, 'chat_id': 1, 'role': 'assistant', 'content': '[{"type":"function","function":{"name":"create_event","arguments":"{}"}}]', 'created_at': '2026-01-01T00:05:00Z'}, 'sources': ['old.db']}], 'archive-b-digest')
        candidates, summary = MODULE.audit(rows_a + rows_b, b'key', {})
        self.assertEqual(candidates[0]['observed_tools'], [], 'two archives sharing a bare provenance name must never look like one lineage')
        self.assertEqual(summary['evidence_detached_unknown_provenance_rows'], 1)

    def test_load_merge_archive_rejects_an_unrecognized_shape(self):
        with self.assertRaises(ValueError):
            MODULE.load_merge_archive({'unexpected': True}, 'digest')

    def test_read_bounded_merge_archive_rejects_a_symlinked_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            outside = pathlib.Path(tmp) / 'outside.json'
            outside.write_text('{}')
            link = pathlib.Path(tmp) / 'merge-link.json'
            link.symlink_to(outside)
            # O_NOFOLLOW makes the kernel itself refuse the open (ELOOP), a
            # stronger guarantee than a prior path-based check-then-open.
            with self.assertRaises(OSError):
                MODULE.read_bounded_merge_archive(link)

    def test_read_bounded_merge_archive_rejects_an_oversized_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            big = pathlib.Path(tmp) / 'big.json'
            big.write_bytes(b'0')
            with self.assertRaises(ValueError):
                MODULE.read_bounded_merge_archive(big, max_bytes=0)

    def test_read_bounded_merge_archive_bounds_the_read_even_if_fstat_under_reports_size(self):
        # open_regular_bounded's fstat check only reflects the size at open
        # time; if the file grows afterward (same fd, same inode) the read
        # itself -- not just that earlier check -- must stay bounded.
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / 'grows.json'
            path.write_bytes(b'y' * 1000)
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
            small = pathlib.Path(tmp) / 'small.json'
            small.write_bytes(b'{"a":1}')
            self.assertEqual(MODULE.read_bounded_merge_archive(small), b'{"a":1}')

    def test_bridging_chain_of_short_gaps_does_not_extend_the_attachment_window_past_1800s_from_the_trigger(self):
        rows = [
            {'id': 1, 'user_id': 1, 'chat_id': 1, 'role': 'user', 'content': 'Создай встречу завтра', 'created_at': '2026-01-01T00:00:00Z', 'source_refs': ['data/calendar.db#aaa111']},
            {'id': 2, 'user_id': 1, 'chat_id': 1, 'role': 'assistant', 'content': '[{"type":"function","function":{"name":"create_event","arguments":"{}"}}]', 'created_at': '2026-01-01T00:20:00Z', 'source_refs': ['data/calendar.db#aaa111']},
            {'id': 3, 'user_id': 1, 'chat_id': 1, 'role': 'assistant', 'content': '[{"type":"function","function":{"name":"send_invitation","arguments":"{}"}}]', 'created_at': '2026-01-01T00:35:00Z', 'source_refs': ['data/calendar.db#aaa111']},
        ]
        candidates, summary = MODULE.audit(rows, b'key', {})
        self.assertEqual(candidates[0]['observed_tools'], ['create_event'], 'the second tool row is 2100s after the trigger and must not bridge in via a short gap from the first tool row')
        self.assertNotIn('send_invitation', candidates[0]['observed_tools'])
        self.assertEqual(summary['evidence_detached_stale_session_rows'], 1)

    def test_symlinked_source_file_outside_root_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / 'root'
            (root / 'data').mkdir(parents=True)
            outside = pathlib.Path(tmp) / 'outside.db'
            outside.write_text('not really a database')
            link = root / 'data' / 'evil.db'
            link.symlink_to(outside)
            self.assertFalse(MODULE.is_safe_source_file(link, root))

    def test_regular_source_file_within_root_is_safe(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / 'data').mkdir()
            real = root / 'data' / 'real.db'
            real.write_bytes(b'')
            self.assertTrue(MODULE.is_safe_source_file(real, root))

    def test_collect_records_a_symlinked_database_as_skipped_not_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / 'root'
            (root / 'data').mkdir(parents=True)
            (root / 'logs').mkdir()
            outside = pathlib.Path(tmp) / 'outside.db'
            outside.write_bytes(b'not a real db')
            (root / 'data' / 'evil.db').symlink_to(outside)
            rows, sources, lexicon = MODULE.collect(root)
            evil = [s for s in sources if s['name'] == 'data/evil.db']
            self.assertEqual(len(evil), 1)
            self.assertEqual(evil[0]['status'], 'skipped_unsafe_path')

    def test_collect_excludes_wal_and_shm_sidecars_of_a_pre_backup_database_from_standalone_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / 'root'
            (root / 'data').mkdir(parents=True)
            (root / 'logs').mkdir()
            main = root / 'data' / 'calendar.db.pre-intent-seed-backup'
            conn = sqlite3.connect(str(main))
            try:
                conn.execute('PRAGMA journal_mode=WAL')
                conn.execute('PRAGMA wal_autocheckpoint=0')
                conn.execute('CREATE TABLE chat_history (id INTEGER PRIMARY KEY, user_id INTEGER, chat_id INTEGER, role TEXT, content TEXT, created_at TEXT)')
                conn.execute("INSERT INTO chat_history (user_id, chat_id, role, content, created_at) VALUES (1, 1, 'user', 'Привет', '2026-01-01T00:00:00Z')")
                conn.commit()
                shm = root / 'data' / 'calendar.db.pre-intent-seed-backup-shm'
                wal = root / 'data' / 'calendar.db.pre-intent-seed-backup-wal'
                self.assertTrue(shm.exists() and wal.exists(), 'WAL mode must actually create the real sidecars this test exercises')
                rows, sources, lexicon = MODULE.collect(root)
                # Checked with the writer connection still open: collect() itself must
                # never delete or move these -- unlike closing the last writer
                # connection (below), which triggers SQLite's own unrelated
                # auto-checkpoint cleanup and is not something this tool controls.
                self.assertTrue(shm.exists(), 'collect() must never delete or move a WAL sidecar')
                self.assertTrue(wal.exists(), 'collect() must never delete or move a WAL sidecar')
            finally:
                conn.close()
            names = {s['name'] for s in sources}
            self.assertNotIn('data/calendar.db.pre-intent-seed-backup-shm', names, 'a WAL shared-memory sidecar must never be classified as its own standalone database source')
            self.assertNotIn('data/calendar.db.pre-intent-seed-backup-wal', names, 'a WAL sidecar must never be classified as its own standalone database source')
            main_source = [s for s in sources if s['name'] == 'data/calendar.db.pre-intent-seed-backup'][0]
            self.assertEqual(main_source['status'], 'read')
            self.assertEqual(main_source['rows'], 1, "the parent db's own committed row must still be read correctly, including via its real WAL sidecar")

    def test_collect_rejects_an_oversized_wal_sidecar_instead_of_reading_it_unbounded(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / 'root'
            (root / 'data').mkdir(parents=True)
            (root / 'logs').mkdir()
            main = root / 'data' / 'calendar.db'
            main.write_bytes(b'')  # zero bytes: well under any bound on its own
            wal = root / 'data' / 'calendar.db-wal'
            wal.write_bytes(b'0' * 2000)  # larger than the bound this test sets below
            original_bound = MODULE.MAX_DATABASE_BYTES
            MODULE.MAX_DATABASE_BYTES = 1000
            try:
                rows, sources, lexicon = MODULE.collect(root)
            finally:
                MODULE.MAX_DATABASE_BYTES = original_bound
            main_source = [s for s in sources if s['name'] == 'data/calendar.db'][0]
            self.assertEqual(main_source['status'], 'unreadable', 'an oversized -wal sidecar must be rejected by the same byte-ceiling invariant as the main db file, not read without any bound')

    def test_collect_includes_committed_wal_only_rows_from_a_live_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / 'root'
            (root / 'data').mkdir(parents=True)
            (root / 'logs').mkdir()
            db_path = root / 'data' / 'calendar.db'
            conn = sqlite3.connect(str(db_path))
            try:
                conn.execute('PRAGMA journal_mode=WAL')
                conn.execute('PRAGMA wal_autocheckpoint=0')
                conn.execute('CREATE TABLE chat_history (id INTEGER PRIMARY KEY, user_id INTEGER, chat_id INTEGER, role TEXT, content TEXT, created_at TEXT)')
                conn.execute("INSERT INTO chat_history (user_id, chat_id, role, content, created_at) VALUES (1, 1, 'user', 'Привет', '2026-01-01T00:00:00Z')")
                conn.commit()
                # Connection stays open (WAL row not checkpointed into the main .db file) while collect() runs.
                rows, sources, lexicon = MODULE.collect(root)
            finally:
                conn.close()
            db_source = [s for s in sources if s['name'] == 'data/calendar.db'][0]
            self.assertEqual(db_source['status'], 'read')
            self.assertEqual(db_source['rows'], 1, 'collect() must see the committed WAL-only row via a real read-only SQLite transaction, not silently drop it by byte-copying only the main .db file')
            self.assertEqual(len(rows), 1)

    def test_inability_complaint_is_not_mistaken_for_the_action_it_names(self):
        self.assertEqual(MODULE.suggest_labels('Не могу создать событие, помоги'), ['feedback'])

    def test_unknown_label_is_the_explicit_fallback_for_unmatched_text(self):
        self.assertEqual(MODULE.suggest_labels('лорем ипсум долор сит амет'), ['unknown'])

    def test_invalid_timestamp_rows_are_counted_and_excluded_not_crashed_on(self):
        rows = [
            {'id': 1, 'user_id': 1, 'chat_id': 1, 'role': 'user', 'content': 'Привет', 'created_at': 'not-a-date'},
            {'id': 2, 'user_id': 1, 'chat_id': 1, 'role': 'user', 'content': 'Привет снова', 'created_at': '2026-01-01T00:00:00Z'},
        ]
        candidates, summary = MODULE.audit(rows, b'key', {})
        self.assertEqual(summary['invalid_timestamp_rows'], 1)
        self.assertEqual(len(candidates), 1)

    def test_scope_falls_back_to_user_id_when_chat_id_is_missing(self):
        rows = [{'id': 1, 'user_id': 7, 'role': 'user', 'content': 'Привет', 'created_at': '2026-01-01T00:00:00Z'}]
        candidates, summary = MODULE.audit(rows, b'key', {})
        self.assertEqual(summary['user_candidates'], 1)

    def test_auth_window_boundary_is_inclusive_at_1800_seconds_and_excludes_beyond(self):
        rows = [{'scope': 'a', 'at': 0, 'text': '/connect_telegram'}, {'scope': 'a', 'at': 1800, 'text': 'reply within window'}, {'scope': 'a', 'at': 1801.5, 'text': 'reply just outside window'}]
        blocked = MODULE.quarantined_indices(rows)
        self.assertIn(1, blocked)
        self.assertNotIn(2, blocked)

    def test_detached_debug_run_with_no_preceding_session_still_produces_a_partial_candidate(self):
        text = ('[2026-01-01T00:00:00Z]\nCHAT: 5 | USER: uid:9\nSUPPLEMENT: false\nMESSAGE: расскажи о завтрашнем дне\n' + '=' * 50 + '\nResponse (5 chars):\nПривет\n' + '=' * 50 + '\n')
        rows = MODULE.parse_debug_runs(text)
        candidates, summary = MODULE.audit(rows, b'key', {})
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]['historical_state'], 'not_reconstructed')
        self.assertEqual(candidates[0]['label_status'], 'needs_adjudication')

    def _digest(self, label):
        return hashlib.sha256(label.encode()).hexdigest()

    def _gold_record(self, source_ref, corpus_label, statuses=None):
        statuses = statuses or {}
        reviews = {dimension: {'reviewer_id': f'reviewer-{dimension}', 'status': statuses.get(dimension, 'approved')} for dimension in MODULE.GOLD_REVIEW_DIMENSIONS}
        return {'source_ref': source_ref, 'corpus_candidate_sha256': self._digest(corpus_label), 'intent': 'event.create', 'slots': {'when': 'завтра'}, 'expected_outcome': 'event_created', 'reviews': reviews}

    def test_validate_gold_record_requires_all_fields(self):
        with self.assertRaises(ValueError):
            MODULE.validate_gold_record({'source_ref': 'x'})

    def test_validate_gold_record_rejects_a_non_hex_corpus_digest(self):
        record = self._gold_record('ref-1', 'sha-1')
        record['corpus_candidate_sha256'] = 'not-a-real-sha256'
        with self.assertRaises(ValueError):
            MODULE.validate_gold_record(record)

    def test_validate_gold_record_rejects_a_missing_intent(self):
        record = self._gold_record('ref-1', 'sha-1')
        record['intent'] = None
        with self.assertRaises(ValueError):
            MODULE.validate_gold_record(record)

    def test_validate_gold_record_rejects_slots_that_are_not_a_mapping(self):
        record = self._gold_record('ref-1', 'sha-1')
        record['slots'] = []
        with self.assertRaises(ValueError):
            MODULE.validate_gold_record(record)

    def test_validate_gold_record_rejects_a_non_string_expected_outcome(self):
        record = self._gold_record('ref-1', 'sha-1')
        record['expected_outcome'] = 7
        with self.assertRaises(ValueError):
            MODULE.validate_gold_record(record)

    def test_validate_gold_record_requires_every_independent_review_dimension(self):
        record = self._gold_record('ref-1', 'sha-1')
        del record['reviews']['slots']
        with self.assertRaises(ValueError):
            MODULE.validate_gold_record(record)

    def test_validate_gold_record_rejects_an_unknown_review_status(self):
        record = self._gold_record('ref-1', 'sha-1', statuses={'privacy': 'maybe'})
        with self.assertRaises(ValueError):
            MODULE.validate_gold_record(record)

    def test_validate_gold_record_rejects_a_review_with_no_reviewer_identity(self):
        record = self._gold_record('ref-1', 'sha-1')
        record['reviews']['intent']['reviewer_id'] = ''
        with self.assertRaises(ValueError):
            MODULE.validate_gold_record(record)

    def test_validate_gold_record_rejects_a_non_string_slot_value(self):
        record = self._gold_record('ref-1', 'sha-1')
        record['slots'] = {'when': 7}
        with self.assertRaises(ValueError):
            MODULE.validate_gold_record(record)

    def test_validate_gold_record_rejects_a_non_string_slot_key(self):
        record = self._gold_record('ref-1', 'sha-1')
        record['slots'] = {7: 'завтра'}
        with self.assertRaises(ValueError):
            MODULE.validate_gold_record(record)

    def test_validate_gold_record_rejects_a_compound_multi_intent_string_as_unsupported(self):
        record = self._gold_record('ref-1', 'sha-1')
        record['intent'] = 'event.create,invitation.send'
        with self.assertRaises(ValueError):
            MODULE.validate_gold_record(record)

    def test_apply_gold_import_requires_every_dimension_approved_before_train_eligible(self):
        candidate = MODULE.candidate_record('Создай встречу', ['create_event'], b'key')
        candidate['source_ref'] = 'ref-1'
        gold = [self._gold_record('ref-1', 'sha-1')]
        updated, report = MODULE.apply_gold_import([candidate], gold, self._digest('sha-1'))
        self.assertEqual(updated[0]['gold']['intent'], 'event.create')
        self.assertTrue(updated[0]['train_eligible'])
        self.assertEqual(report['gold_fully_approved'], 1)

    def test_apply_gold_import_withholds_train_eligible_when_a_single_dimension_is_not_approved(self):
        candidate = MODULE.candidate_record('Создай встречу', [], b'key')
        candidate['source_ref'] = 'ref-2'
        gold = [self._gold_record('ref-2', 'sha-1', statuses={'expected_outcome': 'needs_more_info'})]
        updated, report = MODULE.apply_gold_import([candidate], gold, self._digest('sha-1'))
        self.assertFalse(updated[0]['train_eligible'])
        self.assertEqual(updated[0]['label_status'], 'gold_partial_or_rejected')
        self.assertIsNone(updated[0]['gold'], 'a non-approved adjudication must never populate the gold field')
        self.assertEqual(updated[0]['gold_adjudication']['expected_outcome'], 'event_created')

    def test_apply_gold_import_counts_an_unknown_source_ref_without_crashing(self):
        candidate = MODULE.candidate_record('x', [], b'key')
        candidate['source_ref'] = 'ref-3'
        gold = [self._gold_record('missing', 'sha-1')]
        updated, report = MODULE.apply_gold_import([candidate], gold, self._digest('sha-1'))
        self.assertIsNone(updated[0]['gold'])
        self.assertEqual(report['gold_rejected_unknown_source'], 1)

    def test_apply_gold_import_rejects_gold_bound_to_a_different_corpus_snapshot(self):
        candidate = MODULE.candidate_record('x', [], b'key')
        candidate['source_ref'] = 'ref-4'
        gold = [self._gold_record('ref-4', 'stale-sha')]
        updated, report = MODULE.apply_gold_import([candidate], gold, self._digest('current-sha'))
        self.assertIsNone(updated[0]['gold'])
        self.assertEqual(report['gold_rejected_corpus_mismatch'], 1)

    def test_apply_gold_import_hard_rejects_train_eligible_for_a_privacy_quarantined_candidate_even_when_all_reviews_are_approved(self):
        candidate = MODULE.candidate_record('пароль от телеграм 12345', ['create_event'], b'key')
        candidate['source_ref'] = 'ref-quarantine'
        self.assertEqual(candidate['text_candidate'], '[QUARANTINED_AUTH]')
        self.assertEqual(candidate['privacy_status'], 'quarantined')
        gold = [self._gold_record('ref-quarantine', 'sha-1')]
        updated, report = MODULE.apply_gold_import([candidate], gold, self._digest('sha-1'))
        self.assertFalse(updated[0]['train_eligible'], 'a caller-supplied approval must never override a source privacy quarantine')
        self.assertIsNone(updated[0]['gold'])
        self.assertEqual(report['gold_rejected_source_quarantined'], 1)

    def test_apply_gold_import_hard_rejects_a_quarantined_text_candidate_even_if_privacy_status_was_overwritten(self):
        candidate = MODULE.candidate_record('x', [], b'key')
        candidate['source_ref'] = 'ref-quarantine-2'
        candidate['text_candidate'] = '[QUARANTINED_AUTH]'  # simulates any other path that could set the marker text directly
        candidate['privacy_status'] = 'pseudonymized_candidate_needs_review'  # a caller/reviewer field must not be trusted to clear a source quarantine
        gold = [self._gold_record('ref-quarantine-2', 'sha-1')]
        updated, report = MODULE.apply_gold_import([candidate], gold, self._digest('sha-1'))
        self.assertFalse(updated[0]['train_eligible'])
        self.assertEqual(report['gold_rejected_source_quarantined'], 1)

    def test_open_regular_bounded_rejects_a_symlink_via_no_follow(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / 'target.db'
            target.write_bytes(b'data')
            link = pathlib.Path(tmp) / 'link.db'
            link.symlink_to(target)
            with self.assertRaises(OSError):
                MODULE.open_regular_bounded(link, 1024)

    def test_open_regular_bounded_rejects_an_oversized_regular_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            big = pathlib.Path(tmp) / 'big.db'
            big.write_bytes(b'0123456789')
            with self.assertRaises(ValueError):
                MODULE.open_regular_bounded(big, 5)

    def test_open_regular_bounded_returns_a_readable_fd_for_a_safe_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            small = pathlib.Path(tmp) / 'small.db'
            small.write_bytes(b'hello')
            fd = MODULE.open_regular_bounded(small, 1024)
            try:
                self.assertEqual(os.read(fd, 1024), b'hello')
            finally:
                os.close(fd)

    def test_collect_still_rejects_a_symlinked_database_end_to_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / 'root'
            (root / 'data').mkdir(parents=True)
            (root / 'logs').mkdir()
            outside = pathlib.Path(tmp) / 'outside.db'
            outside.write_bytes(b'not a real db')
            (root / 'data' / 'evil.db').symlink_to(outside)
            rows, sources, lexicon = MODULE.collect(root)
            evil = [s for s in sources if s['name'] == 'data/evil.db']
            self.assertEqual(len(evil), 1)
            self.assertIn(evil[0]['status'], {'skipped_unsafe_path', 'unreadable'})

    def test_apply_gold_import_separates_fully_approved_from_partial_counts(self):
        approved = MODULE.candidate_record('Создай встречу', ['create_event'], b'key')
        approved['source_ref'] = 'ref-approved'
        partial = MODULE.candidate_record('Другое', [], b'key')
        partial['source_ref'] = 'ref-partial'
        gold = [
            self._gold_record('ref-approved', 'sha-1'),
            self._gold_record('ref-partial', 'sha-1', statuses={'slots': 'needs_more_info'}),
        ]
        updated, report = MODULE.apply_gold_import([approved, partial], gold, self._digest('sha-1'))
        self.assertEqual(report['gold_fully_approved'], 1)
        self.assertEqual(report['gold_partial_or_rejected_recorded'], 1)
        self.assertNotIn('gold_applied', report, 'a single combined counter would overstate validated, train-eligible gold')


# GH-721 / GH-519: backups taken before the #617 fix hold what a user typed into the Telegram-connect
# wizard. Every value below is synthetic. Neither the code nor the password trips the AUTH regex or the
# NUMBER redaction on its own (the code is too short, the password is a plain word pair), so only the
# quarantine can keep them out of the exports.
SYNTHETIC_PHONE = '+10005550123'
SYNTHETIC_CODE = '543-21'
SYNTHETIC_PASSWORD = 'Zebra-Orchid-42'
SYNTHETIC_SECRETS = (SYNTHETIC_PHONE, SYNTHETIC_CODE, SYNTHETIC_PASSWORD)
SOURCE_WIZARD_MARKER = '[redacted: connect wizard input]'  # what the #617/#641 chat logging stores
CALENDAR_REQUEST = 'Создай встречу завтра в 14:00'


def _bot(text):
    return '{"kind": "bot", "text": "%s"}' % text


def _wizard_session_rows(user_id=7, chat_id=7):
    """One English-locale connect-wizard run shaped like the pre-#617 chat_history, then two requests
    three hours later."""
    rows = [
        ('user', '{"kind": "command", "name": "connect_telegram", "args": ""}', '2026-01-01 10:00:00'),
        ('assistant', _bot('Connect Telegram Account. The bot stores a technical session, no passwords.'), '2026-01-01 10:00:02'),
        ('user', '{"kind": "button", "label": "Connect"}', '2026-01-01 10:00:10'),
        ('assistant', _bot('Enter phone number in international format:'), '2026-01-01 10:00:11'),
        ('user', SYNTHETIC_PHONE, '2026-01-01 10:00:20'),
        ('assistant', _bot('Verification code sent to Telegram.'), '2026-01-01 10:00:25'),
        ('user', SYNTHETIC_CODE, '2026-01-01 10:00:40'),
        ('assistant', _bot('You have two-factor authentication enabled. Enter your password:'), '2026-01-01 10:00:45'),
        ('user', SYNTHETIC_PASSWORD, '2026-01-01 10:01:00'),
        ('assistant', _bot('Telegram account connected'), '2026-01-01 10:01:05'),
        # The first text after the wizard's last message may answer an abandoned prompt, however late.
        ('user', 'Спасибо', '2026-01-01 12:59:00'),
        ('assistant', _bot('Пожалуйста'), '2026-01-01 12:59:05'),
        ('user', CALENDAR_REQUEST, '2026-01-01 13:00:00'),
        ('assistant', _bot('Готово'), '2026-01-01 13:00:05'),
    ]
    return [{'id': index + 1, 'user_id': user_id, 'chat_id': chat_id, 'role': role, 'content': content, 'created_at': at} for index, (role, content, at) in enumerate(rows)]


class ConnectWizardExportTests(unittest.TestCase):
    def _write_gzipped_backup(self, root, rows):
        backups = root / 'data' / 'backups'
        backups.mkdir(parents=True)
        (root / 'logs').mkdir()
        plain = root / 'plain.db'
        conn = sqlite3.connect(str(plain))
        try:
            conn.execute('CREATE TABLE chat_history (id INTEGER PRIMARY KEY, user_id INTEGER, chat_id INTEGER, role TEXT, content TEXT, created_at TEXT)')
            conn.executemany('INSERT INTO chat_history (id, user_id, chat_id, role, content, created_at) VALUES (:id, :user_id, :chat_id, :role, :content, :created_at)', rows)
            conn.commit()
        finally:
            conn.close()
        (backups / 'calendar_2026-01-02_03-00-00.db.gz').write_bytes(gzip.compress(plain.read_bytes()))
        plain.unlink()

    def _run_builder(self, root, out, merges=()):
        command = [sys.executable, str(ROOT / 'scripts' / 'nlu_corpus.py'), '--root', str(root), '--out', str(out)]
        for archive in merges:
            command += ['--merge', str(archive)]
        return subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, check=False, timeout=120)

    def _assert_no_synthetic_secret_anywhere(self, out, result):
        outputs = {path.name: path.read_bytes() for path in out.iterdir() if path.is_file()}
        outputs['<stdout>'] = result.stdout
        outputs['<stderr>'] = result.stderr
        self.assertIn('selected.private.json', outputs)
        for name, data in outputs.items():
            for secret in SYNTHETIC_SECRETS:
                self.assertFalse(secret.encode() in data, f'a synthetic connect-wizard value reached {name}')  # never dump the file

    def _selected_rows(self, out):
        return json.loads((out / 'selected.private.json').read_text(encoding='utf-8'))['rows']

    def test_a_backup_with_connect_wizard_input_leaks_nothing_into_any_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / 'root'
            self._write_gzipped_backup(root, _wizard_session_rows())
            out = pathlib.Path(tmp) / 'out'
            result = self._run_builder(root, out)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
            self._assert_no_synthetic_secret_anywhere(out, result)
            contents = [row['content'] for row in self._selected_rows(out)]
            self.assertIn(CALENDAR_REQUEST, contents, 'a request outside the wizard window must stay in the raw export')

    def test_a_merged_archive_with_connect_wizard_input_leaks_nothing_into_any_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / 'root'
            (root / 'data').mkdir(parents=True)
            (root / 'logs').mkdir()
            rows = [dict(row, source_refs=['data/backups/old.db.gz#synthetic']) for row in _wizard_session_rows()]
            current = pathlib.Path(tmp) / 'current.json'
            current.write_text(json.dumps({'rows': rows, 'sources': [], 'lexicon': {}, 'schema_version': MODULE.SCHEMA_VERSION}))
            legacy = pathlib.Path(tmp) / 'legacy.json'
            legacy.write_text(json.dumps([{'row': row, 'sources': ['old.db']} for row in _wizard_session_rows(user_id=8, chat_id=8)]))
            out = pathlib.Path(tmp) / 'out'
            result = self._run_builder(root, out, merges=[current, legacy])
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
            self._assert_no_synthetic_secret_anywhere(out, result)

    def test_wizard_rows_are_left_out_of_the_raw_export_and_counted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / 'root'
            self._write_gzipped_backup(root, _wizard_session_rows())
            out = pathlib.Path(tmp) / 'out'
            self.assertEqual(self._run_builder(root, out).returncode, 0)
            self.assertEqual([row['id'] for row in self._selected_rows(out)], [13, 14])
            summary = json.loads((out / 'summary.json').read_text(encoding='utf-8'))
            self.assertEqual(summary['raw_export_quarantined_rows'], 12)

    def test_a_raw_export_merged_again_quarantines_nothing_it_kept(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / 'root'
            self._write_gzipped_backup(root, _wizard_session_rows())
            first = pathlib.Path(tmp) / 'first'
            self.assertEqual(self._run_builder(root, first).returncode, 0)
            empty_root = pathlib.Path(tmp) / 'empty'
            (empty_root / 'data').mkdir(parents=True)
            (empty_root / 'logs').mkdir()
            second = pathlib.Path(tmp) / 'second'
            self.assertEqual(self._run_builder(empty_root, second, merges=[first / 'selected.private.json']).returncode, 0)
            summary = json.loads((second / 'summary.json').read_text(encoding='utf-8'))
            self.assertEqual((summary['retained_rows'], summary['quarantined_auth_rows'], summary['user_candidates']), (2, 0, 1))

    def test_the_source_wizard_marker_opens_the_quarantine_window(self):
        rows = [{'scope': 'a', 'at': 0, 'role': 'user', 'text': SOURCE_WIZARD_MARKER}, {'scope': 'a', 'at': 60, 'role': 'user', 'text': SYNTHETIC_PASSWORD}, {'scope': 'b', 'at': 60, 'role': 'user', 'text': CALENDAR_REQUEST}]
        self.assertEqual(MODULE.quarantined_indices(rows), {0, 1})

    def test_the_answer_to_an_expired_credential_prompt_and_the_reply_to_it_are_quarantined_however_late(self):
        # GH-641: after an idle wizard expires, the next text still answers its credential prompt.
        rows = [
            {'scope': 'a', 'at': 0, 'role': 'assistant', 'text': _bot('Enter your password:')},
            {'scope': 'a', 'at': 7200, 'role': 'user', 'text': SYNTHETIC_PASSWORD},
            {'scope': 'a', 'at': 7205, 'role': 'assistant', 'text': _bot('Не понял: ' + SYNTHETIC_PASSWORD)},
            {'scope': 'a', 'at': 7300, 'role': 'user', 'text': CALENDAR_REQUEST},
            {'scope': 'a', 'at': 7305, 'role': 'assistant', 'text': _bot('Готово')},
        ]
        self.assertEqual(MODULE.quarantined_indices(rows), {0, 1, 2})

    def test_a_late_answer_to_a_phone_prompt_is_quarantined(self):
        rows = [
            {'scope': 'a', 'at': 0, 'role': 'assistant', 'text': _bot('Connect Telegram Account. The bot stores a technical session, no passwords.')},
            {'scope': 'a', 'at': 10, 'role': 'user', 'text': '{"kind": "button", "label": "Connect"}'},
            {'scope': 'a', 'at': 11, 'role': 'assistant', 'text': _bot('Enter phone number in international format:')},
            {'scope': 'a', 'at': 7200, 'role': 'user', 'text': SYNTHETIC_PHONE},
            {'scope': 'a', 'at': 7205, 'role': 'assistant', 'text': _bot('Готово')},
            {'scope': 'a', 'at': 9000, 'role': 'user', 'text': CALENDAR_REQUEST},
        ]
        self.assertEqual(MODULE.quarantined_indices(rows), {0, 1, 2, 3, 4})

    def test_a_wizard_tail_without_its_consent_screen_is_quarantined(self):
        # A partial source (a --merge of a partial export) may start at the phone prompt; the English
        # phone and code prompts must open the window on their own, as the Russian code prompt does.
        rows = [
            {'scope': 'a', 'at': 0, 'role': 'assistant', 'text': _bot('Enter phone number in international format:')},
            {'scope': 'a', 'at': 9, 'role': 'user', 'text': SYNTHETIC_PHONE},
            {'scope': 'a', 'at': 15, 'role': 'assistant', 'text': _bot('Verification code sent to Telegram.')},
            {'scope': 'a', 'at': 30, 'role': 'user', 'text': SYNTHETIC_CODE},
            {'scope': 'b', 'at': 30, 'role': 'user', 'text': CALENDAR_REQUEST},
        ]
        self.assertEqual(MODULE.quarantined_indices(rows), {0, 1, 2, 3})

    def test_every_credential_prompt_of_the_wizard_opens_the_window_in_both_languages(self):
        constants = (ROOT / 'src' / 'config' / 'constants.ts').read_text(encoding='utf-8')
        blocks = re.findall(r'^    connectTelegram: \{\n(.*?)^    \},$', constants, re.M | re.S)
        self.assertEqual(len(blocks), 2, 'expected the English and Russian connectTelegram strings')
        for block in blocks:
            for prompt in ('enterPhone', 'invalidPhone', 'codeSent', 'invalidCode', 'enter2fa', 'invalid2fa'):
                text = re.search(r"^      " + prompt + r":\s*'((?:[^'\\]|\\.)*)'", block, re.M)
                self.assertIsNotNone(text, f'{prompt} is no longer a plain string; update this test')
                self.assertTrue(MODULE.opens_auth_window(text[1]), f'the {prompt} prompt must open the auth window')

    def test_a_copy_of_a_late_answer_kept_by_another_source_is_quarantined_too(self):
        # The database row and the AI debug log's copy of the same late answer are two rows.
        rows = [
            {'scope': 'a', 'at': 0, 'role': 'assistant', 'text': _bot('Enter your password:')},
            {'scope': 'a', 'at': 7200, 'role': 'user', 'text': SYNTHETIC_PASSWORD},
            {'scope': 'a', 'at': 7201, 'role': 'user', 'text': SYNTHETIC_PASSWORD + '\n', 'record_kind': 'debug_run'},
            {'scope': 'a', 'at': 9000, 'role': 'user', 'text': CALENDAR_REQUEST},
        ]
        self.assertEqual(MODULE.quarantined_indices(rows), {0, 1, 2})

    def test_a_debug_run_whose_logged_history_holds_a_credential_prompt_is_quarantined(self):
        # Before #617 a cancelled wizard handed its text to the AI; the debug log may be all that is left.
        log = ('[2026-01-01T10:00:00Z]\nCHAT: 7 | USER: uid:7\nSUPPLEMENT: false\nMESSAGE: ' + SYNTHETIC_PASSWORD + '\n' + '=' * 80
               + '\n\n## HISTORY [1 messages]\n[assistant]\nEnter your password:\n## END HISTORY\n'
               + '[2026-01-01T15:00:00Z]\nCHAT: 7 | USER: uid:7\nSUPPLEMENT: false\nMESSAGE: ' + CALENDAR_REQUEST + '\n' + '=' * 80 + '\n')
        exported, counts = MODULE.raw_export(MODULE.parse_debug_runs(log), b'key', {})
        self.assertEqual([row['content'] for row in exported], [CALENDAR_REQUEST])
        self.assertEqual(counts['raw_export_quarantined_rows'], 1)

    def test_a_credential_prompt_quoted_only_in_a_debug_run_response_opens_the_window(self):
        # A pre-GH-721 export merged again: the AI's reply quoting the prompt may be the only copy left.
        rows = [
            {'id': 1, 'user_id': 7, 'chat_id': 7, 'role': 'user', 'content': 'покажи календарь', 'response': 'Enter your password:', 'record_kind': 'debug_run', 'created_at': '2026-01-01T10:00:00Z'},
            {'id': 2, 'user_id': 7, 'chat_id': 7, 'role': 'user', 'content': SYNTHETIC_PASSWORD, 'created_at': '2026-01-01T10:01:00Z'},
            {'id': 3, 'user_id': 7, 'chat_id': 7, 'role': 'user', 'content': CALENDAR_REQUEST, 'created_at': '2026-01-01T15:00:00Z'},
        ]
        exported, counts = MODULE.raw_export(rows, b'key', {})
        self.assertEqual([row['id'] for row in exported], [3])
        self.assertEqual(counts['raw_export_quarantined_rows'], 2)

    def test_an_unreadable_debug_run_response_opens_the_window(self):
        rows = [
            {'id': 1, 'user_id': 7, 'chat_id': 7, 'role': 'user', 'content': 'ok', 'response': ['Enter your password:'], 'record_kind': 'debug_run', 'created_at': '2026-01-01T10:00:00Z'},
            {'id': 2, 'user_id': 7, 'chat_id': 7, 'role': 'user', 'content': SYNTHETIC_PASSWORD, 'created_at': '2026-01-01T10:01:00Z'},
        ]
        exported, counts = MODULE.raw_export(rows, b'key', {})
        self.assertEqual(exported, [])
        self.assertEqual(counts['raw_export_quarantined_rows'], 2)

    def test_an_empty_quarantined_text_does_not_quarantine_every_empty_row(self):
        rows = [
            {'scope': 'a', 'at': 0, 'role': 'assistant', 'text': _bot('Enter your password:')},
            {'scope': 'a', 'at': 10, 'role': 'user', 'text': ''},
            {'scope': 'a', 'at': 9000, 'role': 'user', 'text': CALENDAR_REQUEST},
            {'scope': 'a', 'at': 9005, 'role': 'assistant', 'text': ''},
        ]
        self.assertEqual(MODULE.quarantined_indices(rows), {0, 1})

    def test_python_wizard_marker_matches_the_one_chat_logging_stores(self):
        scene = (ROOT / 'src' / 'bot' / 'scenes' / 'connect-telegram.scene.ts').read_text(encoding='utf-8')
        declared = re.search(r"^export const CONNECT_WIZARD_REDACTION = '([^']*)';$", scene, re.M)
        self.assertIsNotNone(declared, 'CONNECT_WIZARD_REDACTION moved; point nlu_corpus.py at its new home')
        self.assertEqual(MODULE.CONNECT_WIZARD_REDACTION, declared[1])

    def test_free_text_outside_the_window_is_pseudonymized_in_the_raw_export(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / 'root'
            (root / 'data').mkdir(parents=True)
            (root / 'logs').mkdir()
            (root / 'logs' / 'ai-debug.log').write_text(
                '[2026-01-01T09:00:00Z]\nCHAT: 5 | USER: uid:9\nSUPPLEMENT: false\nMESSAGE: позвони на ' + SYNTHETIC_PHONE + '\n'
                + '=' * 50 + '\nResponse (20 chars):\nЗвоню на ' + SYNTHETIC_PHONE + '\n' + '=' * 50 + '\n', encoding='utf-8')
            out = pathlib.Path(tmp) / 'out'
            result = self._run_builder(root, out)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
            self._assert_no_synthetic_secret_anywhere(out, result)
            [row] = self._selected_rows(out)
            self.assertTrue(row['content'].startswith('позвони на [NUMBER_'), 'the message itself stays in the export, pseudonymized')

    def test_rows_the_export_cannot_place_read_or_rebuild_are_kept_out_and_counted(self):
        rows = [
            {'id': 1, 'user_id': 1, 'chat_id': 1, 'role': 'user', 'content': SYNTHETIC_PASSWORD, 'created_at': 'not-a-date', 'source_refs': ['x#1']},
            {'id': 6, 'user_id': 1, 'chat_id': 1, 'role': 'user', 'content': SYNTHETIC_PASSWORD, 'created_at': 20260101, 'source_refs': ['x#1']},
            {'id': 2, 'user_id': 2, 'chat_id': 2, 'role': 'user', 'content': {'text': SYNTHETIC_CODE}, 'created_at': '2026-01-01 09:00:00', 'source_refs': ['x#1']},
            {'id': 3, 'user_id': 2, 'chat_id': 2, 'role': 'user', 'content': SYNTHETIC_PASSWORD, 'created_at': '2026-01-01 09:05:00', 'source_refs': ['x#1']},
            {'id': 4, 'user_id': 1, 'chat_id': 1, 'role': 'user', 'content': 'Готово', 'created_at': '2026-01-01 09:10:00', 'source_refs': ['x#1'], 'tools': [SYNTHETIC_PASSWORD]},
            {'id': 5, 'user_id': 1, 'chat_id': 1, 'role': 'user', 'content': CALENDAR_REQUEST, 'created_at': '2026-01-01 12:00:00', 'source_refs': ['x#1'], 'note': SYNTHETIC_PASSWORD},
        ]
        exported, counts = MODULE.raw_export(rows, b'key', {})
        self.assertEqual(exported, [{'id': 5, 'user_id': 1, 'chat_id': 1, 'role': 'user', 'content': CALENDAR_REQUEST, 'created_at': '2026-01-01 12:00:00', 'source_refs': ['x#1']}])
        self.assertEqual(counts, {'raw_export_quarantined_rows': 2, 'raw_export_omitted_rows': 3}, 'unreadable text opens the auth window like a credential term')
