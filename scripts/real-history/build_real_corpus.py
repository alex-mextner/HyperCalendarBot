#!/usr/bin/env python3
"""Builds the scrubbed real-history corpus. RUN ON THE ODROID ONLY (root@odroidn2): the raw text never leaves it.

  nice ionice -c3 python3 build_real_corpus.py --out DIR --private DIR [--vocab-jsonl FILE ...] [--audit]

Reads (read-only): prod calendar.db (chat_history, user_action_log, users, contacts, events, group titles, memory),
the retained private corpora under private-audit/ and the old chat_history backups. Writes:
  OUT/real-history.jsonl   scrubbed records, one per distinct user text (only this goes to git / other hosts)
  OUT/manifest.json        counts, checksum, scrubber version, leak-gate results (no entity, no mapping)
  PRIVATE/mapping.json     secret + lemma->pseudonym mapping, 0600, never leaves the host
Each record carries the user message, the context shape, the tool calls the historical system actually executed with
their result status, and the scrubbed replies. `--audit` prints aggregate counts only and writes nothing.
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
import secrets
import shutil
import sqlite3
import sys
import tempfile
import zoneinfo
from collections.abc import Iterator
from dataclasses import dataclass, field

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import scrub as scrub_module
from credentials import redact_history
from scrub import Scrubber, norm

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


PHRASES: set[str] = set()


class _EntityAdder:
    """Registers a real string with the scrubber, counts it by kind and remembers multi-word strings as phrases."""

    def __init__(self, scrubber: Scrubber) -> None:
        self.scrubber = scrubber
        self.counts: collections.Counter = collections.Counter()

    def __call__(self, surface, kind: str) -> None:
        if not isinstance(surface, str) or not surface.strip():
            return
        self.scrubber.add_entity(surface, kind)
        self.counts[kind] += 1
        words = scrub_module.WORD_RE.findall(surface)
        if len(words) >= 2 and len(surface) <= 80:
            PHRASES.add(norm(" ".join(words)))


def _register_people(add: _EntityAdder, opened: OpenedDb) -> None:
    for first_name, username, city in opened.rows(
        "SELECT first_name, username, city FROM users"
    ) or opened.rows("SELECT first_name, username, NULL FROM users"):
        add(first_name, "first")
        add(username, "other")
        add(city, "place")
    for name, username, preferred in opened.rows(
        "SELECT name, username, preferred_name FROM contacts"
    ) or opened.rows("SELECT name, username, NULL FROM contacts"):
        for index, part in enumerate((name or "").split()):
            add(part, "first" if index == 0 else "surname")
        add(username, "other")
        add(preferred, "first")


def _register_texts(add: _EntityAdder, opened: OpenedDb) -> None:
    for (title,) in opened.rows("SELECT title FROM group_chats"):
        add(title, "text")
    for title, location, description in opened.rows(
        "SELECT title, location, description FROM events"
    ):
        add(title, "text")
        add(location, "text")
        add(description, "text")
    for (name,) in opened.rows("SELECT calendar_name FROM google_calendars"):
        add(name, "text")
    for (content,) in opened.rows("SELECT content FROM user_memory"):
        add(content, "text")
    for (username,) in opened.rows(
        "SELECT invitee_username FROM invitations WHERE invitee_username IS NOT NULL"
    ):
        add(username, "other")


def _register_lexicons(add: _EntityAdder) -> None:
    for directory in sorted(os.listdir(AUDIT)):
        path = os.path.join(AUDIT, directory, "selected.private.json")
        if os.path.exists(path):
            with open(path, encoding="utf-8") as handle:
                lexicon = json.load(handle).get("lexicon", {})
            for real in lexicon:
                add(real, "other")


def register_entities(scrubber: Scrubber, databases: list[dict]) -> dict[str, int]:
    add = _EntityAdder(scrubber)
    for item in databases:
        opened = OpenedDb(item["path"])
        try:
            _register_people(add, opened)
            _register_texts(add, opened)
        finally:
            opened.close()
    _, headers = read_chat_logs(chat_log_files(CHAT_LOG_ROOTS))
    for header in set(headers):
        add(header, "text")
    _register_lexicons(add)
    return dict(add.counts)


def user_profile(databases: list[dict]) -> dict[int, tuple[str, str]]:
    """Language and zone of each user; the newest database that knows the user wins."""
    profile: dict[int, tuple[str, str]] = {}
    for item in sorted(databases, key=lambda entry: entry.get("last") or ""):
        opened = OpenedDb(item["path"])
        try:
            for telegram_id, language, timezone in opened.rows(
                "SELECT telegram_id, language, timezone FROM users"
            ):
                profile[telegram_id] = (language or "ru", timezone or "UTC")
        finally:
            opened.close()
    return profile


def local_clock(created_at: str, tz_name: str) -> tuple[str, dict[str, str], str]:
    moment = dt.datetime.strptime(created_at[:19], "%Y-%m-%d %H:%M:%S").replace(
        tzinfo=dt.timezone.utc
    )
    try:
        zone = zoneinfo.ZoneInfo(tz_name)
    except (zoneinfo.ZoneInfoNotFoundError, ValueError):
        zone = zoneinfo.ZoneInfo("UTC")
    local = moment.astimezone(zone)
    offset = local.utcoffset().total_seconds() / 3600
    best = min(
        ZONES,
        key=lambda name: abs(
            moment.astimezone(zoneinfo.ZoneInfo(name)).utcoffset().total_seconds() / 3600 - offset
        ),
    )
    return (
        best,
        {"day": WEEKDAYS[local.weekday()], "at": local.strftime("%H:%M")},
        local.strftime("%Y-%m-%d"),
    )


# ─── turns ──────────────────────────────────────────────────────────────────────────────────────────────────────────


def parse_json(text: str):
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None


def user_text(content: str) -> str | None:
    """The plain text a person typed or said; None for envelopes (button presses, activity records)."""
    stripped = content.strip()
    if not stripped or stripped[0] in "{[":
        return None
    if stripped.startswith("🎤"):
        stripped = stripped[1:].strip()
    return stripped or None


def _bot_text(content: str, previous: str) -> str:
    """The bot's last message as plain text; the previous one stays when this row has none."""
    payload = parse_json(content)
    if isinstance(payload, dict) and isinstance(payload.get("text"), str):
        return payload["text"]
    if isinstance(payload, dict) and isinstance(payload.get("content"), str):
        return payload["content"]
    if payload is None:
        return content
    return previous


