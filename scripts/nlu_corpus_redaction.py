"""Redaction of candidate text and the connect-wizard / credential auth-window quarantine.

Shared by raw_export, candidate_record and audit, so what is pseudonymized and what is quarantined
cannot drift between the private export and the candidate corpus.
"""

from __future__ import annotations

import bisect
import collections
import datetime as dt
import hashlib
import hmac
import re

from nlu_corpus_rows import user_text

SESSION_GAP_SECONDS = 1800  # single source of truth for the auth-quarantine window, session boundary and stale-attachment cutoff

QUARANTINED_AUTH_MARKER = "[QUARANTINED_AUTH]"  # single source of truth: redact_candidate's replacement text and apply_gold_import's hard privacy gate must never drift apart
# What chat logging stores in place of anything typed into the Telegram-connect wizard since #617/#641:
# CONNECT_WIZARD_REDACTION in src/bot/scenes/connect-telegram.scene.ts (the tests keep the two equal).
CONNECT_WIZARD_REDACTION = "[redacted: connect wizard input]"

# The last alternatives match the connect wizard's phone and code prompts that name no credential term
# (connectTelegram in src/config/constants/messages/{en,ru}/connect-telegram.ts; a test checks every credential prompt in both languages).
AUTH = re.compile(
    r"connect_telegram|one.?time.?code|2fa|otp|two.factor|password|парол|код.{0,35}(?:вход|telegram|телеграм)|(?:telegram|телеграм).{0,35}код|session_string|api[_ -]?key|Bearer\s+[A-Za-z0-9]|verification code|invalid code|неверный код|international format|международн\w* формат",
    re.IGNORECASE,
)


def pseudonym(value: str, key: bytes, kind: str) -> str:
    digest = hmac.new(key, (kind + ":" + value.casefold()).encode(), hashlib.sha256).hexdigest()[
        :16
    ]
    return f"[{kind}_{digest}]"


def _looks_like_calendar_date(value: str) -> bool:
    """Mirror the bot's own NUMERIC_DATE_CANDIDATE_RE day-first convention
    (src/bot/handlers/group-message-filter.ts) so a real DD-MM(-YYYY) date the
    bot itself would parse never gets destroyed as a fake phone number.
    """
    iso = re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)
    if iso:
        try:
            dt.date.fromisoformat(value)
            return True
        except ValueError:
            return False
    day_month = re.fullmatch(r"(\d{1,2})-(\d{1,2})(?:-\d{2,4})?", value)
    if day_month:
        day, month = int(day_month[1]), int(day_month[2])
        return 1 <= day <= 31 and 1 <= month <= 12
    return False


def redact_candidate(text: str, key: bytes, lexicon: dict[str, str] | None = None) -> str:
    if AUTH.search(text):
        return QUARANTINED_AUTH_MARKER
    rules = [
        ("URL", r'https?://[^\s<>"\x27]+'),
        ("EMAIL", r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}"),
        ("HANDLE", r"(?<!\w)@[A-Za-z0-9_]+"),
        ("COORD", r"(?<!\d)-?\d{1,3}\.\d{3,}(?!\d)"),
        ("NUMBER", r"(?<!\w)\+?\d[\d ()-]{5,}\d(?!\w)"),
    ]
    for kind, pattern in rules:

        def replace(match, kind=kind):
            value = match[0]
            if kind == "NUMBER" and _looks_like_calendar_date(value):
                return value
            return pseudonym(value, key, kind)

        text = re.sub(pattern, replace, text)
    for name, kind in sorted((lexicon or {}).items(), key=lambda entry: -len(entry[0])):
        if len(name.strip()) >= 2:
            text = re.sub(
                r"(?<!\w)" + re.escape(name) + r"(?!\w)",
                lambda m, kind=kind: pseudonym(m[0], key, kind),
                text,
                flags=re.IGNORECASE,
            )
    return text


def opens_auth_window(text: object) -> bool:
    """A credential term, the marker the bot itself stores for connect-wizard input, or text that
    cannot be read, which may hold either."""
    if not isinstance(text, str):
        return True
    return CONNECT_WIZARD_REDACTION in text or AUTH.search(text) is not None


def quarantined_indices(rows: list[dict]) -> set[int]:
    """Rows too close to connect-wizard or other credential input to trust.

    Mirrors how the connect-wizard guard (#617/#641) recognises wizard input, for history it can no
    longer ask the wizard's scene row about: every row near an auth marker, the late answer to a
    prompt, and every copy of a quarantined user text. An auth marker is a row whose text opens the
    auth window, or a debug run whose logged reply or context does (see `_is_auth_marker`).
    """
    near_marker = _near_auth_markers(rows)
    blocked = near_marker | _late_answers(rows, near_marker)
    return blocked | _copies_of_quarantined_user_text(rows, blocked)


def _is_auth_marker(row: dict) -> bool:
    """The row's text, a debug run's reply (`response`) or its logged context (`auth_context`) opens the auth window."""
    return (
        opens_auth_window(row.get("text", ""))
        or (row.get("response") is not None and opens_auth_window(row["response"]))
        or bool(row.get("auth_context"))
    )


def _near_auth_markers(rows: list[dict]) -> set[int]:
    """Every row of the conversation within SESSION_GAP_SECONDS (the wizard's idle expiry) of an auth marker."""
    markers: dict[str, list[float]] = collections.defaultdict(list)
    for row in rows:
        if _is_auth_marker(row):
            markers[row["scope"]].append(row["at"])
    for times in markers.values():
        times.sort()
    near = set()
    for index, row in enumerate(rows):
        times = markers.get(row["scope"], [])
        at = bisect.bisect_left(times, row["at"] - SESSION_GAP_SECONDS)
        if at < len(times) and times[at] <= row["at"] + SESSION_GAP_SECONDS:
            near.add(index)
    return near


def _late_answers(rows: list[dict], near_marker: set[int]) -> set[int]:
    """However late it comes, the one user text that next answers a bot message inside an auth
    window (an auth marker included; it may be a wizard prompt), as the guard treats the answer to
    the prompt of an expired wizard, and the bot's turn after it (every bot row up to the user's next
    row), which may quote it. A button press is not an answer: the guard reads typed text only."""
    late = set()
    awaiting_answer: set[str] = set()
    answer_turn: set[str] = set()
    for index in sorted(range(len(rows)), key=lambda i: (rows[i]["scope"], rows[i]["at"], i)):
        scope = rows[index]["scope"]
        from_user = rows[index].get("role", "user") == "user"
        may_be_prompt = not from_user and index in near_marker  # every auth marker is near itself
        if from_user:
            answer_turn.discard(scope)
        if may_be_prompt:
            awaiting_answer.add(scope)
        elif (
            from_user
            and scope in awaiting_answer
            and user_text(rows[index].get("text", ""))[1] != "button"
        ):
            late.add(index)
            awaiting_answer.discard(scope)
            answer_turn.add(scope)
        elif not from_user and scope in answer_turn:
            late.add(index)
    return late


def _copies_of_quarantined_user_text(rows: list[dict], blocked: set[int]) -> set[int]:
    """Rows of the conversation repeating a quarantined user text, such as the AI debug log's copy
    of a database row. Short common replies in that conversation go with them; empty text does not."""

    def same_text(row: dict) -> tuple[str, str] | None:
        text = row.get("text", "")
        return (row["scope"], text.strip()) if isinstance(text, str) and text.strip() else None

    quarantined = {
        same_text(rows[index]) for index in blocked if rows[index].get("role", "user") == "user"
    }
    quarantined.discard(None)
    return {index for index, row in enumerate(rows) if same_text(row) in quarantined}
