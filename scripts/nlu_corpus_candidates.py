"""Candidate record construction: SCHEMA_VERSION, the rule-based intent suggestions and the record shape."""

from __future__ import annotations

import re
from typing import TypedDict

from nlu_corpus_gold import GoldLabel
from nlu_corpus_redaction import QUARANTINED_AUTH_MARKER, redact_candidate

SCHEMA_VERSION = 2

COMMANDS = {
    "add": "event.create",
    "edit": "event.update",
    "delete": "event.delete",
    "search": "event.search",
    "today": "calendar.read",
    "tomorrow": "calendar.read",
    "week": "calendar.read",
    "month": "calendar.read",
    "free": "availability.read",
    "invite": "invitation.send",
    "invitations": "invitation.status",
    "contacts": "contacts.manage",
    "places": "places.manage",
    "settings": "settings.manage",
    "help": "help",
    "start": "onboarding",
    "log": "history.read",
    "history": "history.read",
    "cancel": "dialogue.cancel",
    "import": "calendar.import",
    "holidays": "calendar.holidays",
    "birthdays": "calendar.birthdays",
    "ping": "diagnostics",
    "connect_google": "integration.manage",
    "disconnect_google": "integration.manage",
    "connect_telegram": "auth.sensitive",
}
RULES = [
    (
        "event.create",
        r"\b(?:создай|создать|добавь|добавить|запланируй|schedule|create)\b.{0,200}(?:встреч|событ|завтра|сегодня|event|meeting)|^настолки\s+у\b",
    ),
    (
        "event.update",
        r"\b(?:перенеси|перенести|передвинь|переименуй|reschedule|move|rename)\b.{0,180}(?:событ|встреч|event|meeting)|\b(?:измени|поменяй)\b.{0,100}(?:время|название|место)",
    ),
    (
        "event.delete",
        r"\b(?:удали|удалить|отмени|delete|cancel)\b.{0,100}(?:встреч|событ|event|meeting)",
    ),
    ("event.search", r"\b(?:найди|поищи|find|search)\b.{0,100}(?:событ|встреч|event|meeting)"),
    (
        "calendar.read",
        r"\b(?:покажи|show|расписание|календарь|agenda)\b|что.{0,30}(?:сегодня|завтра|недел)",
    ),
    ("availability.read", r"свободн|свободен|свободна|свободны|free\s+(?:slot|time)"),
    ("invitation.send", r"\b(?:пригласи|пригласить|зови|позови|invite)\b"),
    (
        "invitation.status",
        r"кто.{0,30}(?:приглаш|принял|придет|придёт)|статус.{0,20}приглаш|invitation\s+status",
    ),
    (
        "invitation.respond",
        r"\b(?:прими|отклони)\b.{0,40}приглаш|accept\s+invitation|decline\s+invitation",
    ),
    ("contacts.manage", r"контакт|адресн.{0,10}книг|\bcontacts?\b"),
    ("places.manage", r"сохрани.{0,35}(?:место|адрес)|мои\s+места|saved\s+places"),
    ("reminder.manage", r"напомни|напоминан|remind"),
    ("settings.manage", r"настрой|часов.{0,10}пояс|голосов.{0,20}ответ|settings|timezone"),
    ("integration.manage", r"подключ|синхронизац|google|sync|connect"),
    ("history.read", r"истори[яию]|журнал|логи|\bhistory\b"),
    ("help", r"что\s+ты\s+умеешь|\bhelp\b|помощь"),
    ("feedback", r"не\s+работает|почему\s+ты|неправильно|ошибк|сломал|жалоб|\bbug\b"),
    ("smalltalk", r"^(?:привет|спасибо|благодарю|hi|hello|thanks)[!. ]*$"),
]


class CandidateRecord(TypedDict, total=False):
    schema_version: int
    text_candidate: str
    intent_candidates: list[str]
    observed_tools: list[str]
    gold: GoldLabel | None
    gold_adjudication: GoldLabel | None
    train_eligible: bool
    label_status: str
    privacy_status: str
    outcome_status: str
    source_kind: str
    input_kind: str
    source_ref: str
    actor_scope: str
    conversation_id: str
    source_refs: list[str]
    timestamp: str
    historical_state: str
    observed_responses: list[object]


def suggest_labels(text: str) -> list[str]:
    text = text.strip()
    if re.match(
        r"^(?:я\s+)?не\s+(?:могу|получается|выходит|удаётся|удается)\b", text, re.IGNORECASE
    ):
        return ["feedback"]  # an inability complaint, not a request for the action it names
    if re.match(
        r"^(?:не\s+(?:создавай|удаляй|приглашай|отменяй)|do\s+not|don.t)\b", text, re.IGNORECASE
    ):
        return ["dialogue.rejection"]
    command = re.match(r"^/([a-z_]+)(?:@\w+)?(?:\s|$)", text, re.IGNORECASE)
    if command:
        return [COMMANDS.get(command[1].lower(), "command.other")]
    if re.fullmatch(
        r"(?:да|нет|ага|ок|окей|yes|no|ok|\d{1,2}(?::\d{2})?)[.! ]*", text, re.IGNORECASE
    ):
        return ["dialogue.answer"]
    return [label for label, pattern in RULES if re.search(pattern, text, re.IGNORECASE)] or [
        "unknown"
    ]


def candidate_record(text: str, tools: list[str], key: bytes, lexicon=None) -> CandidateRecord:
    text_candidate = redact_candidate(text, key, lexicon)
    # A candidate whose own text was replaced by the auth marker is a source
    # privacy quarantine, not merely "needs review" -- apply_gold_import's
    # hard gate relies on this field being honest regardless of what a
    # caller-supplied gold import later claims about it.
    privacy_status = (
        "quarantined"
        if text_candidate == QUARANTINED_AUTH_MARKER
        else "pseudonymized_candidate_needs_review"
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "text_candidate": text_candidate,
        "intent_candidates": suggest_labels(text),
        "observed_tools": list(dict.fromkeys(tools)),
        "gold": None,
        "gold_adjudication": None,
        "train_eligible": False,
        "label_status": "needs_adjudication",
        "privacy_status": privacy_status,
        "outcome_status": "not_inferred_from_prose",
    }