def _tool_calls_of(payload: dict) -> list[dict]:
    calls: list[dict] = []
    for call in payload.get("tool_calls") or []:
        function = call.get("function", {})
        args = (
            parse_json(function.get("arguments", ""))
            if isinstance(function.get("arguments"), str)
            else None
        )
        calls.append(
            {
                "id": call.get("id"),
                "name": function.get("name"),
                "args": args if args is not None else {},
            }
        )
    return calls


def _replies_of(payload: dict) -> list[str]:
    replies: list[str] = []
    if isinstance(payload.get("content"), str) and payload["content"].strip():
        replies.append(payload["content"])
    if isinstance(payload.get("text"), str) and payload.get("kind") is not None:
        replies.append(payload["text"])
    return replies


def _tool_results(payload) -> dict[str, str]:
    entries = payload if isinstance(payload, list) else [payload]
    return {
        entry.get("tool_call_id", ""): entry["content"]
        for entry in entries
        if isinstance(entry, dict) and isinstance(entry.get("content"), str)
    }


def _executed_after(items: list[dict], index: int) -> tuple[list[dict], list[str]]:
    """Tool calls (with their results) and replies recorded after the user row `index`, until the next user row."""
    calls: list[dict] = []
    replies: list[str] = []
    results: dict[str, str] = {}
    for follower in items[index + 1 :]:
        if follower["role"] == "user":
            break
        payload = parse_json(follower["content"])
        if follower["role"] == "assistant" and isinstance(payload, dict):
            calls.extend(_tool_calls_of(payload))
            replies.extend(_replies_of(payload))
        elif follower["role"] == "tool":
            results.update(_tool_results(payload))
    for call in calls:
        result = results.get(call.pop("id") or "")
        call["result"] = result
    return calls, replies


