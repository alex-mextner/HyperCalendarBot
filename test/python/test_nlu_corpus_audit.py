"""Audit(): which assistant/tool rows attach to a candidate, session and quarantine windows, row placement."""

import unittest

from nlu_corpus_support import MODULE


class NluCorpusTests(unittest.TestCase):
    def test_tool_row_within_the_same_session_and_lineage_is_attached(self):
        rows = [
            {
                "id": 1,
                "user_id": 1,
                "chat_id": 1,
                "role": "user",
                "content": "Создай встречу завтра",
                "created_at": "2026-01-01T00:00:00Z",
                "source_refs": ["data/calendar.db#aaa111"],
            },
            {
                "id": 2,
                "user_id": 1,
                "chat_id": 1,
                "role": "assistant",
                "content": '[{"type":"function","function":{"name":"create_event","arguments":"{}"}}]',
                "created_at": "2026-01-01T00:05:00Z",
                "source_refs": ["data/calendar.db#aaa111"],
            },
        ]
        candidates, summary = MODULE.audit(rows, b"key", {})
        self.assertEqual(candidates[0]["observed_tools"], ["create_event"])
        self.assertEqual(summary["evidence_detached_unknown_provenance_rows"], 0)

    def test_far_future_tool_row_is_not_attached_to_a_stale_earlier_request(self):
        rows = [
            {
                "id": 1,
                "user_id": 1,
                "chat_id": 1,
                "role": "user",
                "content": "Создай встречу завтра",
                "created_at": "2026-01-01T00:00:00Z",
                "source_refs": ["data/calendar.db#aaa111"],
            },
            {
                "id": 2,
                "user_id": 1,
                "chat_id": 1,
                "role": "assistant",
                "content": '[{"type":"function","function":{"name":"create_event","arguments":"{}"}}]',
                "created_at": "2026-01-05T00:00:00Z",
                "source_refs": ["data/calendar.db#aaa111"],
            },
        ]
        candidates, _summary = MODULE.audit(rows, b"key", {})
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["observed_tools"], [])
        self.assertEqual(candidates[0]["observed_responses"], [])

    def test_cross_snapshot_tool_row_is_not_attached_even_within_the_same_time_window(self):
        rows = [
            {
                "id": 1,
                "user_id": 1,
                "chat_id": 1,
                "role": "user",
                "content": "Создай встречу завтра",
                "created_at": "2026-01-01T00:00:00Z",
                "source_refs": ["data/backups/calendar-2025-12-01.db.gz#old999"],
            },
            {
                "id": 1,
                "user_id": 1,
                "chat_id": 1,
                "role": "assistant",
                "content": '[{"type":"function","function":{"name":"create_event","arguments":"{}"}}]',
                "created_at": "2026-01-01T00:05:00Z",
                "source_refs": ["data/calendar.db#live222"],
            },
        ]
        candidates, summary = MODULE.audit(rows, b"key", {})
        self.assertEqual(len(candidates), 1)
        self.assertEqual(
            candidates[0]["observed_tools"],
            [],
            "a different snapshot lineage must never be stitched into the same causal turn",
        )
        self.assertEqual(summary["evidence_detached_unknown_provenance_rows"], 1)

    def test_ambiguous_provenance_without_recorded_source_is_not_attached(self):
        rows = [
            {
                "id": 1,
                "user_id": 1,
                "chat_id": 1,
                "role": "user",
                "content": "Создай встречу завтра",
                "created_at": "2026-01-01T00:00:00Z",
            },
            {
                "id": 2,
                "user_id": 1,
                "chat_id": 1,
                "role": "assistant",
                "content": '[{"type":"function","function":{"name":"create_event","arguments":"{}"}}]',
                "created_at": "2026-01-01T00:05:00Z",
            },
        ]
        candidates, summary = MODULE.audit(rows, b"key", {})
        self.assertEqual(candidates[0]["observed_tools"], [])
        self.assertEqual(summary["evidence_detached_unknown_provenance_rows"], 1)

    def test_bridging_chain_of_short_gaps_does_not_extend_the_attachment_window_past_1800s_from_the_trigger(
        self,
    ):
        rows = [
            {
                "id": 1,
                "user_id": 1,
                "chat_id": 1,
                "role": "user",
                "content": "Создай встречу завтра",
                "created_at": "2026-01-01T00:00:00Z",
                "source_refs": ["data/calendar.db#aaa111"],
            },
            {
                "id": 2,
                "user_id": 1,
                "chat_id": 1,
                "role": "assistant",
                "content": '[{"type":"function","function":{"name":"create_event","arguments":"{}"}}]',
                "created_at": "2026-01-01T00:20:00Z",
                "source_refs": ["data/calendar.db#aaa111"],
            },
            {
                "id": 3,
                "user_id": 1,
                "chat_id": 1,
                "role": "assistant",
                "content": '[{"type":"function","function":{"name":"send_invitation","arguments":"{}"}}]',
                "created_at": "2026-01-01T00:35:00Z",
                "source_refs": ["data/calendar.db#aaa111"],
            },
        ]
        candidates, summary = MODULE.audit(rows, b"key", {})
        self.assertEqual(
            candidates[0]["observed_tools"],
            ["create_event"],
            "the second tool row is 2100s after the trigger and must not bridge in via a short gap from the first tool row",
        )
        self.assertNotIn("send_invitation", candidates[0]["observed_tools"])
        self.assertEqual(summary["evidence_detached_stale_session_rows"], 1)

    def test_invalid_timestamp_rows_are_counted_and_excluded_not_crashed_on(self):
        rows = [
            {
                "id": 1,
                "user_id": 1,
                "chat_id": 1,
                "role": "user",
                "content": "Привет",
                "created_at": "not-a-date",
            },
            {
                "id": 2,
                "user_id": 1,
                "chat_id": 1,
                "role": "user",
                "content": "Привет снова",
                "created_at": "2026-01-01T00:00:00Z",
            },
        ]
        candidates, summary = MODULE.audit(rows, b"key", {})
        self.assertEqual(summary["invalid_timestamp_rows"], 1)
        self.assertEqual(len(candidates), 1)

    def test_scope_falls_back_to_user_id_when_chat_id_is_missing(self):
        rows = [
            {
                "id": 1,
                "user_id": 7,
                "role": "user",
                "content": "Привет",
                "created_at": "2026-01-01T00:00:00Z",
            }
        ]
        _candidates, summary = MODULE.audit(rows, b"key", {})
        self.assertEqual(summary["user_candidates"], 1)

    def test_auth_window_boundary_is_inclusive_at_1800_seconds_and_excludes_beyond(self):
        rows = [
            {"scope": "a", "at": 0, "text": "/connect_telegram"},
            {"scope": "a", "at": 1800, "text": "reply within window"},
            {"scope": "a", "at": 1801.5, "text": "reply just outside window"},
        ]
        blocked = MODULE.quarantined_indices(rows)
        self.assertIn(1, blocked)
        self.assertNotIn(2, blocked)

    def test_detached_debug_run_with_no_preceding_session_still_produces_a_partial_candidate(self):
        text = (
            "[2026-01-01T00:00:00Z]\nCHAT: 5 | USER: uid:9\nSUPPLEMENT: false\nMESSAGE: расскажи о завтрашнем дне\n"
            + "=" * 50
            + "\nResponse (5 chars):\nПривет\n"
            + "=" * 50
            + "\n"
        )
        rows = MODULE.parse_debug_runs(text)
        candidates, _summary = MODULE.audit(rows, b"key", {})
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["historical_state"], "not_reconstructed")
        self.assertEqual(candidates[0]["label_status"], "needs_adjudication")
