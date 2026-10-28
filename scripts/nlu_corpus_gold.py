"""Gold import: validation of externally adjudicated labels and their binding onto candidates.

Never manufactures a label; see "Gold import" in docs/reference/nlu-corpus-methodology.md.
"""

from __future__ import annotations

import re
from typing import Literal, TypedDict

from nlu_corpus_redaction import QUARANTINED_AUTH_MARKER

GOLD_REVIEW_DIMENSIONS = ("privacy", "intent", "slots", "expected_outcome")
GOLD_REVIEW_STATUSES = {"approved", "rejected", "needs_more_info"}
GOLD_REQUIRED_FIELDS = {
    "source_ref",
    "corpus_candidate_sha256",
    "intent",
    "slots",
    "expected_outcome",
    "reviews",
}
# One dotted or bare lowercase intent label (e.g. 'event.create'); rejects a
# compound multi-operation intent encoded as one string. See "Gold import"
# in docs/reference/nlu-corpus-methodology.md for the full rationale.
SINGLE_INTENT_RE = re.compile(r"^[a-z][a-z_]*(?:\.[a-z][a-z_]*)?$")


class GoldRecordTypeError(TypeError, ValueError):
    """A gold record field of the wrong type; stays a ValueError for callers that reject bad input."""


class GoldReview(TypedDict):
    reviewer_id: str
    status: Literal["approved", "rejected", "needs_more_info"]


class GoldLabel(TypedDict):
    intent: str
    slots: dict[str, str]
    expected_outcome: str
    reviews: dict[str, GoldReview]  # one independent entry per GOLD_REVIEW_DIMENSIONS


def _is_non_empty_str(value: object) -> bool:
    return isinstance(value, str) and bool(value)


def _validate_gold_intent(intent: object) -> None:
    if not _is_non_empty_str(intent):
        raise ValueError(
            "gold record intent must be a non-empty string, never inferred or left unset"
        )
    if not SINGLE_INTENT_RE.fullmatch(intent):
        raise ValueError(
            f"gold record intent {intent!r} is not a single supported intent label; a compound/multi-operation request must be rejected as unsupported in this bounded scope, never squeezed into one label"
        )


def _validate_gold_slots(slots: object) -> None:
    if not isinstance(slots, dict):
        raise GoldRecordTypeError("gold record slots must be a mapping")
    for slot_key, slot_value in slots.items():
        if not isinstance(slot_key, str) or not isinstance(slot_value, str):
            raise GoldRecordTypeError(
                f"gold record slots must be a str-to-str mapping, got key {slot_key!r} -> value {slot_value!r}"
            )


def _validate_gold_review(dimension: str, review: object) -> None:
    if not isinstance(review, dict) or not _is_non_empty_str(review.get("reviewer_id")):
        raise ValueError(f"gold record {dimension} review needs a non-empty reviewer_id")
    if review.get("status") not in GOLD_REVIEW_STATUSES:
        raise ValueError(
            f"gold record {dimension} review has an unknown status: {review.get('status')!r}"
        )


def _validate_gold_reviews(reviews: object) -> None:
    if not isinstance(reviews, dict):
        raise GoldRecordTypeError("gold record reviews must be a mapping")
    missing_dimensions = set(GOLD_REVIEW_DIMENSIONS) - reviews.keys()
    if missing_dimensions:
        raise ValueError(
            f"gold record missing independent review dimensions: {sorted(missing_dimensions)}"
        )
    for dimension in GOLD_REVIEW_DIMENSIONS:
        _validate_gold_review(dimension, reviews[dimension])