def _assistant_said(payload, raw: str):
    if not isinstance(payload, dict):
        return raw
    return payload.get("text") or payload.get("content")


def _history_entry(earlier: dict) -> dict | None:
    payload = parse_json(earlier["content"])
    if earlier["role"] == "user":
        typed = user_text(earlier["content"])
        return (
            {"role": "user", "text": typed}
            if typed
            else {"role": "user", "text": None, "event": True}
        )
    if earlier["role"] != "assistant":
        return None
    if isinstance(payload, dict) and payload.get("tool_calls"):
        return {
            "role": "assistant",
            "tools": [call.get("function", {}).get("name") for call in payload["tool_calls"]],
        }
    said = _assistant_said(payload, earlier["content"])
    return {"role": "assistant", "text": said if isinstance(said, str) else None}


def _history_before(items: list[dict], index: int) -> list[dict]:
    entries = (_history_entry(earlier) for earlier in items[max(0, index - 8) : index])
    return [entry for entry in entries if entry is not None]


def _turns_of_user(user: int, items: list[dict]) -> list[dict]:
    turns: list[dict] = []
    previous_bot = ""
    prior_turns = 0
    for index, row in enumerate(items):
        if row["role"] == "assistant":
            previous_bot = _bot_text(row["content"], previous_bot)
            continue
        if row["role"] != "user":
            continue
        text = user_text(row["content"])
        prior_turns += 1
        if text is None:
            continue
        calls, replies = _executed_after(items, index)
        turns.append(
            {
                "history": redact_history(_history_before(items, index))[
                    0
                ],  # a password or login code is never read, never scrubbed, never kept
                "user": user,
                "row": row,
                "text": text,
                "voice": row["content"].strip().startswith("🎤"),
                "previousBot": previous_bot,
                "priorTurns": prior_turns - 1,
                "calls": calls,
                "replies": replies,
            }
        )
    return turns


def turns_of(rows: list[dict]) -> list[dict]:
    """One turn per plain user text: the text, the bot's previous message and everything executed until the next user row."""
    turns: list[dict] = []
    by_user: dict[int, list[dict]] = collections.defaultdict(list)
    for row in rows:
        by_user[row["user"]].append(row)
    for user, items in by_user.items():
        turns.extend(_turns_of_user(user, items))
    return turns


def normal_key(text: str) -> str:
    return re.sub(r"\s+", " ", norm(text)).strip(" \t.,!?;:…")


# ─── gates ──────────────────────────────────────────────────────────────────────────────────────────────────────────


def walk(value, path: str = ""):
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, list):
        for item in value:
            yield from walk(item, path)
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from walk(item, f"{path}.{key}" if path else key)


def sensitive_values(text: str) -> set[str]:
    """Every e-mail, URL, handle, phone and long digit run of a RAW string; none may survive into the output."""
    found: set[str] = set()
    for pattern in (EMAIL, URL, HANDLE, LONG_DIGITS, PHONEISH):
        for match in pattern.finditer(text):
            value = match.group(0)
            if pattern is PHONEISH and re.search(r"\d{4}-\d{2}-\d{2}|:", value):
                continue
            found.add(value.lower())
    return found


def format_hits(text: str) -> dict[str, int]:
    """Output-format gate: only the scrubber's own placeholders may look like contact data."""
    hits: dict[str, int] = {}
    for label, pattern in (("email", EMAIL), ("url", URL), ("handle", HANDLE)):
        for match in pattern.finditer(text):
            value = match.group(0)
            if (
                value.endswith("@example.org")
                or "example.org/" in value
                or value.startswith("@px_")
            ):
                continue
            hits[label] = hits.get(label, 0) + 1
    return hits


def add_counts(total: dict[str, int], hits: dict[str, int]) -> None:
    for label, count in hits.items():
        total[label] = total.get(label, 0) + count


def _without_tools(history: list[dict]) -> list[dict]:
    return [{key: value for key, value in item.items() if key != "tools"} for item in history]


