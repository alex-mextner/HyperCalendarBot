"""Offline NLU inventory and candidate labels. Not gold or an anonymity guarantee.

No network/model calls. Candidate rows stay private until independent intent,
slot, outcome and privacy adjudication. Tool calls describe observed bot actions,
not the user's correct intent. Only aggregate counts are suitable for publication.

SCHEMA_VERSION history (embedded in every candidate record and in
selected.private.json/summary.json so --merge can refuse an incompatible snapshot):
  1 (2026-09-28 08:56 UTC) - initial candidate/summary shape.
  2 (2026-09-28, this change) - binds source_refs to a content-hash-qualified
    lineage id so audit() never stitches an assistant/tool row onto a user
    candidate from a different or unrecorded snapshot; requires --merge inputs
    to declare a matching schema_version instead of silently combining an
    incompatible shape; adds the independent gold-import schema
    (GOLD_REQUIRED_FIELDS/validate_gold_record/apply_gold_import), which only
    ever imports externally adjudicated labels and never manufactures gold or
    infers an outcome from prior bot prose.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import gzip
import hashlib
import json
import os
import re
import sqlite3
import stat
import sys
import tempfile
from pathlib import Path

# The corpus tool is split by responsibility into the nlu_corpus_*.py modules next to this file. Tests
# load this file by path (importlib) and operators run it as a script, neither with scripts/ on
# sys.path, so the siblings are made importable first. Every name the tool defined before the split
# stays reachable here (see __all__); the byte bounds below stay in this module because collect()
# reads them as module globals.
sys.path.append(str(Path(__file__).resolve().parent))

from nlu_corpus_audit import AUDIT_LIMITATIONS, _AuditPass, _OpenRequest, audit
from nlu_corpus_candidates import (
    COMMANDS,
    RULES,
    SCHEMA_VERSION,
    CandidateRecord,
    candidate_record,
    suggest_labels,
)
from nlu_corpus_export import (
    EXPORT_FIELDS,
    EXPORT_STRUCTURE_FIELDS,
    EXPORT_TEXT_FIELDS,
    _export_safe_row,
    _has_export_shape,
    raw_export,
)
from nlu_corpus_gold import (
    GOLD_IMPORT_COUNTERS,
    GOLD_REQUIRED_FIELDS,
    GOLD_REVIEW_DIMENSIONS,
    GOLD_REVIEW_STATUSES,
    SINGLE_INTENT_RE,
    GoldLabel,
    GoldRecordTypeError,
    GoldReview,
    _bind_gold,
    _import_gold_record,
    _is_non_empty_str,
    _is_quarantined_candidate,
    _reject_quarantined_source,
    _validate_gold_intent,
    _validate_gold_review,
    _validate_gold_reviews,
    _validate_gold_slots,
    apply_gold_import,
    validate_gold_record,
)
from nlu_corpus_redaction import (
    AUTH,
    CONNECT_WIZARD_REDACTION,
    QUARANTINED_AUTH_MARKER,
    SESSION_GAP_SECONDS,
    _copies_of_quarantined_user_text,
    _is_auth_marker,
    _late_answers,
    _looks_like_calendar_date,
    _near_auth_markers,
    opens_auth_window,
    pseudonym,
    quarantined_indices,
    redact_candidate,
)
from nlu_corpus_rows import (
    NAME_RE,
    _is_id,
    _is_name,
    _is_tool_result,
    _tool_call_names,
    observed_tools,
    place_rows,
    row_key,
    user_text,
)

__all__ = [
    "AUDIT_LIMITATIONS",
    "AUTH",
    "CHAT_HISTORY_REQUIRED_COLUMNS",
    "COMMANDS",
    "CONNECT_WIZARD_REDACTION",
    "EXPORT_FIELDS",
    "EXPORT_STRUCTURE_FIELDS",
    "EXPORT_TEXT_FIELDS",
    "GOLD_IMPORT_COUNTERS",
    "GOLD_REQUIRED_FIELDS",
    "GOLD_REVIEW_DIMENSIONS",
    "GOLD_REVIEW_STATUSES",
    "LEXICON_SOURCES",
    "MAX_DATABASE_BYTES",
    "MAX_LOG_BYTES",
    "NAME_RE",
    "QUARANTINED_AUTH_MARKER",
    "RULES",
    "SCHEMA_VERSION",
    "SESSION_GAP_SECONDS",
    "SINGLE_INTENT_RE",
    "CandidateRecord",
    "GoldLabel",
    "GoldRecordTypeError",
    "GoldReview",
    "_AuditPass",
    "_OpenRequest",
    "_bind_gold",
    "_collect_database",
    "_collect_log",
    "_copies_of_quarantined_user_text",
    "_database_lexicon",
    "_database_paths",
    "_export_safe_row",
    "_has_export_shape",
    "_import_gold_record",
    "_is_auth_marker",
    "_is_gzip_source",
    "_is_id",
    "_is_name",
    "_is_non_empty_str",
    "_is_quarantined_candidate",
    "_is_tool_result",
    "_is_wal_sidecar",
    "_late_answers",
    "_log_paths",
    "_looks_like_calendar_date",
    "_merge_database_rows",
    "_near_auth_markers",
    "_read_gzipped_database",
    "_read_log_bytes",
    "_read_plain_database",
    "_read_sqlite_source",
    "_reject_quarantined_source",
    "_restricted_stream",
    "_table_columns",
    "_tool_call_names",
    "_validate_gold_intent",
    "_validate_gold_review",
    "_validate_gold_reviews",
    "_validate_gold_slots",
    "apply_gold_import",
    "audit",
    "candidate_record",
    "collect",
    "is_safe_source_file",
    "load_merge_archive",
    "main",
    "observed_tools",
    "open_regular_bounded",
    "opens_auth_window",
    "parse_debug_runs",
    "place_rows",
    "private_bytes",
    "private_json",
    "pseudonym",
    "quarantined_indices",
    "raw_export",
    "read_bounded_merge_archive",
    "read_database",
    "redact_candidate",
    "row_key",
    "suggest_labels",
    "user_text",
    "validate_gold_record",
]


MAX_DATABASE_BYTES = (
    512 * 1024 * 1024
)  # single bound enforced at both fstat-open time and while streaming a gz's decompressed bytes
MAX_LOG_BYTES = 64 * 1024 * 1024  # same, for debug logs and --merge archives


def parse_debug_runs(text: str) -> list[dict]:
    header = re.compile(
        r"^\[([^\n]+)\]\nCHAT: (-?\d+)[^\n]*\| USER: uid:(\d+)[^\n]*\nSUPPLEMENT: (true|false)\nMESSAGE: ",
        re.MULTILINE,
    )
    matches = list(header.finditer(text))
    runs = []
    for index, match in enumerate(matches):
        block = text[
            match.end() : matches[index + 1].start() if index + 1 < len(matches) else len(text)
        ]
        message = re.split(r"\n={40,}|\n## AUTO-RESPONSE", block, maxsplit=1)[0].strip()
        if match[4] == "true":
            continue  # Supplement is not a new user request.
        final = re.search(
            r"^Response \(\d+ chars\):\n([\s\S]*?)(?:\n={40,}|$)", block, re.MULTILINE
        )
        runs.append(
            {
                "user_id": int(match[3]),
                "chat_id": int(match[2]),
                "created_at": match[1],
                "role": "user",
                "content": message,
                "record_kind": "debug_run",
                "tools": re.findall(r"^TOOL CALL: ([a-z_]+)$", block, re.MULTILINE),
                "tool_results": re.findall(
                    r"^TOOL RESULT: ([a-z_]+) → (OK|ERROR)$", block, re.MULTILINE
                ),
                "response": final[1].strip() if final else None,
                "partial": True,
                "auth_context": opens_auth_window(block),
            }
        )  # the logged history may hold a wizard prompt the message answered
    return runs


# (table, column, lexicon kind): known names that must never survive redaction.
LEXICON_SOURCES = (
    ("users", "first_name", "PERSON"),
    ("contacts", "name", "PERSON"),
    ("contacts", "preferred_name", "PERSON"),
    ("events", "location", "PLACE"),
)
CHAT_HISTORY_REQUIRED_COLUMNS = {"id", "user_id", "role", "content", "created_at"}


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def _database_lexicon(conn: sqlite3.Connection) -> dict[str, str]:
    lexicon = {}
    for table, column, kind in LEXICON_SOURCES:
        if column not in _table_columns(conn, table):
            continue
        for row in conn.execute(
            f"SELECT DISTINCT {column} FROM {table} WHERE {column} IS NOT NULL"
        ):
            if isinstance(row[0], str) and len(row[0].strip()) >= 2:
                lexicon[row[0]] = kind
    return lexicon


def read_database(path: Path) -> tuple[list[dict], dict[str, str]]:
    conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    conn.execute("BEGIN")
    try:
        cols = _table_columns(conn, "chat_history")
        if not CHAT_HISTORY_REQUIRED_COLUMNS <= cols:
            return [], {}
        chat = "chat_id" if "chat_id" in cols else "NULL AS chat_id"
        rows = [
            dict(row)
            for row in conn.execute(
                "SELECT id,user_id,role,content,created_at,"
                + chat
                + " FROM chat_history ORDER BY id"
            )
        ]
        return rows, _database_lexicon(conn)
    finally:
        conn.rollback()
        conn.close()


def is_safe_source_file(path: Path, root: Path) -> bool:
    """Fast, best-effort pre-filter used only to produce an accurate
    'skipped_unsafe_path' inventory entry before an attempt to open. This is
    NOT the security boundary: it is a plain path-based check-then-open by
    itself would be racy (the path could be swapped to a symlink afterward).
    The actual guarantee against that race is `open_regular_bounded`'s
    O_NOFOLLOW open plus an fstat check on the already-open descriptor.
    """
    try:
        if path.is_symlink() or not path.is_file():
            return False
        resolved = path.resolve()
        root_resolved = root.resolve()
        return resolved == root_resolved or root_resolved in resolved.parents
    except OSError:
        return False


def open_regular_bounded(path: Path, max_bytes: int) -> int:
    """Open a file descriptor that cannot be a symlink and cannot exceed a
    byte bound, without a window between checking and opening. `O_NOFOLLOW`
    makes the kernel refuse the open outright if the final path component is
    (or has become, since any earlier plain-path check) a symlink; `fstat` on
    the resulting descriptor -- not a fresh path lookup -- is what confirms
    it is a bounded regular file, so nothing can be swapped in between.
    Caller owns the returned fd and must close it.
    """
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("not_a_regular_file")
        if info.st_size > max_bytes:
            raise ValueError("oversized_source")
        return fd
    except BaseException:
        os.close(fd)
        raise


def _is_gzip_source(path: Path) -> bool:
    return path.suffix == ".gz"


def _is_wal_sidecar(path: Path) -> bool:
    """A `-wal`/`-shm`/`-journal` companion is never its own SQLite database
    (see "Input bounds" in docs/reference/nlu-corpus-methodology.md)."""
    return path.name.endswith(("-wal", "-shm", "-journal"))


def _database_paths(root: Path) -> list[Path]:
    data = root / "data"
    return sorted(
        path
        for path in (
            set(data.glob("*.db"))
            | set(data.glob("*.db.pre-*"))
            | set((data / "backups").glob("*.db"))
            | set((data / "backups").glob("*.db.gz"))
        )
        if not _is_wal_sidecar(path)
    )


def _read_gzipped_database(fd: int) -> tuple[list[dict], dict[str, str]]:
    """Stream the gzip behind `fd` into a temporary database, bounded by MAX_DATABASE_BYTES decompressed, and read it."""
    with os.fdopen(fd, "rb") as raw_stream, tempfile.NamedTemporaryFile(suffix=".db") as temporary:
        opener = gzip.GzipFile(fileobj=raw_stream)
        total = 0
        while chunk := opener.read(1024 * 1024):
            total += len(chunk)
            if total > MAX_DATABASE_BYTES:
                raise ValueError("oversized_database")
            temporary.write(chunk)
        temporary.flush()
        return read_database(Path(temporary.name))


def _read_plain_database(path: Path, fd: int) -> tuple[list[dict], dict[str, str]]:
    # fd already proved (O_NOFOLLOW+fstat) this path was a
    # bounded regular file, not a symlink. SQLite must reopen by
    # path to locate sibling -wal/-shm files, so it can combine
    # committed-but-uncheckpointed WAL rows correctly without a
    # checkpoint/write against a read-only source; this narrows
    # the no-follow guarantee to a standard path-based open, and
    # bounds the -wal/-shm siblings the same way before SQLite
    # reads them. See docs/reference/nlu-corpus-methodology.md
    # ("Input bounds") for the full rationale.
    os.close(fd)
    for sidecar_suffix in ("-wal", "-shm"):
        try:
            sidecar_fd = open_regular_bounded(
                path.with_name(path.name + sidecar_suffix), MAX_DATABASE_BYTES
            )
            os.close(sidecar_fd)
        except FileNotFoundError:
            pass
    return read_database(path)


def _read_sqlite_source(path: Path) -> tuple[list[dict], dict[str, str]]:
    fd = open_regular_bounded(path, MAX_DATABASE_BYTES)
    if _is_gzip_source(path):
        return _read_gzipped_database(fd)
    return _read_plain_database(path, fd)


def _merge_database_rows(rows: dict[str, dict], source: dict, extracted: list[dict]) -> None:
    digests = [row_key(row) for row in extracted]
    logical_sha256 = hashlib.sha256("".join(digests).encode()).hexdigest()
    lineage_ref = f"{source['name']}#{logical_sha256}"  # hash-qualified so two snapshots that share a path never look like one lineage
    for row, digest in zip(extracted, digests):
        rows.setdefault(digest, dict(row, source_refs=[]))["source_refs"].append(lineage_ref)
    source.update(status="read", rows=len(extracted), logical_sha256=logical_sha256)


def _collect_database(
    root: Path, path: Path, rows: dict[str, dict], lexicon: dict[str, str]
) -> dict:
    source = {"kind": "sqlite", "name": str(path.relative_to(root))}
    if not is_safe_source_file(path, root):
        source.update(status="skipped_unsafe_path", rows=0)
        return source
    try:
        extracted, names = _read_sqlite_source(path)
        lexicon.update(names)
        _merge_database_rows(rows, source, extracted)
    except (OSError, sqlite3.Error, ValueError) as error:
        source.update(status="unreadable", error=type(error).__name__)
    return source


def _log_paths(root: Path) -> list[Path]:
    return [
        path
        for path in sorted((root / "logs").rglob("*"))
        if path.is_file() and path.name.endswith((".log", ".log.gz"))
    ]


def _read_log_bytes(path: Path) -> bytes:
    fd = open_regular_bounded(path, MAX_LOG_BYTES)
    with os.fdopen(fd, "rb") as raw_stream:
        stream = gzip.GzipFile(fileobj=raw_stream) if _is_gzip_source(path) else raw_stream
        raw = stream.read(MAX_LOG_BYTES + 1)
    if len(raw) > MAX_LOG_BYTES:
        raise ValueError("oversized_log")
    return raw


def _collect_log(root: Path, path: Path, rows: dict[str, dict]) -> dict:
    source = {"kind": "debug_log", "name": str(path.relative_to(root))}
    if not is_safe_source_file(path, root):
        source.update(status="skipped_unsafe_path", rows=0)
        return source
    try:
        raw = _read_log_bytes(path)
        runs = parse_debug_runs(raw.decode("utf-8", errors="replace"))
        source.update(
            status="read" if runs else "no_direct_dialogues",
            rows=len(runs),
            sha256=hashlib.sha256(raw).hexdigest(),
        )
        for index, row in enumerate(runs):
            key = "log:" + row_key(row)
            rows.setdefault(key, dict(row, source_refs=[]))["source_refs"].append(
                source["name"] + ":" + str(index)
            )
    except (OSError, ValueError, EOFError) as error:
        source.update(status="unreadable", error=type(error).__name__)
    return source


def collect(root: Path) -> tuple[list[dict], list[dict], dict[str, str]]:
    rows: dict[str, dict] = {}
    lexicon: dict[str, str] = {}
    sources = [_collect_database(root, path, rows, lexicon) for path in _database_paths(root)]
    sources.extend(_collect_log(root, path, rows) for path in _log_paths(root))
    return list(rows.values()), sources, lexicon


def _restricted_stream(path: Path, binary: bool):
    """Create-with-mode in one syscall: never a window where the file has wider-than-owner bits."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    return os.fdopen(fd, "wb") if binary else os.fdopen(fd, "w", encoding="utf-8")