def validate_gold_record(record: dict) -> None:
    """Reject anything but an independently adjudicated, corpus-bound gold row.

    Never called to manufacture a label: this only rejects or accepts a record an
    external reviewer already produced. Each of privacy/intent/slots/expected_outcome
    needs its own reviewer identity and status; a single blanket status is rejected.
    """
    missing = GOLD_REQUIRED_FIELDS - record.keys()
    if missing:
        raise ValueError(f"gold record missing required fields: {sorted(missing)}")
    if not _is_non_empty_str(record.get("source_ref")):
        raise ValueError("gold record source_ref must be a non-empty string")
    corpus_sha256 = record.get("corpus_candidate_sha256")
    if not isinstance(corpus_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", corpus_sha256):
        raise ValueError(
            "gold record corpus_candidate_sha256 must be a 64-character hex sha256 digest"
        )
    _validate_gold_intent(record.get("intent"))
    _validate_gold_slots(record.get("slots"))
    if not _is_non_empty_str(record.get("expected_outcome")):
        raise ValueError(
            "gold record expected_outcome must be a non-empty string, never inferred from bot prose"
        )
    _validate_gold_reviews(record.get("reviews"))


# The apply_gold_import report keys, in report order; each imported record lands in exactly one.
GOLD_IMPORT_COUNTERS = (
    "gold_fully_approved",
    "gold_partial_or_rejected_recorded",
    "gold_rejected_unknown_source",
    "gold_rejected_corpus_mismatch",
    "gold_rejected_source_quarantined",
)


def _is_quarantined_candidate(candidate: dict) -> bool:
    return (
        candidate.get("privacy_status") == "quarantined"
        or candidate.get("text_candidate") == QUARANTINED_AUTH_MARKER
    )


def _reject_quarantined_source(candidate: dict) -> None:
    candidate["label_status"] = "gold_rejected_source_quarantined"
    candidate["gold_adjudication"] = None
    candidate["gold"] = None
    candidate["train_eligible"] = False


def _bind_gold(candidate: dict, record: dict) -> bool:
    """Record the adjudication on the candidate; True when every review dimension is approved."""
    all_approved = all(
        record["reviews"][dimension]["status"] == "approved" for dimension in GOLD_REVIEW_DIMENSIONS
    )
    adjudication = {
        "intent": record["intent"],
        "slots": record["slots"],
        "expected_outcome": record["expected_outcome"],
        "reviews": record["reviews"],
    }
    candidate["gold_adjudication"] = adjudication
    candidate["gold"] = adjudication if all_approved else None
    candidate["label_status"] = "gold_approved" if all_approved else "gold_partial_or_rejected"
    candidate["train_eligible"] = all_approved
    return all_approved


def _import_gold_record(by_ref: dict, record: dict, expected_corpus_sha256: str) -> str:
    """Apply one validated gold record and name the GOLD_IMPORT_COUNTERS entry it counts under."""
    if record["corpus_candidate_sha256"] != expected_corpus_sha256:
        return "gold_rejected_corpus_mismatch"
    candidate = by_ref.get(record["source_ref"])
    if candidate is None:
        return "gold_rejected_unknown_source"
    if _is_quarantined_candidate(candidate):
        _reject_quarantined_source(candidate)
        return "gold_rejected_source_quarantined"
    return (
        "gold_fully_approved"
        if _bind_gold(candidate, record)
        else "gold_partial_or_rejected_recorded"
    )


def apply_gold_import(
    candidates: list[dict], gold_records: list[dict], expected_corpus_sha256: str
) -> tuple[list[dict], dict]:
    """Bind independently adjudicated gold onto matching candidates. Never fabricates a label.

    train_eligible only becomes true when every one of the four independent review
    dimensions is individually approved; a partial approval or a corpus-hash mismatch
    leaves the candidate as-is except for a bookkeeping label_status. A candidate the
    corpus itself already quarantined (privacy_status=='quarantined' or a redacted
    text_candidate) is a hard privacy gate: a caller-supplied approval is an external
    assertion about the record's content, not proof this script re-adjudicated the
    quarantine, so it can never override it.
    """
    by_ref = {candidate.get("source_ref"): candidate for candidate in candidates}
    report = dict.fromkeys(GOLD_IMPORT_COUNTERS, 0)
    for record in gold_records:
        validate_gold_record(record)
        report[_import_gold_record(by_ref, record, expected_corpus_sha256)] += 1
    return candidates, report
