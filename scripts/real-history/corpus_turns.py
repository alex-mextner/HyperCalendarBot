"""Entity registration for the scrubber, the per-user profile and the grouping of raw rows into user turns with
their executed tool calls."""

from __future__ import annotations

import collections
import datetime as dt
import json
import os
import re
import zoneinfo

import scrub as scrub_module
from corpus_sources import (
    AUDIT,
    CHAT_LOG_ROOTS,
    WEEKDAYS,
    ZONES,
    OpenedDb,
    chat_log_files,
    read_chat_logs,
)
from credentials import redact_history
from scrub import Scrubber, norm

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
