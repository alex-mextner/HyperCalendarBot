"""The audit pass: turns placed rows into candidate records and the publishable aggregate summary."""

from __future__ import annotations

import collections
from typing import NamedTuple

from nlu_corpus_candidates import CandidateRecord, candidate_record
from nlu_corpus_redaction import (
    SESSION_GAP_SECONDS,
    pseudonym,
    quarantined_indices,
    redact_candidate,
)
from nlu_corpus_rows import observed_tools, place_rows, row_key, user_text

AUDIT_LIMITATIONS = (
    "Candidate labels are unvalidated hypotheses, not accuracy or gold.",
    "Privacy transformation is pseudonymization; every free-text record still needs review.",
    "Database and debug user records may overlap; source counts are not unique Telegram updates.",
    "Historical permissions, entity state and timezone are not reconstructed.",
    "Auth-window quarantine is conservative and not a substitute for fixing the ingress logging issue.",
    "Assistant/tool rows attach to a candidate only when they share a recorded source-file lineage with the triggering request and arrive within 1800s of that exact request (not a chained series of short gaps); everything else is counted separately instead of being stitched across snapshots or stale windows.",
)


class _OpenRequest(NamedTuple):
    """The user candidate a conversation is still collecting assistant/tool rows for."""

    candidate: CandidateRecord
    lineage: frozenset[str]
    since: float  # anchored to this exact request, never pushed forward by later non-user rows


class _AuditPass:
    """One chronological walk over the placed rows: user rows become candidates, later assistant/tool rows
    of the same conversation attach as evidence, and everything that must not attach is counted instead."""

    def __init__(self, key: bytes, lexicon: dict[str, str], blocked: set[int]) -> None:
        self.key = key
        self.lexicon = lexicon
        self.blocked = blocked
        self.candidates: list[CandidateRecord] = []
        self.open_requests: dict[str, _OpenRequest] = {}
        self.sessions: dict[str, str] = {}
        self.turn_times: dict[str, float] = {}
        self.detached_unknown_provenance = 0
        self.detached_stale_session = 0

    def feed(self, index: int, row: dict) -> None:
        scope = row["scope"]
        if row["at"] - self.turn_times.get(scope, float("-inf")) > SESSION_GAP_SECONDS:
            self.sessions[scope] = row_key(row)
            self.open_requests.pop(
                scope, None
            )  # a new session must never inherit a stale open request
        self.turn_times[scope] = row["at"]
        if index in self.blocked:
            self.open_requests.pop(scope, None)
            return
        lineage = frozenset(row.get("source_refs") or [])
        if row["role"] == "user":
            self._add_user_row(scope, row, lineage)
        elif scope in self.open_requests and row.get("record_kind") != "debug_run":
            self._attach_assistant_row(scope, row, lineage)

    def _add_user_row(self, scope: str, row: dict, lineage: frozenset[str]) -> None:
        text, kind = user_text(row["content"])
        candidate = candidate_record(text, row.get("tools", []), self.key, self.lexicon)
        candidate.update(
            source_kind=row.get("record_kind", "database"),
            input_kind=kind,
            source_ref=pseudonym(row_key(row), self.key, "ROW"),
            actor_scope=pseudonym(scope, self.key, "SCOPE"),
            conversation_id=pseudonym(self.sessions[scope], self.key, "CONVERSATION"),
            source_refs=[pseudonym(ref, self.key, "SOURCE") for ref in row.get("source_refs", [])],
            timestamp=row["created_at"],
            historical_state="not_reconstructed",
            observed_responses=[],
        )
        if kind == "button":
            candidate["intent_candidates"] = ["dialogue.answer"]
        self.candidates.append(candidate)
        if row.get("record_kind") != "debug_run":
            self.open_requests[scope] = _OpenRequest(candidate, lineage, row["at"])
        elif row.get("response"):
            candidate["observed_responses"].append(
                redact_candidate(row["response"], self.key, self.lexicon)
            )

    def _attach_assistant_row(self, scope: str, row: dict, lineage: frozenset[str]) -> None:
        request = self.open_requests[scope]
        if row["at"] - request.since > SESSION_GAP_SECONDS:
            self.detached_stale_session += 1
            del self.open_requests[
                scope
            ]  # a chain of short gaps must never bridge past 1800s from the actual triggering request
            return
        if not (request.lineage & lineage):
            self.detached_unknown_provenance += 1  # different or unrecorded snapshot lineage: never stitch it into this candidate's causal turn
            return
        candidate = request.candidate
        candidate["observed_tools"] = list(
            dict.fromkeys(candidate["observed_tools"] + observed_tools(row["content"]))
        )
        candidate["observed_responses"].append(
            {
                "role": row["role"],
                "content_candidate": redact_candidate(row["content"], self.key, self.lexicon),
            }
        )

    def summary(self, retained_rows: int, invalid_timestamp_rows: int) -> dict:
        counts = collections.Counter(
            label for row in self.candidates for label in row["intent_candidates"]
        )
        return {
            "retained_rows": retained_rows,
            "invalid_timestamp_rows": invalid_timestamp_rows,
            "quarantined_auth_rows": len(self.blocked),
            "evidence_detached_unknown_provenance_rows": self.detached_unknown_provenance,
            "evidence_detached_stale_session_rows": self.detached_stale_session,
            "user_candidates": len(self.candidates),
            "candidates_by_source": dict(
                collections.Counter(row["source_kind"] for row in self.candidates)
            ),
            "candidate_label_counts": dict(counts.most_common()),
            "observed_tool_counts": dict(
                collections.Counter(
                    tool for row in self.candidates for tool in row["observed_tools"]
                ).most_common()
            ),
            "gold_count": 0,
            "train_eligible": 0,
            "raw_content_published": False,
            "limitations": list(AUDIT_LIMITATIONS),
        }


def audit(rows: list[dict], key: bytes, lexicon: dict[str, str]) -> tuple[list[dict], dict]:
    normalized, bad_time = place_rows(rows)
    walk = _AuditPass(key, lexicon, quarantined_indices(normalized))
    for index, row in enumerate(normalized):
        walk.feed(index, row)
    return walk.candidates, walk.summary(len(rows), bad_time)