def _is_real_token(scrubber: Scrubber, token: str) -> bool:
    real = token in scrubber.real_norms or any(hit[0].real for hit in scrubber.forms.get(token, ()))
    return real and token not in scrub_module.pools.NEVER_ENTITY


def _whole_entity_phrases(scrubber: Scrubber, blob: str) -> list[list[str]]:
    """Registered multi-word private strings that survive verbatim in `blob`, as token lists."""
    survivors: list[list[str]] = []
    for phrase in PHRASES:
        tokens = phrase.split()
        if any(_is_real_token(scrubber, token) for token in tokens) and phrase in blob:
            survivors.append(tokens)
    return survivors


def _verify_fields(record: dict) -> dict:
    free = {key: record[key] for key in ("say", "replies", "executed")}
    free["history"] = _without_tools(record["history"])
    free["previousBot"] = record["context"]["previousBot"]
    return free


def verify_corpus(path: str, scrubber: Scrubber, fingerprint: str) -> int:
    """Run the output gates again on a written corpus against the live entity registry (odroid only)."""
    entity_leaks = 0
    regex_total: dict[str, int] = {}
    records = 0
    texts: list[str] = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            record = json.loads(line)
            records += 1
            for _, text in walk(_verify_fields(record)):
                texts.append(text)
                entity_leaks += len(scrubber.leaks(text))
                add_counts(regex_total, format_hits(text))
    blob = " ".join(scrub_module.WORD_RE.findall(norm("\n".join(texts))))
    whole = len(_whole_entity_phrases(scrubber, blob))
    print(
        json.dumps(
            {
                "records": records,
                "entityForms": entity_leaks,
                "wholeEntityStrings": whole,
                "regex": regex_total,
                "entityListSha256": fingerprint,
            }
        )
    )
    return 0 if entity_leaks == 0 and whole == 0 and not regex_total else 3


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="/tmp/real-history-out")
    parser.add_argument("--private", default=f"{AUDIT}/real-history")
    parser.add_argument("--vocab-jsonl", action="append", default=[])
    parser.add_argument("--audit", action="store_true")
    parser.add_argument(
        "--verify",
        metavar="CORPUS",
        help="re-run the entity and format gates on an already written corpus file and exit",
    )
    parser.add_argument(
        "--scan",
        nargs="+",
        metavar="FINDLIST",
        help="probe the files of these find listings and write sources.json",
    )
    return parser.parse_args()


def _skip_reason(text: str, previous_bot: str | None) -> str | None:
    if "[redacted" in text or SENSITIVE_PROMPT.search(previous_bot or ""):
        return "connect_wizard"
    if re.fullmatch(r"[+\d\s().-]{5,}", text):
        return "digits_only"
    if not normal_key(text):
        return "empty"
    return None


def distinct_turns(turns: list[dict]) -> tuple[list[dict], collections.Counter]:
    """One turn per normalised text (the first one), with its repeat count, users and source classes; plus skip counts."""
    seen: dict[str, dict] = {}
    skipped: collections.Counter = collections.Counter()
    for turn in turns:
        reason = _skip_reason(turn["text"], turn["previousBot"])
        if reason:
            skipped[reason] += 1
            continue
        key = normal_key(turn["text"])
        entry = seen.get(key)
        if entry:
            entry["repeats"] += 1
            entry["users"].add(turn["user"])
            entry["classes"] |= turn["row"]["sources"]
            continue
        turn["repeats"] = 1
        turn["users"] = {turn["user"]}
        turn["classes"] = set(turn["row"]["sources"])
        seen[key] = turn
    return sorted(seen.values(), key=lambda t: (t["row"]["at"], str(t["user"]))), skipped


def print_audit(
    distinct: list[dict], per_source: dict[str, dict[str, int]], skipped: collections.Counter
) -> None:
    per_user = collections.Counter(t["user"] for t in distinct)
    tools = collections.Counter(c["name"] for t in distinct for c in t["calls"])
    print(
        json.dumps(
            {
                "distinct": len(distinct),
                "users": len(per_user),
                "perUser": sorted(per_user.values(), reverse=True),
                "tools": tools.most_common(30),
                "withTools": sum(1 for t in distinct if t["calls"]),
                "groups": sum(1 for t in distinct if (t["row"]["chat"] or 0) < 0),
                "sources": per_source,
                "skipped": dict(skipped),
            },
            ensure_ascii=False,
        )
    )


