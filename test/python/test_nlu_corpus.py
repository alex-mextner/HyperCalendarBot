"""Candidate text: redaction, rule-based labels, debug-run parsing, pseudonyms."""

import unittest

from nlu_corpus_support import MODULE


class NluCorpusTests(unittest.TestCase):
    def test_known_person_contact_and_coordinates_are_not_published(self):
        text = "Пригласи Ивана @synthetic_user test@example.invalid в 14:00 на 44.8125, 20.4612"
        safe = MODULE.redact_candidate(text, b"synthetic-key", {"Ивана": "PERSON"})
        for private in ["Ивана", "@synthetic_user", "test@example.invalid", "44.8125", "20.4612"]:
            self.assertNotIn(private, safe)
        self.assertIn("14:00", safe)

    def test_one_secret_marker_quarantines_neighbouring_auth_replies(self):
        rows = [
            {"scope": "a", "at": 0, "text": "/connect_telegram"},
            {"scope": "a", "at": 10, "text": "12345"},
            {"scope": "b", "at": 10, "text": "14:00"},
        ]
        self.assertEqual(MODULE.quarantined_indices(rows), {0, 1})

    def test_negative_command_is_not_a_creation_request(self):
        self.assertNotIn("event.create", MODULE.suggest_labels("Не создавай встречу завтра"))

    def test_compound_operation_retains_both_classes(self):
        labels = MODULE.suggest_labels("Создай встречу завтра и пригласи @synthetic_user")
        self.assertIn("event.create", labels)
        self.assertIn("invitation.send", labels)

    def test_bot_action_is_not_user_intent_gold(self):
        result = MODULE.candidate_record("Покажи расписание", ["delete_event"], b"synthetic-key")
        self.assertEqual(result["gold"], None)
        self.assertFalse(result["train_eligible"])
        self.assertEqual(result["observed_tools"], ["delete_event"])
        self.assertNotIn("event.delete", result["intent_candidates"])

    def test_calendar_literals_survive_redaction(self):
        text = "Встреча 2026-09-29 в 14:00"
        safe = MODULE.redact_candidate(text, b"key", {})
        self.assertIn("2026-09-29", safe)
        self.assertIn("14:00", safe)

    def test_hyphenated_day_month_year_dates_survive_redaction(self):
        # The production bot itself parses DD-MM(-YYYY) as a calendar date
        # (src/bot/handlers/group-message-filter.ts NUMERIC_DATE_CANDIDATE_RE);
        # the NUMBER-redaction rule must not destroy it as a fake phone number.
        safe = MODULE.redact_candidate("Встреча 29-09-2026 в 14:00", b"key", {})
        self.assertIn("29-09-2026", safe)
        safe_short = MODULE.redact_candidate("Событие 5-3-2026 утром", b"key", {})
        self.assertIn("5-3-2026", safe_short)

    def test_invalid_month_hyphenated_digit_run_is_still_redacted(self):
        safe = MODULE.redact_candidate("код 12-34-56-78", b"key", {})
        self.assertNotIn("12-34-56-78", safe)

    def test_debug_history_is_not_mistaken_for_new_messages(self):
        text = (
            "[2026-09-28T10:00:00Z]\nCHAT: 12 | USER: uid:34\nSUPPLEMENT: false\nMESSAGE: создай встречу\n"
            + "=" * 50
            + "\nHISTORY: old message\nTOOL CALL: create_event\nTOOL RESULT: create_event → OK\nResponse (6 chars):\nГотово\n"
            + "=" * 50
            + "\n"
        )
        rows = MODULE.parse_debug_runs(text)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["content"], "создай встречу")
        self.assertEqual(rows[0]["tools"], ["create_event"])
        self.assertEqual(
            MODULE.parse_debug_runs(text.replace("SUPPLEMENT: false", "SUPPLEMENT: true")), []
        )

    def test_pseudonyms_are_stable_only_with_the_same_key(self):
        one = MODULE.pseudonym("Person", b"key", "PERSON")
        self.assertEqual(one, MODULE.pseudonym("person", b"key", "PERSON"))
        self.assertNotEqual(one, MODULE.pseudonym("Person", b"other", "PERSON"))

    def test_tool_names_are_separate_from_validated_outcomes(self):
        text = '[{"type":"function","function":{"name":"send_invitation","arguments":"{}"}}]'
        self.assertEqual(MODULE.observed_tools(text), ["send_invitation"])
        record = MODULE.candidate_record("Кто приглашён?", MODULE.observed_tools(text), b"key")
        self.assertEqual(record["outcome_status"], "not_inferred_from_prose")
        self.assertFalse(record["train_eligible"])

    def test_inability_complaint_is_not_mistaken_for_the_action_it_names(self):
        self.assertEqual(MODULE.suggest_labels("Не могу создать событие, помоги"), ["feedback"])

    def test_unknown_label_is_the_explicit_fallback_for_unmatched_text(self):
        self.assertEqual(MODULE.suggest_labels("лорем ипсум долор сит амет"), ["unknown"])
