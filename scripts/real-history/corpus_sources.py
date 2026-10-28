"""Corpus inputs: the fixed paths, vocabulary, secret and mapping files, the source databases and chat logs, and the
raw rows read from them. Everything here only reads the odroid-local inputs; nothing is written except the 0600
mapping and source index under PRIVATE."""

from __future__ import annotations

import collections
import gzip
import hashlib
import json
import os
import re
import secrets
import shutil
import sqlite3
import tempfile
from collections.abc import Iterator
from dataclasses import dataclass

import scrub as scrub_module
from scrub import norm

DATA = "/opt/hypercal/data"
DB_PATH = f"{DATA}/calendar.db"
AUDIT = f"{DATA}/private-audit"
CHAT_LOG_ROOTS = [
    "/opt/hypercal/logs/chats",
    "/mnt/wd500/home-offload/backups/do-ams3-20261009/fs/opt/hypercal/logs/chats",
]
BACKUPS = f"{DATA}/intent-basis-backups"
STRESS = f"{DATA}/dictionaries/stress-dict.json"
HUNSPELL = "/tmp/real-history-inputs/ru_RU.dic"
ENGLISH = "/tmp/real-history-inputs/american-english"
ZONES = {
    "UTC": "UTC",
    "Europe/Belgrade": "Europe/Belgrade",
    "America/New_York": "America/New_York",
    "Pacific/Auckland": "Pacific/Auckland",
    "Asia/Kolkata": "Asia/Kolkata",
    "Pacific/Kiritimati": "Pacific/Kiritimati",
}
WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
SENSITIVE_PROMPT = re.compile(
    r"(?i)парол|2fa|двухфактор|код\s+(?:из|подтвержд|от|telegram|тг|смс|sms)|номер\s+телефона|phone\s+number|login\s+code|password|connect|подключ[ие]\w*\s+telegram"
)
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
URL = re.compile(r"(?i)\b(?:https?://|www\.|t\.me/|tg://)[^\s<>\"')\]]+")
HANDLE = re.compile(r"(?<![\w@])@[A-Za-z0-9_]{4,32}\b")
LONG_DIGITS = re.compile(r"(?<![\d.,:-])\d{6,}(?![\d:-])")
PHONEISH = re.compile(r"(?<!\d)(?:\+\d|[78])[\d\s().-]{9,}\d")
QA_PROBE = re.compile(
    r"HCB[_0-9]|synthetic roster check|Проверка (?:скорости ответа|после обновления)"
)
ERROR_RESULT = re.compile(
    r"(?i)^\W*(?:error|ошибк|failed|не удалось|не найден|not found|permission|forbidden|invalid)"
)


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _stress_words() -> set[str]:
    with open(STRESS, encoding="utf-8") as handle:
        return {norm(key) for key in json.load(handle)}


def _english_words() -> set[str]:
    if not os.path.exists(ENGLISH):
        return set()
    with open(ENGLISH, encoding="utf-8") as handle:
        words = (line.strip() for line in handle)
        return {
            word for word in words if word and word.islower() and word.isascii() and "'" not in word
        }


def _spoken_words(path: str) -> set[str]:
    """Lower-case words of the `say` field of a JSONL corpus."""
    words: set[str] = set()
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            found = scrub_module.WORD_RE.findall(str(record.get("say", "")))
            words.update(norm(word) for word in found if not word[:1].isupper())
    return words


def _hunspell_proper() -> set[str]:
    proper: set[str] = set()
    if not os.path.exists(HUNSPELL):
        return proper
    with open(HUNSPELL, encoding="utf-8") as handle:
        next(handle)
        for line in handle:
            word = line.split("/")[0].strip()
            if word[:1].isupper() and not word.isupper() and scrub_module.WORD_RE.fullmatch(word):
                proper.add(norm(word))
    return proper


def load_vocab(extra_jsonl: list[str]) -> tuple[set[str], set[str]]:
    vocab = _stress_words() | _english_words()
    for path in extra_jsonl:
        vocab |= _spoken_words(path)
    return vocab, _hunspell_proper()