def learn_proper_nouns(scrubber: Scrubber, distinct: list[dict]) -> None:
    """First pass: learn every proper noun the heuristics find, so the second pass treats it identically in every
    message, field and letter case (a title «Визаран» in a tool call and «визаран» in the user's text)."""
    for turn in distinct:
        scrubber.scrub(turn["text"])
        scrubber.scrub(turn["previousBot"] or "")
        for reply in turn["replies"]:
            scrubber.scrub(reply)
        for item in turn["history"]:
            scrubber.scrub(item.get("text") or "")
        for call in turn["calls"]:
            scrubber.scrub_json(call["args"])
            scrubber.scrub(call.get("result") or "")


def _record_lang(text: str, profile_language: str) -> str:
    if re.search("[А-Яа-яЁё]", text):
        return "ru"
    if re.search("[A-Za-z]", text):
        return "en"
    return profile_language if profile_language in ("ru", "en") else "ru"


def _scrubbed_calls(scrubber: Scrubber, turn: dict) -> list[dict]:
    calls = []
    for call in turn["calls"]:
        result = call.get("result")
        calls.append(
            {
                "name": call["name"],
                "args": scrubber.scrub_json(call["args"]),
                "ok": None if result is None else not ERROR_RESULT.search(result),
                "result": None if result is None else scrubber.scrub(result)[:400],
            }
        )
    return calls


def build_record(
    index: int, turn: dict, scrubber: Scrubber, user_ids: dict, profile: dict[int, tuple[str, str]]
) -> dict:
    language, tz_name = profile.get(turn["user"], ("ru", "UTC"))
    zone, clock, date = local_clock(turn["row"]["at"], tz_name)
    calls = _scrubbed_calls(scrubber, turn)
    return {
        "id": f"rh-{index + 1:04d}",
        "user": user_ids[turn["user"]],
        "lang": _record_lang(turn["text"], language),
        "chat": "group" if (turn["row"]["chat"] or 0) < 0 else "private",
        "tz": zone,
        "clock": clock,
        "date": date,
        "say": scrubber.scrub(turn["text"]),
        "voice": turn["voice"],
        "context": {
            "priorTurns": turn["priorTurns"],
            "previousBot": scrubber.scrub(turn["previousBot"])[:300]
            if turn["previousBot"]
            else None,
        },
        "history": [
            {
                key: (scrubber.scrub(value)[:240] if isinstance(value, str) else value)
                for key, value in item.items()
            }
            for item in turn["history"]
        ],
        "executed": calls,
        "expectedTools": [call["name"] for call in calls],
        "expectSilence": not calls and not turn["replies"],
        "replies": [scrubber.scrub(reply)[:400] for reply in turn["replies"]][:4],
        "flags": {"qaProbe": bool(QA_PROBE.search(turn["text"]))},
        "repeats": turn["repeats"],
        "users": len(turn["users"]),
        "sources": sorted(turn["classes"]),
    }


def raw_sensitive_of(turn: dict) -> set[str]:
    """Every contact-like value of the RAW strings of a turn."""
    found = sensitive_values(turn["text"]) | sensitive_values(turn["previousBot"] or "")
    for reply in turn["replies"]:
        found |= sensitive_values(reply)
    for item in turn["history"]:
        found |= sensitive_values(item.get("text") or "")
    for call in turn["calls"]:
        for _, raw_text in walk(call["args"]):
            found |= sensitive_values(raw_text)
        found |= sensitive_values(call.get("result") or "")
    return found


@dataclass
class GateTally:
    """What the output gates collect over all records."""

    leaks: list[tuple[str, str, str]] = field(default_factory=list)
    leak_fields: collections.Counter = field(default_factory=collections.Counter)
    regex: dict[str, int] = field(default_factory=dict)
    raw_sensitive: set[str] = field(default_factory=set)


def _mask_alnum(chars: str) -> list[str]:
    return [("a" if ch.isalnum() else ch) for ch in chars]