def private_json(path: Path, value) -> None:
    with _restricted_stream(path, binary=False) as stream:
        json.dump(value, stream, ensure_ascii=False)


def private_bytes(path: Path, value: bytes) -> None:
    with _restricted_stream(path, binary=True) as stream:
        stream.write(value)


def load_merge_archive(
    content, archive_digest: str
) -> tuple[list[dict], list[dict], dict[str, str]]:
    """Load one --merge input. Refuses a shape this run cannot trust to pair correctly.

    A dict archive is a prior selected.private.json: its rows already carry
    content-hash-qualified lineage refs from their own collect() run, so it is only
    checked for a matching SCHEMA_VERSION. A legacy pre-versioning list archive
    predates lineage tracking entirely, so every row is forced to a lineage marker
    unique to this archive AND this row position -- it can never be treated as
    matching anything, including another row from the very same archive.
    """
    if isinstance(content, dict) and "rows" in content:
        version = content.get("schema_version")
        if version != SCHEMA_VERSION:
            raise ValueError(
                f"incompatible merge schema_version {version!r}, expected {SCHEMA_VERSION}"
            )
        return (
            list(content["rows"]),
            list(content.get("sources", [])),
            dict(content.get("lexicon", {})),
        )
    if isinstance(content, list) and all(isinstance(row, dict) and "row" in row for row in content):
        rows = []
        for position, entry in enumerate(content):
            names = entry.get("sources") or ["unknown"]
            refs = [f"legacy:{archive_digest}:row{position}:{name}" for name in names]
            rows.append(dict(entry["row"], source_refs=refs))
        return rows, [], {}
    raise ValueError("Unsupported archive schema")


