import hashlib
import importlib.util
import os
import pathlib
import stat
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
            with self.assertRaises(ValueError):
                MODULE.read_bounded_merge_archive(link)

    def test_read_bounded_merge_archive_rejects_an_oversized_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            big = pathlib.Path(tmp) / 'big.json'
            big.write_bytes(b'0')
            with self.assertRaises(ValueError):
                MODULE.read_bounded_merge_archive(big, max_bytes=0)

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

    def test_apply_gold_import_requires_every_dimension_approved_before_train_eligible(self):
        candidate = MODULE.candidate_record('Создай встречу', ['create_event'], b'key')
        candidate['source_ref'] = 'ref-1'
        gold = [self._gold_record('ref-1', 'sha-1')]
        updated, report = MODULE.apply_gold_import([candidate], gold, self._digest('sha-1'))
        self.assertEqual(updated[0]['gold']['intent'], 'event.create')
        self.assertTrue(updated[0]['train_eligible'])
        self.assertEqual(report['gold_applied'], 1)

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