def _stem_matches(scrubber: Scrubber, token: str) -> list[tuple[str, scrub_module.Entry]]:
    return [
        (st, e)
        for st, e in scrubber.stem_entries.items()
        if token.startswith(st) and len(token) - len(st) <= 3
    ]


def _debug_context(token: str, text: str) -> list:
    folded = norm(text)
    at = folded.find(token)
    return [
        "ctx",
        _mask_alnum(folded[max(0, at - 2) : at]),
        _mask_alnum(folded[at + len(token) : at + len(token) + 2]),
        "len",
        len(text),
    ]


def _debug_raw_context(token: str, turn: dict) -> list[str] | None:
    raw = norm(
        json.dumps(
            [turn["text"], turn["previousBot"], turn["replies"], turn["history"]],
            ensure_ascii=False,
        )
    )
    if token not in raw:
        return None
    at = raw.find(token)
    return [
        ("A" if ch.isupper() else "l" if ch.isalpha() else ch)
        for ch in raw[max(0, at - 4) : at + len(token) + 4]
    ]


def _debug_probes(scrubber: Scrubber, token: str, turn: dict) -> list:
    return [
        "rescrubSame",
        scrubber.scrub(token) == token,
        "rawCtx",
        _debug_raw_context(token, turn),
        "tokenSame",
        scrubber._token(token, "", False, token) == token,
        "wordPassSame",
        scrubber._word_pass(token) == token,
        "safe",
        token in scrub_module.pools.SAFE_PROPER,
        "hasSpace",
        token != token.strip(),
        "lenLow",
        len(norm(token)),
    ]


def _debug_stems(scrubber: Scrubber, token: str) -> list:
    manual = []
    for stem, entry in _stem_matches(scrubber, token):
        word = scrubber._render(scrub_module.Hit(entry, "x", token[len(stem) :]), token)
        manual.append(
            (word == token, len(word), scrubber._is_real_form(word), token[: len(stem)] == stem)
        )
    first_stem = [(len(stem), stem == token) for stem, _ in _stem_matches(scrubber, token)]
    mapped = [
        scrubber.mapping.get(norm(entry.lemma)) for _, entry in _stem_matches(scrubber, token)
    ]
    explain = [
        (
            entry.kind,
            entry.cls,
            entry.gender,
            entry.real,
            len(stem),
            len(token) - len(stem),
            scrubber._pseudonym(entry).cls,
            len(scrubber._pseudonym(entry).lemma),
        )
        for stem, entry in _stem_matches(scrubber, token)
    ]
    return ["manual", manual, "firstStem", first_stem, "mapped", mapped, "explain", explain]


def _debug_vocabulary(
    scrubber: Scrubber, vocab: set[str], token: str, text: str, turn: dict
) -> list:
    raw_blob = norm(
        json.dumps(
            [
                turn["text"],
                turn["previousBot"],
                turn["replies"],
                turn["history"],
                [c["args"] for c in turn["calls"]],
            ],
            ensure_ascii=False,
        )
    )
    return [
        "capital",
        any(w[:1].isupper() for w in scrub_module.WORD_RE.findall(text) if norm(w) == token),
        "common",
        token in vocab,
        "inForms",
        token in scrubber.forms,
        "stemEntry",
        len(_stem_matches(scrubber, token)),
        "inRaw",
        token in raw_blob,
        "isPseudonym",
        token in {norm(v) for v in scrubber.mapping.values()},
        "inMapKeys",
        token in scrubber.mapping,
    ]


def _debug_leak(
    scrubber: Scrubber, vocab: set[str], turn: dict, path: str, token: str, text: str
) -> None:
    """DEBUG_LEAKS diagnostics of one leaked token, to stderr."""
    print(
        "DEBUG",
        path.split(".")[0],
        len(token),
        "ascii",
        token.isascii(),
        *_debug_context(token, text),
        *_debug_probes(scrubber, token, turn),
        *_debug_stems(scrubber, token),
        *_debug_vocabulary(scrubber, vocab, token, text, turn),
        file=sys.stderr,
    )


