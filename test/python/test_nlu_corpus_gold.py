"""Gold import: validate_gold_record and apply_gold_import."""

import hashlib
import unittest

from nlu_corpus_support import MODULE


class NluCorpusTests(unittest.TestCase):
    def _digest(self, label):
        return hashlib.sha256(label.encode()).hexdigest()

    def _gold_record(self, source_ref, corpus_label, statuses=None):
        statuses = statuses or {}
        reviews = {
            dimension: {
                "reviewer_id": f"reviewer-{dimension}",
                "status": statuses.get(dimension, "approved"),
            }
            for dimension in MODULE.GOLD_REVIEW_DIMENSIONS
        }
        return {
            "source_ref": source_ref,
            "corpus_candidate_sha256": self._digest(corpus_label),
            "intent": "event.create",
            "slots": {"when": "завтра"},
            "expected_outcome": "event_created",
            "reviews": reviews,
        }

    def test_validate_gold_record_requires_all_fields(self):
        with self.assertRaises(ValueError):
            MODULE.validate_gold_record({"source_ref": "x"})

    def test_validate_gold_record_rejects_a_non_hex_corpus_digest(self):
        record = self._gold_record("ref-1", "sha-1")
        record["corpus_candidate_sha256"] = "not-a-real-sha256"
        with self.assertRaises(ValueError):
            MODULE.validate_gold_record(record)

    def test_validate_gold_record_rejects_a_missing_intent(self):
        record = self._gold_record("ref-1", "sha-1")
        record["intent"] = None
        with self.assertRaises(ValueError):
            MODULE.validate_gold_record(record)

    def test_validate_gold_record_rejects_slots_that_are_not_a_mapping(self):
        record = self._gold_record("ref-1", "sha-1")
        record["slots"] = []
        with self.assertRaises(ValueError):
            MODULE.validate_gold_record(record)

    def test_validate_gold_record_rejects_a_non_string_expected_outcome(self):
        record = self._gold_record("ref-1", "sha-1")
        record["expected_outcome"] = 7
        with self.assertRaises(ValueError):
            MODULE.validate_gold_record(record)

    def test_validate_gold_record_requires_every_independent_review_dimension(self):
        record = self._gold_record("ref-1", "sha-1")
        del record["reviews"]["slots"]
        with self.assertRaises(ValueError):
            MODULE.validate_gold_record(record)

    def test_validate_gold_record_rejects_an_unknown_review_status(self):
        record = self._gold_record("ref-1", "sha-1", statuses={"privacy": "maybe"})
        with self.assertRaises(ValueError):
            MODULE.validate_gold_record(record)

    def test_validate_gold_record_rejects_a_review_with_no_reviewer_identity(self):
        record = self._gold_record("ref-1", "sha-1")
        record["reviews"]["intent"]["reviewer_id"] = ""
        with self.assertRaises(ValueError):
            MODULE.validate_gold_record(record)

    def test_validate_gold_record_rejects_a_non_string_slot_value(self):
        record = self._gold_record("ref-1", "sha-1")
        record["slots"] = {"when": 7}
        with self.assertRaises(ValueError):
            MODULE.validate_gold_record(record)

    def test_validate_gold_record_rejects_a_non_string_slot_key(self):
        record = self._gold_record("ref-1", "sha-1")
        record["slots"] = {7: "завтра"}
        with self.assertRaises(ValueError):
            MODULE.validate_gold_record(record)

    def test_validate_gold_record_rejects_a_compound_multi_intent_string_as_unsupported(self):
        record = self._gold_record("ref-1", "sha-1")
        record["intent"] = "event.create,invitation.send"
        with self.assertRaises(ValueError):
            MODULE.validate_gold_record(record)

    def test_apply_gold_import_requires_every_dimension_approved_before_train_eligible(self):
        candidate = MODULE.candidate_record("Создай встречу", ["create_event"], b"key")
        candidate["source_ref"] = "ref-1"
        gold = [self._gold_record("ref-1", "sha-1")]
        updated, report = MODULE.apply_gold_import([candidate], gold, self._digest("sha-1"))
        self.assertEqual(updated[0]["gold"]["intent"], "event.create")
        self.assertTrue(updated[0]["train_eligible"])
        self.assertEqual(report["gold_fully_approved"], 1)

    def test_apply_gold_import_withholds_train_eligible_when_a_single_dimension_is_not_approved(
        self,
    ):
        candidate = MODULE.candidate_record("Создай встречу", [], b"key")
        candidate["source_ref"] = "ref-2"
        gold = [
            self._gold_record("ref-2", "sha-1", statuses={"expected_outcome": "needs_more_info"})
        ]
        updated, _report = MODULE.apply_gold_import([candidate], gold, self._digest("sha-1"))
        self.assertFalse(updated[0]["train_eligible"])
        self.assertEqual(updated[0]["label_status"], "gold_partial_or_rejected")
        self.assertIsNone(
            updated[0]["gold"], "a non-approved adjudication must never populate the gold field"
        )
        self.assertEqual(updated[0]["gold_adjudication"]["expected_outcome"], "event_created")

    def test_apply_gold_import_counts_an_unknown_source_ref_without_crashing(self):
        candidate = MODULE.candidate_record("x", [], b"key")
        candidate["source_ref"] = "ref-3"
        gold = [self._gold_record("missing", "sha-1")]
        updated, report = MODULE.apply_gold_import([candidate], gold, self._digest("sha-1"))
        self.assertIsNone(updated[0]["gold"])
        self.assertEqual(report["gold_rejected_unknown_source"], 1)

    def test_apply_gold_import_rejects_gold_bound_to_a_different_corpus_snapshot(self):
        candidate = MODULE.candidate_record("x", [], b"key")
        candidate["source_ref"] = "ref-4"
        gold = [self._gold_record("ref-4", "stale-sha")]
        updated, report = MODULE.apply_gold_import([candidate], gold, self._digest("current-sha"))
        self.assertIsNone(updated[0]["gold"])
        self.assertEqual(report["gold_rejected_corpus_mismatch"], 1)

    def test_apply_gold_import_hard_rejects_train_eligible_for_a_privacy_quarantined_candidate_even_when_all_reviews_are_approved(
        self,
    ):
        candidate = MODULE.candidate_record("пароль от телеграм 12345", ["create_event"], b"key")
        candidate["source_ref"] = "ref-quarantine"
        self.assertEqual(candidate["text_candidate"], "[QUARANTINED_AUTH]")
        self.assertEqual(candidate["privacy_status"], "quarantined")
        gold = [self._gold_record("ref-quarantine", "sha-1")]
        updated, report = MODULE.apply_gold_import([candidate], gold, self._digest("sha-1"))
        self.assertFalse(
            updated[0]["train_eligible"],
            "a caller-supplied approval must never override a source privacy quarantine",
        )
        self.assertIsNone(updated[0]["gold"])
        self.assertEqual(report["gold_rejected_source_quarantined"], 1)

    def test_apply_gold_import_hard_rejects_a_quarantined_text_candidate_even_if_privacy_status_was_overwritten(
        self,
    ):
        candidate = MODULE.candidate_record("x", [], b"key")
        candidate["source_ref"] = "ref-quarantine-2"
        candidate["text_candidate"] = (
            "[QUARANTINED_AUTH]"  # simulates any other path that could set the marker text directly
        )
        candidate["privacy_status"] = (
            "pseudonymized_candidate_needs_review"  # a caller/reviewer field must not be trusted to clear a source quarantine
        )
        gold = [self._gold_record("ref-quarantine-2", "sha-1")]
        updated, report = MODULE.apply_gold_import([candidate], gold, self._digest("sha-1"))
        self.assertFalse(updated[0]["train_eligible"])
        self.assertEqual(report["gold_rejected_source_quarantined"], 1)

    def test_apply_gold_import_separates_fully_approved_from_partial_counts(self):
        approved = MODULE.candidate_record("Создай встречу", ["create_event"], b"key")
        approved["source_ref"] = "ref-approved"
        partial = MODULE.candidate_record("Другое", [], b"key")
        partial["source_ref"] = "ref-partial"
        gold = [
            self._gold_record("ref-approved", "sha-1"),
            self._gold_record("ref-partial", "sha-1", statuses={"slots": "needs_more_info"}),
        ]
        _updated, report = MODULE.apply_gold_import(
            [approved, partial], gold, self._digest("sha-1")
        )
        self.assertEqual(report["gold_fully_approved"], 1)
        self.assertEqual(report["gold_partial_or_rejected_recorded"], 1)
        self.assertNotIn(
            "gold_applied",
            report,
            "a single combined counter would overstate validated, train-eligible gold",
        )
