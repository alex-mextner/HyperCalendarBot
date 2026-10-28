"""The raw-export row shape and `raw_export`: the only rows selected.private.json may hold."""

from __future__ import annotations

from nlu_corpus_redaction import quarantined_indices, redact_candidate
from nlu_corpus_rows import _is_id, _is_name, _is_tool_result, place_rows

# Free text a raw-export row carries, with its shape; each value goes through redact_candidate.
# `content` is required.
EXPORT_TEXT_FIELDS = {
    "content": lambda value: isinstance(value, str),
    "response": lambda value: value is None or isinstance(value, str),
}
# The identifiers, times and structure a later --merge needs, each with the only shape collect() and
# load_merge_archive() give it. Any other field is dropped from the raw export.
EXPORT_STRUCTURE_FIELDS = {
    "id": _is_id,
    "user_id": _is_id,
    "chat_id": lambda value: value is None or _is_id(value),
    "role": _is_name,
    "created_at": lambda value: isinstance(value, str),
    "record_kind": lambda value: value == "debug_run",
    "partial": lambda value: isinstance(value, bool),
    "tools": lambda value: isinstance(value, list) and all(_is_name(name) for name in value),
    "tool_results": lambda value: (
        isinstance(value, list) and all(_is_tool_result(result) for result in value)
    ),
    "source_refs": lambda value: (
        isinstance(value, list) and all(isinstance(ref, str) for ref in value)
    ),
}

EXPORT_FIELDS = EXPORT_TEXT_FIELDS | EXPORT_STRUCTURE_FIELDS


def _has_export_shape(row: dict) -> bool:
    return "content" in row and all(
        check(row[field]) for field, check in EXPORT_FIELDS.items() if field in row
    )


def _export_safe_row(row: dict, key: bytes, lexicon: dict[str, str]) -> dict:
    """The structure fields of a row with the export shape, and its free text redacted like candidate text."""
    safe = {field: row[field] for field in EXPORT_STRUCTURE_FIELDS if field in row}
    for field in EXPORT_TEXT_FIELDS:
        if isinstance(row.get(field), str):
            safe[field] = redact_candidate(row[field], key, lexicon)
        elif field in row:
            safe[field] = None
    return safe


def raw_export(
    rows: list[dict], key: bytes, lexicon: dict[str, str]
) -> tuple[list[dict], dict[str, int]]:
    """The rows selected.private.json may hold, and how many were kept out (GH-721).

    Backups taken before the #617 fix still hold connect-wizard input (GH-519), so no row of the
    auth-quarantine window is exported, from any source. Every kept row's free text is redacted like
    candidate text. A row that cannot be placed in time or does not have the shape collect() gives
    it is left out: fail closed.
    """
    placed, unplaced = place_rows(rows)
    blocked = quarantined_indices(placed)
    exported = []
    misshapen = 0
    for index, row in enumerate(placed):
        if index in blocked:
            continue
        if not _has_export_shape(row):
            misshapen += 1
            continue
        exported.append(_export_safe_row(row, key, lexicon))
    return exported, {
        "raw_export_quarantined_rows": len(blocked),
        "raw_export_omitted_rows": unplaced + misshapen,
    }