def _scanned_fields(record: dict) -> dict:
    free = {key: record[key] for key in ("say", "replies")}
    free["history"] = _without_tools(record["history"])
    free["previousBot"] = record["context"]["previousBot"]
    free["executed"] = [
        {"args": call["args"], "result": call["result"]} for call in record["executed"]
    ]
    return free


def _scan_record(
    tally: GateTally, scrubber: Scrubber, vocab: set[str], turn: dict, record: dict
) -> None:
    for path, text in walk(_scanned_fields(record)):
        for reason, token, kind in scrubber.leaks(text):
            shown = token if token in vocab else f"<{len(token)}>"
            tally.leaks.append((reason, token, kind))
            if os.environ.get("DEBUG_LEAKS"):
                _debug_leak(scrubber, vocab, turn, path, token, text)
            where = path[:24] if path.startswith("executed") else path.split(".")[0]
            tally.leak_fields[(where, reason, kind, shown)] += 1
        add_counts(tally.regex, format_hits(text))


def build_records(
    distinct: list[dict],
    scrubber: Scrubber,
    vocab: set[str],
    user_ids: dict,
    profile: dict[int, tuple[str, str]],
) -> tuple[list[dict], GateTally]:
    tally = GateTally()
    records: list[dict] = []
    for index, turn in enumerate(distinct):
        record = build_record(index, turn, scrubber, user_ids, profile)
        tally.raw_sensitive |= raw_sensitive_of(turn)
        _scan_record(tally, scrubber, vocab, turn, record)
        records.append(record)
    return records, tally


def _debug_phrases(
    scrubber: Scrubber, vocab: set[str], blob: str, phrases: list[list[str]]
) -> None:
    for tokens in phrases:
        print(
            "DEBUGPHRASE",
            [
                (
                    len(t),
                    t in vocab,
                    t in scrubber.real_norms,
                    t in scrubber.real_stems,
                    bool(scrubber.forms.get(t)),
                    t in blob.split(),
                )
                for t in tokens
            ],
            file=sys.stderr,
        )


def run_gates(records: list[dict], tally: GateTally, scrubber: Scrubber, vocab: set[str]) -> dict:
    """Whole-string gate (no multi-word private string survives verbatim) and raw-sensitive gate; returns the verdict."""
    blob = norm(
        "\n".join(
            text
            for record in records
            for _, text in walk({k: record[k] for k in ("say", "history", "replies", "executed")})
        )
    )
    surviving = sum(1 for value in tally.raw_sensitive if value in blob)
    blob = " ".join(scrub_module.WORD_RE.findall(blob))
    if surviving:
        tally.regex["rawSensitiveSurvives"] = surviving
    phrases = _whole_entity_phrases(scrubber, blob)
    if os.environ.get("DEBUG_LEAKS"):
        _debug_phrases(scrubber, vocab, blob, phrases)
    return {
        "entityForms": len(tally.leaks),
        "wholeEntityStrings": len(phrases),
        "regex": tally.regex,
    }


def gates_passed(gates: dict) -> bool:
    return not gates["entityForms"] and gates["wholeEntityStrings"] == 0 and not gates["regex"]


KNOWN_WEAK_SPOTS = [
    "A first name that is in no database table, not in the built-in gazetteer and written in lower case is replaced only after a preposition cue (with/for/to/from/about) and when it is not one edit from a dictionary word.",
    "Narrative content with no name in it (health, family, pets, travel plans, long voice transcripts) is kept as written: it is not name-based personal data and the engine needs it.",
    "Absolute dates and clock times are real: only names, places, contacts and ids are pseudonymised.",
    "Two of twelve users write most of the rows (u07, u11): report per-user results, not only pooled ones.",
    "Pseudonyms are drawn from a small public pool; an inflected pseudonym can read slightly oddly (Cyrillic ending on a Latin or place pseudonym).",
]