def read_bounded_merge_archive(path: Path, max_bytes: int = MAX_DATABASE_BYTES) -> bytes:
    """Read one --merge input under the same O_NOFOLLOW+fstat guard collect() uses.

    The read itself, not just the open-time fstat, is bounded: fstat only
    reflects the file's size at open time, so a file that grows afterward
    (still the same inode, same fd) must not be allowed to make this read
    unbounded.
    """
    fd = open_regular_bounded(path, max_bytes)
    with os.fdopen(fd, "rb") as stream:
        raw = stream.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise ValueError("merge_archive_oversized")
    return raw


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--merge", type=Path, action="append", default=[])
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False, mode=0o700)
    key = os.urandom(32)
    private_bytes(args.out / "pseudonym.key", key)
    rows, sources, lexicon = collect(args.root)
    for path in args.merge:
        raw_bytes = read_bounded_merge_archive(path)
        content = json.loads(raw_bytes)
        archive_digest = hashlib.sha256(raw_bytes).hexdigest()
        merged_rows, merged_sources, merged_lexicon = load_merge_archive(content, archive_digest)
        rows.extend(merged_rows)
        lexicon.update(merged_lexicon)
        if isinstance(content, dict):
            sources.extend(merged_sources)
        else:
            sources.append(
                {
                    "kind": "retained_archive",
                    "name": path.name,
                    "rows": len(content),
                    "status": "read",
                    "sha256": archive_digest,
                }
            )
    distinct = {}
    for row in rows:
        identity = row.get("record_kind", "database") + ":" + row_key(row)
        if identity in distinct:
            distinct[identity]["source_refs"] = list(
                dict.fromkeys(
                    distinct[identity].get("source_refs", []) + row.get("source_refs", [])
                )
            )
        else:
            distinct[identity] = row
    rows = list(distinct.values())
    exported, export_counts = raw_export(rows, key, lexicon)
    private_json(
        args.out / "selected.private.json",
        {
            "rows": exported,
            "sources": sources,
            "lexicon": lexicon,
            "schema_version": SCHEMA_VERSION,
        },
    )
    candidates, summary = audit(rows, key, lexicon)
    private_json(args.out / "candidates.private.json", candidates)
    summary.update(
        export_counts,
        schema_version=SCHEMA_VERSION,
        captured_at=dt.datetime.now(dt.timezone.utc).isoformat(),
        source_count=len(sources),
    )
    summary["source_states"] = dict(collections.Counter(source["status"] for source in sources))
    summary["source_kinds"] = dict(collections.Counter(source["kind"] for source in sources))
    summary["candidate_sha256"] = hashlib.sha256(
        (args.out / "candidates.private.json").read_bytes()
    ).hexdigest()
    private_json(args.out / "summary.json", summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