def load_secret(private: str) -> tuple[bytes, dict[str, str]]:
    path = os.path.join(private, "mapping.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            stored = json.load(handle)
        return bytes.fromhex(stored["secret"]), dict(stored["mapping"])
    if os.environ.get("REAL_HISTORY_SECRET"):
        return bytes.fromhex(os.environ["REAL_HISTORY_SECRET"]), {}
    return secrets.token_bytes(32), {}


def save_mapping(private: str, secret: bytes, mapping: dict[str, str]) -> None:
    os.makedirs(private, mode=0o700, exist_ok=True)
    path = os.path.join(private, "mapping.json")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(
            {"secret": secret.hex(), "mapping": mapping},
            handle,
            ensure_ascii=False,
            indent=1,
            sort_keys=True,
        )
    os.chmod(path, 0o600)


# ─── sources ────────────────────────────────────────────────────────────────────────────────────────────────────────


SOURCE_CLASSES = (
    # (path fragment, class): the first match wins; only the class is published, never a path.
    ("do-ams3", "droplet_archive"),
    ("apple-disk", "apple_disk"),
    ("/opt/hypercal/data/calendar.db", "prod_db"),
    ("/opt/hypercal/data/backups/", "prod_backup"),
    ("incident-backups", "prod_backup"),
    ("repair-backups", "prod_backup"),
    ("intent-basis-backups", "prod_backup"),
    ("/mnt/wd500", "odroid_archive"),
    ("/mnt/storage", "odroid_archive"),
    ("/mnt/msi-backup-ro", "odroid_archive"),
)


def class_of(path: str) -> str:
    for fragment, name in SOURCE_CLASSES:
        if fragment in path:
            return name
    return "other_db"


class OpenedDb:
    """A source database, read-only; a gzipped one is unpacked to a private temp file that is removed on close."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.temp: str | None = None
        target = path
        if path.endswith(".gz"):
            with tempfile.NamedTemporaryFile(
                prefix="rh-", suffix=".db", dir="/tmp", delete=False
            ) as handle:
                os.chmod(handle.name, 0o600)
                with gzip.open(path, "rb") as source:
                    shutil.copyfileobj(source, handle)
            self.temp = target = handle.name
        self.db = sqlite3.connect(f"file:{target}?mode=ro&immutable=1", uri=True)

    def close(self) -> None:
        self.db.close()
        if self.temp:
            os.unlink(self.temp)

    def rows(self, sql: str) -> list[tuple]:
        try:
            return self.db.execute(sql).fetchall()
        except sqlite3.Error:
            return []


def has_chat_history(path: str) -> tuple[int, str, str] | None:
    try:
        opened = OpenedDb(path)
    except (sqlite3.Error, OSError, EOFError):
        return None
    try:
        tables = {
            row[0] for row in opened.rows("SELECT name FROM sqlite_master WHERE type='table'")
        }
        if "chat_history" not in tables:
            return None
        count, first, last = opened.rows(
            "SELECT COUNT(*), MIN(created_at), MAX(created_at) FROM chat_history"
        )[0]
        return count, first, last
    finally:
        opened.close()


def _is_database_path(path: str) -> bool:
    return (
        path.lower().endswith((".db", ".sqlite", ".sqlite3", ".db.gz", ".sqlite.gz"))
        and "/mypy_cache/" not in path
    )


def _candidate_paths(find_files: list[str]) -> Iterator[str]:
    for listing in find_files:
        with open(listing, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                parts = line.rstrip("\n").split("|", 2)
                if len(parts) == 3 and _is_database_path(parts[2]):
                    yield parts[2]


def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as blob:
        for chunk in iter(lambda: blob.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_sources(private: str, found: list[dict], skipped: collections.Counter) -> None:
    os.makedirs(private, mode=0o700, exist_ok=True)
    out = os.path.join(private, "sources.json")
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(
            {"databases": sorted(found, key=lambda item: item["path"]), "skipped": dict(skipped)},
            handle,
            indent=1,
        )
    os.chmod(out, 0o600)
    print(
        json.dumps(
            {
                "databases": len(found),
                "byClass": collections.Counter(item["class"] for item in found),
                "skipped": dict(skipped),
            }
        )
    )


def scan_sources(find_files: list[str], private: str) -> None:
    """Probe every candidate file of the given `size|date|path` listings; keep one copy of identical files."""
    seen_hash: dict[str, str] = {}
    found: list[dict] = []
    skipped = collections.Counter()
    for path in _candidate_paths(find_files):
        try:
            key = _sha256_file(path)
        except OSError:
            skipped["unreadable"] += 1
            continue
        if key in seen_hash:
            skipped["identical_file"] += 1
            continue
        seen_hash[key] = path
        probe = has_chat_history(path)
        if probe is None:
            skipped["no_chat_history"] += 1
            continue
        found.append(
            {
                "path": path,
                "class": class_of(path),
                "rows": probe[0],
                "first": probe[1] or "",
                "last": probe[2] or "",
                "sha256": key,
            }
        )
    _write_sources(private, found, skipped)


def load_sources(private: str) -> list[dict]:
    path = os.path.join(private, "sources.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as sources_file:
            listed = json.load(sources_file)["databases"]
    else:
        listed = []
    known = {item["path"] for item in listed}
    if DB_PATH not in known:
        listed.insert(
            0,
            {"path": DB_PATH, "class": "prod_db", "rows": 0, "first": "", "last": "", "sha256": ""},
        )
    return listed


CHAT_HEADER = re.compile(
    r'^CHAT: (-?\d+)(?: "([^"]*)")? \| (?:[A-Za-z]+): (?:[A-Za-z]+):(\d+)(?: @(\S+))?(?: (.*))?$'
)
GROUP_PREFIX = re.compile(r"^\[Group: ([^\],]*), From: ([^\],]*), user_id:(\d+)\]\s*")
STAMP = re.compile(r"^\[(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})")


def chat_log_files(roots: list[str]) -> list[str]:
    files: list[str] = []
    for root in roots:
        if os.path.isdir(root):
            for directory, _, names in os.walk(root):
                files.extend(
                    os.path.join(directory, name) for name in names if name.endswith(".log")
                )
    return sorted(files)


@dataclass
class _LogState:
    """Where the reader of one chat log is: the last stamp, chat and user seen and the message being collected."""

    stamp: str | None = None
    chat: int | None = None
    user: int | None = None
    collecting: list[str] | None = None


def _finish_message(
    state: _LogState,
    collecting: list[str],
    messages: list[tuple[str, int, str, str, int]],
    headers: list[str],
) -> None:
    text = "\n".join(collecting).strip()
    group = GROUP_PREFIX.match(text)
    if group:
        headers.extend([group.group(1), group.group(2)])
        state.user = int(group.group(3))
        text = text[group.end() :]
    if text and state.stamp:
        messages.append(
            (state.stamp, state.user if state.user is not None else 0, text, "u", state.chat or 0)
        )
    state.collecting = None


def _read_log_line(
    line: str, state: _LogState, messages: list[tuple[str, int, str, str, int]], headers: list[str]
) -> None:
    if state.collecting is not None:
        if line.startswith("=" * 20):
            _finish_message(state, state.collecting, messages, headers)
        else:
            state.collecting.append(line)
        return
    matched = STAMP.match(line)
    if matched:
        state.stamp = f"{matched.group(1)} {matched.group(2)}"
        return
    header = CHAT_HEADER.match(line)
    if header:
        state.chat, state.user = int(header.group(1)), int(header.group(3))
        headers.extend(part for part in (header.group(2), header.group(4), header.group(5)) if part)
    elif line.startswith("MESSAGE: "):
        state.collecting = [line[len("MESSAGE: ") :]]


def read_chat_logs(files: list[str]) -> tuple[list[tuple[str, int, str, str, int]], list[str]]:
    """User messages of the per-chat AI logs: (timestamp, user id, text, chat id) plus every name-like header string."""
    messages: list[tuple[str, int, str, str, int]] = []
    headers: list[str] = []
    for path in files:
        state = _LogState()
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle.read().split("\n"):
                _read_log_line(line, state, messages, headers)
    return messages, headers


class _RowCollector:
    """Chat rows keyed by (user, role, second, content hash); a repeat only adds its source class to the first row."""

    def __init__(self) -> None:
        self.rows: dict[tuple, dict] = {}
        self.stats: dict[str, dict[str, int]] = collections.defaultdict(
            lambda: {"found": 0, "new": 0}
        )

    def add(self, source: str, user_id, role, content, created_at, chat_id, row_id) -> None:
        if not isinstance(content, str) or not isinstance(created_at, str):
            return
        self.stats[source]["found"] += 1
        key = (user_id, role, created_at[:19], sha256_text(content))
        existing = self.rows.get(key)
        if existing:
            existing["sources"].add(source)
            return
        self.rows[key] = {
            "user": user_id,
            "role": role,
            "content": content,
            "at": created_at[:19],
            "chat": chat_id,
            "id": row_id,
            "source": source,
            "sources": {source},
        }
        self.stats[source]["new"] += 1


def _collect_database(collector: _RowCollector, item: dict) -> None:
    opened = OpenedDb(item["path"])
    try:
        history = opened.rows(
            "SELECT id, user_id, role, content, created_at, chat_id FROM chat_history ORDER BY id"
        ) or opened.rows(
            "SELECT id, user_id, role, content, created_at, NULL FROM chat_history ORDER BY id"
        )
        for row in history:
            collector.add(item["class"], row[1], row[2], row[3], row[4], row[5], row[0])
        for row in opened.rows(
            "SELECT a.id, a.user_id, 'user', a.input_summary, a.created_at, a.chat_id FROM user_action_log a "
            "WHERE a.action_type = 'intent_match' AND a.input_summary IS NOT NULL "
            "AND NOT EXISTS (SELECT 1 FROM chat_history h WHERE h.id = a.chat_history_id)"
        ):
            collector.add("action_log", row[1], row[2], row[3], row[4], row[5], row[0])
    finally:
        opened.close()


def _collect_blob(collector: _RowCollector, source: str, blob) -> None:
    items = blob["rows"] if isinstance(blob, dict) else [entry.get("row", entry) for entry in blob]
    for entry in items:
        collector.add(
            source,
            entry["user_id"],
            entry["role"],
            entry["content"],
            entry["created_at"],
            entry.get("chat_id"),
            entry.get("id"),
        )


def _collect_retained_corpora(collector: _RowCollector) -> None:
    for directory in sorted(os.listdir(AUDIT)):
        folder = os.path.join(AUDIT, directory)
        for name in ("private-messages.json", "selected.private.json"):
            path = os.path.join(folder, name)
            if os.path.exists(path):
                with open(path, encoding="utf-8") as handle:
                    _collect_blob(collector, "retained_corpus", json.load(handle))


def _collect_debug_candidates(collector: _RowCollector) -> None:
    for directory in sorted(os.listdir(AUDIT)):
        path = os.path.join(AUDIT, directory, "candidates.private.json")
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as handle:
            for candidate in json.load(handle):
                if candidate.get("source_kind") == "database" or not isinstance(
                    candidate.get("text_candidate"), str
                ):
                    continue
                stamp = str(candidate.get("timestamp") or "")[:19].replace("T", " ")
                collector.add(
                    "debug_run",
                    f"dbg:{candidate.get('conversation_id')}",
                    "user",
                    candidate["text_candidate"],
                    stamp,
                    None,
                    None,
                )


def read_rows(databases: list[dict]) -> tuple[list[dict], dict[str, dict[str, int]]]:
    """Every retained chat_history row of every source, deduplicated; a row keeps the classes of all sources that held it."""
    collector = _RowCollector()
    for item in databases:
        _collect_database(collector, item)
    _collect_retained_corpora(collector)
    _collect_debug_candidates(collector)
    chat_messages, _ = read_chat_logs(chat_log_files(CHAT_LOG_ROOTS))
    for stamp, user_id, text, _, chat_id in chat_messages:
        collector.add("chat_log", user_id, "user", text, stamp, chat_id, None)
    return sorted(
        collector.rows.values(), key=lambda r: (str(r["user"]), r["at"], r["id"] or 0)
    ), dict(collector.stats)