def build_manifest(
    records: list[dict],
    checksum: str,
    source_rows: dict,
    user_texts: int,
    skipped: collections.Counter,
    user_count: int,
    entities: dict,
    gates: dict,
) -> dict:
    months = collections.Counter(record["date"][:7] for record in records)
    return {
        "schemaVersion": 1,
        "scrubberVersion": scrub_module.VERSION,
        "builtAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "records": len(records),
        "checksum": checksum,
        "file": "real-history.jsonl",
        "sourceRows": source_rows,
        "recordsBySourceClass": dict(
            collections.Counter(cls for record in records for cls in record["sources"])
        ),
        "userTexts": user_texts,
        "distinctTexts": len(records),
        "skipped": dict(skipped),
        "users": user_count,
        "byLang": dict(collections.Counter(r["lang"] for r in records)),
        "byChat": dict(collections.Counter(r["chat"] for r in records)),
        "withExecutedTools": sum(1 for r in records if r["executed"]),
        "byMonth": dict(sorted(months.items())),
        "entities": entities,
        "leakGates": {
            **gates,
            "passed": True,
            "note": "entity forms and stems, whole-string and regex gates run on every string of every record",
        },
        "knownWeakSpots": KNOWN_WEAK_SPOTS,
        "mapping": "private: kept at 0600 on the build host, never exported",
    }


def write_corpus(out: str, lines: list[str]) -> None:
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "real-history.jsonl"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


def write_manifest(out: str, manifest: dict) -> None:
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")


def main() -> int:
    args = _parse_args()

    if args.scan:
        scan_sources(args.scan, args.private)
        return 0
    databases = load_sources(args.private)
    rows, per_source = read_rows(databases)
    turns = turns_of(rows)
    profile = user_profile(databases)
    print(
        f"databases {len(databases)}; rows unique {len(rows)} by source {per_source}; user text turns {len(turns)}",
        file=sys.stderr,
    )

    vocab, proper = load_vocab(args.vocab_jsonl)
    secret, mapping = load_secret(args.private)
    scrubber = Scrubber(vocab=vocab, proper=proper, secret=secret, mapping=mapping)
    entity_counts = register_entities(scrubber, databases)
    fingerprint = sha256_text("\n".join(sorted(scrubber.real_norms)))
    print(f"entities {entity_counts}, real lemmas {len(scrubber.real_norms)}", file=sys.stderr)
    if args.verify:
        return verify_corpus(args.verify, scrubber, fingerprint)

    distinct, skipped = distinct_turns(turns)
    print(f"distinct texts {len(distinct)}, skipped {dict(skipped)}", file=sys.stderr)
    if args.audit:
        print_audit(distinct, per_source, skipped)
        return 0

    learn_proper_nouns(scrubber, distinct)
    user_ids = {
        user: f"u{index + 1:02d}"
        for index, user in enumerate(sorted({t["user"] for t in distinct}, key=str))
    }
    records, tally = build_records(distinct, scrubber, vocab, user_ids, profile)
    lines = [json.dumps(record, ensure_ascii=False, sort_keys=True) for record in records]
    checksum = scrub_module.checksum(lines)
    gates = run_gates(records, tally, scrubber, vocab)
    print(f"gates {gates}", file=sys.stderr)
    if not gates_passed(gates):
        print("LEAK GATE FAILED: no corpus written", file=sys.stderr)
        print(
            json.dumps(
                {
                    "gates": gates,
                    "leakFields": [[list(k), v] for k, v in tally.leak_fields.most_common(40)],
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 3

    write_corpus(args.out, lines)
    source_rows = {
        "databasesRead": len(databases),
        "databasesByClass": dict(collections.Counter(item["class"] for item in databases)),
        "rowsFoundAndNewByClass": per_source,
        "uniqueRowsAfterDedupe": len(rows),
    }
    entities = {
        "registeredByKind": entity_counts,
        "lemmas": len(scrubber.real_norms),
        "listSha256": fingerprint,
    }
    manifest = build_manifest(
        records, checksum, source_rows, len(turns), skipped, len(user_ids), entities, gates
    )
    write_manifest(args.out, manifest)
    save_mapping(args.private, secret, scrubber.export_mapping())
    print(
        json.dumps(
            {
                k: manifest[k]
                for k in (
                    "records",
                    "users",
                    "checksum",
                    "leakGates",
                    "byLang",
                    "byChat",
                    "withExecutedTools",
                )
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
