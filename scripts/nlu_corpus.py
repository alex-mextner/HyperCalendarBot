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
import bisect
import collections
import datetime as dt
import gzip
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import tempfile
from typing import Literal, TypedDict

SCHEMA_VERSION = 2
SESSION_GAP_SECONDS = 1800  # single source of truth for the auth-quarantine window, session boundary and stale-attachment cutoff
MAX_DATABASE_BYTES = 512*1024*1024  # single bound enforced at both fstat-open time and while streaming a gz's decompressed bytes
MAX_LOG_BYTES = 64*1024*1024        # same, for debug logs and --merge archives
QUARANTINED_AUTH_MARKER = '[QUARANTINED_AUTH]'  # single source of truth: redact_candidate's replacement text and apply_gold_import's hard privacy gate must never drift apart
# What chat logging stores in place of anything typed into the Telegram-connect wizard since #617/#641:
# CONNECT_WIZARD_REDACTION in src/bot/scenes/connect-telegram.scene.ts (the tests keep the two equal).
CONNECT_WIZARD_REDACTION = '[redacted: connect wizard input]'

# The last alternatives match the connect wizard's phone and code prompts that name no credential term
# (connectTelegram in src/config/constants.ts; a test checks every credential prompt in both languages).
AUTH = re.compile(r'connect_telegram|one.?time.?code|2fa|otp|two.factor|password|парол|код.{0,35}(?:вход|telegram|телеграм)|(?:telegram|телеграм).{0,35}код|session_string|api[_ -]?key|Bearer\s+[A-Za-z0-9]|verification code|invalid code|неверный код|international format|международн\w* формат', re.I)
COMMANDS = {'add':'event.create','edit':'event.update','delete':'event.delete','search':'event.search', 'today':'calendar.read','tomorrow':'calendar.read','week':'calendar.read','month':'calendar.read', 'free':'availability.read','invite':'invitation.send','invitations':'invitation.status', 'contacts':'contacts.manage','places':'places.manage','settings':'settings.manage', 'help':'help','start':'onboarding','log':'history.read','history':'history.read', 'cancel':'dialogue.cancel','import':'calendar.import','holidays':'calendar.holidays','birthdays':'calendar.birthdays','ping':'diagnostics','connect_google':'integration.manage','disconnect_google':'integration.manage','connect_telegram':'auth.sensitive'}
RULES = [
 ('event.create', r'\b(?:создай|создать|добавь|добавить|запланируй|schedule|create)\b.{0,200}(?:встреч|событ|завтра|сегодня|event|meeting)|^настолки\s+у\b'),
 ('event.update', r'\b(?:перенеси|перенести|передвинь|переименуй|reschedule|move|rename)\b.{0,180}(?:событ|встреч|event|meeting)|\b(?:измени|поменяй)\b.{0,100}(?:время|название|место)'),
 ('event.delete', r'\b(?:удали|удалить|отмени|delete|cancel)\b.{0,100}(?:встреч|событ|event|meeting)'),
 ('event.search', r'\b(?:найди|поищи|find|search)\b.{0,100}(?:событ|встреч|event|meeting)'),
 ('calendar.read', r'\b(?:покажи|show|расписание|календарь|agenda)\b|что.{0,30}(?:сегодня|завтра|недел)'),
 ('availability.read', r'свободн|свободен|свободна|свободны|free\s+(?:slot|time)'),
 ('invitation.send', r'\b(?:пригласи|пригласить|зови|позови|invite)\b'),
 ('invitation.status', r'кто.{0,30}(?:приглаш|принял|придет|придёт)|статус.{0,20}приглаш|invitation\s+status'),
 ('invitation.respond', r'\b(?:прими|отклони)\b.{0,40}приглаш|accept\s+invitation|decline\s+invitation'),
 ('contacts.manage', r'контакт|адресн.{0,10}книг|\bcontacts?\b'),
 ('places.manage', r'сохрани.{0,35}(?:место|адрес)|мои\s+места|saved\s+places'),
 ('reminder.manage', r'напомни|напоминан|remind'),
 ('settings.manage', r'настрой|часов.{0,10}пояс|голосов.{0,20}ответ|settings|timezone'),
 ('integration.manage', r'подключ|синхронизац|google|sync|connect'),
 ('history.read', r'истори[яию]|журнал|логи|\bhistory\b'),
 ('help', r'что\s+ты\s+умеешь|\bhelp\b|помощь'),
 ('feedback', r'не\s+работает|почему\s+ты|неправильно|ошибк|сломал|жалоб|\bbug\b'),
 ('smalltalk', r'^(?:привет|спасибо|благодарю|hi|hello|thanks)[!. ]*$'),
]

def pseudonym(value: str, key: bytes, kind: str) -> str:
    digest = hmac.new(key, (kind + ':' + value.casefold()).encode(), hashlib.sha256).hexdigest()[:16]
    return f'[{kind}_{digest}]'

def _looks_like_calendar_date(value: str) -> bool:
    """Mirror the bot's own NUMERIC_DATE_CANDIDATE_RE day-first convention
    (src/bot/handlers/group-message-filter.ts) so a real DD-MM(-YYYY) date the
    bot itself would parse never gets destroyed as a fake phone number.
    """
    iso = re.fullmatch(r'\d{4}-\d{2}-\d{2}', value)
    if iso:
        try:
            dt.date.fromisoformat(value)
            return True
        except ValueError:
            return False
    day_month = re.fullmatch(r'(\d{1,2})-(\d{1,2})(?:-\d{2,4})?', value)
    if day_month:
        day, month = int(day_month[1]), int(day_month[2])
        return 1 <= day <= 31 and 1 <= month <= 12
    return False

def redact_candidate(text: str, key: bytes, lexicon: dict[str, str] | None = None) -> str:
    if AUTH.search(text):
        return QUARANTINED_AUTH_MARKER
    rules = [('URL', r'https?://[^\s<>"\x27]+'), ('EMAIL', r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}'), ('HANDLE', r'(?<!\w)@[A-Za-z0-9_]+'), ('COORD', r'(?<!\d)-?\d{1,3}\.\d{3,}(?!\d)'), ('NUMBER', r'(?<!\w)\+?\d[\d ()-]{5,}\d(?!\w)')]
    for kind, pattern in rules:
        def replace(match):
            value = match[0]
            if kind == 'NUMBER' and _looks_like_calendar_date(value):
                return value
            return pseudonym(value, key, kind)
        text = re.sub(pattern, replace, text)
    for name, kind in sorted((lexicon or {}).items(), key=lambda entry: -len(entry[0])):
        if len(name.strip()) >= 2:
            text = re.sub(r'(?<!\w)' + re.escape(name) + r'(?!\w)', lambda m: pseudonym(m[0], key, kind), text, flags=re.I)
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
        opens_auth_window(row.get('text', ''))
        or (row.get('response') is not None and opens_auth_window(row['response']))
        or bool(row.get('auth_context'))
    )

def _near_auth_markers(rows: list[dict]) -> set[int]:
    """Every row of the conversation within SESSION_GAP_SECONDS (the wizard's idle expiry) of an auth marker."""
    markers: dict[str, list[float]] = collections.defaultdict(list)
    for row in rows:
        if _is_auth_marker(row):
            markers[row['scope']].append(row['at'])
    for times in markers.values():
        times.sort()
    near = set()
    for index, row in enumerate(rows):
        times = markers.get(row['scope'], [])
        at = bisect.bisect_left(times, row['at'] - SESSION_GAP_SECONDS)
        if at < len(times) and times[at] <= row['at'] + SESSION_GAP_SECONDS:
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
    for index in sorted(range(len(rows)), key=lambda i: (rows[i]['scope'], rows[i]['at'], i)):
        scope = rows[index]['scope']
        from_user = rows[index].get('role', 'user') == 'user'
        may_be_prompt = not from_user and index in near_marker  # every auth marker is near itself
        if from_user:
            answer_turn.discard(scope)
        if may_be_prompt:
            awaiting_answer.add(scope)
        elif from_user and scope in awaiting_answer and user_text(rows[index].get('text', ''))[1] != 'button':
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
        text = row.get('text', '')
        return (row['scope'], text.strip()) if isinstance(text, str) and text.strip() else None
    quarantined = {same_text(rows[index]) for index in blocked if rows[index].get('role', 'user') == 'user'}
    quarantined.discard(None)
    return {index for index, row in enumerate(rows) if same_text(row) in quarantined}

NAME_RE = re.compile('[a-z_]{1,80}')  # a tool name or a chat_history role

def _is_id(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)

def _is_name(value: object) -> bool:
    return isinstance(value, str) and NAME_RE.fullmatch(value) is not None

def _is_tool_result(value: object) -> bool:
    return isinstance(value, (list, tuple)) and len(value) == 2 and _is_name(value[0]) and value[1] in ('OK', 'ERROR')

# Free text a raw-export row carries, with its shape; each value goes through redact_candidate.
# `content` is required.
EXPORT_TEXT_FIELDS = {
    'content': lambda value: isinstance(value, str),
    'response': lambda value: value is None or isinstance(value, str),
}
# The identifiers, times and structure a later --merge needs, each with the only shape collect() and
# load_merge_archive() give it. Any other field is dropped from the raw export.
EXPORT_STRUCTURE_FIELDS = {
    'id': _is_id,
    'user_id': _is_id,
    'chat_id': lambda value: value is None or _is_id(value),
    'role': _is_name,
    'created_at': lambda value: isinstance(value, str),
    'record_kind': lambda value: value == 'debug_run',
    'partial': lambda value: isinstance(value, bool),
    'tools': lambda value: isinstance(value, list) and all(_is_name(name) for name in value),
    'tool_results': lambda value: isinstance(value, list) and all(_is_tool_result(result) for result in value),
    'source_refs': lambda value: isinstance(value, list) and all(isinstance(ref, str) for ref in value),
}

EXPORT_FIELDS = EXPORT_TEXT_FIELDS | EXPORT_STRUCTURE_FIELDS

def _has_export_shape(row: dict) -> bool:
    return 'content' in row and all(check(row[field]) for field, check in EXPORT_FIELDS.items() if field in row)

def place_rows(rows: list[dict]) -> tuple[list[dict], int]:
    """The rows with their conversation scope, instant and text, sorted by conversation and time, and
    the number of rows whose timestamp or ids cannot be read."""
    placed = []
    unplaced = 0
    for row in rows:
        try:
            value = row['created_at'].replace(' ','T')
            instant = dt.datetime.fromisoformat(value.replace('Z','+00:00'))
            if instant.tzinfo is None: instant = instant.replace(tzinfo=dt.timezone.utc)
            scope = f"{row['user_id']}:{row.get('chat_id') or row['user_id']}"
            placed.append(dict(row, scope=scope, at=instant.timestamp(), text=row.get('content','')))
        except (ValueError,KeyError,TypeError,AttributeError): unplaced += 1
    placed.sort(key=lambda row:(row['scope'], row['at'],row.get('id',0)))
    return placed, unplaced

def raw_export(rows: list[dict], key: bytes, lexicon: dict[str, str]) -> tuple[list[dict], dict[str, int]]:
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
        safe = {field: row[field] for field in EXPORT_STRUCTURE_FIELDS if field in row}
        for field in EXPORT_TEXT_FIELDS:
            if isinstance(row.get(field), str):
                safe[field] = redact_candidate(row[field], key, lexicon)
            elif field in row:
                safe[field] = None
        exported.append(safe)
    return exported, {'raw_export_quarantined_rows': len(blocked), 'raw_export_omitted_rows': unplaced + misshapen}

GOLD_REVIEW_DIMENSIONS = ('privacy', 'intent', 'slots', 'expected_outcome')
GOLD_REVIEW_STATUSES = {'approved', 'rejected', 'needs_more_info'}
GOLD_REQUIRED_FIELDS = {'source_ref', 'corpus_candidate_sha256', 'intent', 'slots', 'expected_outcome', 'reviews'}
# One dotted or bare lowercase intent label (e.g. 'event.create'); rejects a
# compound multi-operation intent encoded as one string. See "Gold import"
# in docs/reference/nlu-corpus-methodology.md for the full rationale.
SINGLE_INTENT_RE = re.compile(r'^[a-z][a-z_]*(?:\.[a-z][a-z_]*)?$')

class GoldReview(TypedDict):
    reviewer_id: str
    status: Literal['approved', 'rejected', 'needs_more_info']

class GoldLabel(TypedDict):
    intent: str
    slots: dict[str, str]
    expected_outcome: str
    reviews: dict[str, GoldReview]  # one independent entry per GOLD_REVIEW_DIMENSIONS

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

def validate_gold_record(record: dict) -> None:
    """Reject anything but an independently adjudicated, corpus-bound gold row.

    Never called to manufacture a label: this only rejects or accepts a record an
    external reviewer already produced. Each of privacy/intent/slots/expected_outcome
    needs its own reviewer identity and status; a single blanket status is rejected.
    """
    missing = GOLD_REQUIRED_FIELDS - record.keys()
    if missing:
        raise ValueError(f'gold record missing required fields: {sorted(missing)}')
    if not isinstance(record.get('source_ref'), str) or not record['source_ref']:
        raise ValueError('gold record source_ref must be a non-empty string')
    corpus_sha256 = record.get('corpus_candidate_sha256')
    if not isinstance(corpus_sha256, str) or not re.fullmatch(r'[0-9a-f]{64}', corpus_sha256):
        raise ValueError('gold record corpus_candidate_sha256 must be a 64-character hex sha256 digest')
    if not isinstance(record.get('intent'), str) or not record['intent']:
        raise ValueError('gold record intent must be a non-empty string, never inferred or left unset')
    if not SINGLE_INTENT_RE.fullmatch(record['intent']):
        raise ValueError(f'gold record intent {record["intent"]!r} is not a single supported intent label; a compound/multi-operation request must be rejected as unsupported in this bounded scope, never squeezed into one label')
    slots = record.get('slots')
    if not isinstance(slots, dict):
        raise ValueError('gold record slots must be a mapping')
    for slot_key, slot_value in slots.items():
        if not isinstance(slot_key, str) or not isinstance(slot_value, str):
            raise ValueError(f'gold record slots must be a str-to-str mapping, got key {slot_key!r} -> value {slot_value!r}')
    if not isinstance(record.get('expected_outcome'), str) or not record['expected_outcome']:
        raise ValueError('gold record expected_outcome must be a non-empty string, never inferred from bot prose')
    reviews = record.get('reviews')
    if not isinstance(reviews, dict):
        raise ValueError('gold record reviews must be a mapping')
    missing_dimensions = set(GOLD_REVIEW_DIMENSIONS) - reviews.keys()
    if missing_dimensions:
        raise ValueError(f'gold record missing independent review dimensions: {sorted(missing_dimensions)}')
    for dimension in GOLD_REVIEW_DIMENSIONS:
        review = reviews[dimension]
        if not isinstance(review, dict) or not isinstance(review.get('reviewer_id'), str) or not review['reviewer_id']:
            raise ValueError(f'gold record {dimension} review needs a non-empty reviewer_id')
        if review.get('status') not in GOLD_REVIEW_STATUSES:
            raise ValueError(f'gold record {dimension} review has an unknown status: {review.get("status")!r}')

def apply_gold_import(candidates: list[dict], gold_records: list[dict], expected_corpus_sha256: str) -> tuple[list[dict], dict]:
    """Bind independently adjudicated gold onto matching candidates. Never fabricates a label.

    train_eligible only becomes true when every one of the four independent review
    dimensions is individually approved; a partial approval or a corpus-hash mismatch
    leaves the candidate as-is except for a bookkeeping label_status. A candidate the
    corpus itself already quarantined (privacy_status=='quarantined' or a redacted
    text_candidate) is a hard privacy gate: a caller-supplied approval is an external
    assertion about the record's content, not proof this script re-adjudicated the
    quarantine, so it can never override it.
    """
    by_ref = {candidate.get('source_ref'): candidate for candidate in candidates}
    fully_approved = 0
    partial_or_rejected = 0
    rejected_unknown_source = 0
    rejected_corpus_mismatch = 0
    rejected_source_quarantined = 0
    for record in gold_records:
        validate_gold_record(record)
        if record['corpus_candidate_sha256'] != expected_corpus_sha256:
            rejected_corpus_mismatch += 1
            continue
        candidate = by_ref.get(record['source_ref'])
        if candidate is None:
            rejected_unknown_source += 1
            continue
        if candidate.get('privacy_status') == 'quarantined' or candidate.get('text_candidate') == QUARANTINED_AUTH_MARKER:
            rejected_source_quarantined += 1
            candidate['label_status'] = 'gold_rejected_source_quarantined'
            candidate['gold_adjudication'] = None
            candidate['gold'] = None
            candidate['train_eligible'] = False
            continue
        all_approved = all(record['reviews'][dimension]['status'] == 'approved' for dimension in GOLD_REVIEW_DIMENSIONS)
        adjudication = {'intent': record['intent'], 'slots': record['slots'], 'expected_outcome': record['expected_outcome'], 'reviews': record['reviews']}
        candidate['gold_adjudication'] = adjudication
        candidate['gold'] = adjudication if all_approved else None
        candidate['label_status'] = 'gold_approved' if all_approved else 'gold_partial_or_rejected'
        candidate['train_eligible'] = all_approved
        if all_approved:
            fully_approved += 1
        else:
            partial_or_rejected += 1
    return candidates, {'gold_fully_approved': fully_approved, 'gold_partial_or_rejected_recorded': partial_or_rejected, 'gold_rejected_unknown_source': rejected_unknown_source, 'gold_rejected_corpus_mismatch': rejected_corpus_mismatch, 'gold_rejected_source_quarantined': rejected_source_quarantined}

def suggest_labels(text: str) -> list[str]:
    text = text.strip()
    if re.match(r'^(?:я\s+)?не\s+(?:могу|получается|выходит|удаётся|удается)\b', text, re.I):
        return ['feedback']  # an inability complaint, not a request for the action it names
    if re.match(r'^(?:не\s+(?:создавай|удаляй|приглашай|отменяй)|do\s+not|don.t)\b', text, re.I):
        return ['dialogue.rejection']
    command = re.match(r'^/([a-z_]+)(?:@\w+)?(?:\s|$)', text, re.I)
    if command:
        return [COMMANDS.get(command[1].lower(), 'command.other')]
    if re.fullmatch(r'(?:да|нет|ага|ок|окей|yes|no|ok|\d{1,2}(?::\d{2})?)[.! ]*', text, re.I):
        return ['dialogue.answer']
    return [label for label, pattern in RULES if re.search(pattern, text, re.I)] or ['unknown']

def candidate_record(text: str, tools: list[str], key: bytes, lexicon=None) -> CandidateRecord:
    text_candidate = redact_candidate(text, key, lexicon)
    # A candidate whose own text was replaced by the auth marker is a source
    # privacy quarantine, not merely "needs review" -- apply_gold_import's
    # hard gate relies on this field being honest regardless of what a
    # caller-supplied gold import later claims about it.
    privacy_status = 'quarantined' if text_candidate == QUARANTINED_AUTH_MARKER else 'pseudonymized_candidate_needs_review'
    return {'schema_version': SCHEMA_VERSION, 'text_candidate': text_candidate, 'intent_candidates': suggest_labels(text), 'observed_tools': list(dict.fromkeys(tools)), 'gold': None, 'gold_adjudication': None, 'train_eligible': False, 'label_status': 'needs_adjudication', 'privacy_status': privacy_status, 'outcome_status': 'not_inferred_from_prose'}

def parse_debug_runs(text: str) -> list[dict]:
    header = re.compile(r'^\[([^\n]+)\]\nCHAT: (-?\d+)[^\n]*\| USER: uid:(\d+)[^\n]*\nSUPPLEMENT: (true|false)\nMESSAGE: ', re.M)
    matches = list(header.finditer(text))
    runs = []
    for index, match in enumerate(matches):
        block = text[match.end():matches[index+1].start() if index+1 < len(matches) else len(text)]
        message = re.split(r'\n={40,}|\n## AUTO-RESPONSE', block, maxsplit=1)[0].strip()
        if match[4] == 'true':
            continue  # Supplement is not a new user request.
        final = re.search(r'^Response \(\d+ chars\):\n([\s\S]*?)(?:\n={40,}|$)', block, re.M)
        runs.append({'user_id':int(match[3]), 'chat_id':int(match[2]), 'created_at':match[1], 'role':'user', 'content':message, 'record_kind':'debug_run', 'tools':re.findall(r'^TOOL CALL: ([a-z_]+)$',block,re.M), 'tool_results':re.findall(r'^TOOL RESULT: ([a-z_]+) → (OK|ERROR)$',block,re.M), 'response':final[1].strip() if final else None, 'partial':True,
                     'auth_context':opens_auth_window(block)})  # the logged history may hold a wizard prompt the message answered
    return runs

def read_database(path: Path) -> tuple[list[dict], dict[str,str]]:
    conn = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA query_only=ON'); conn.execute('BEGIN')
    try:
        cols = {row[1] for row in conn.execute('PRAGMA table_info(chat_history)')}
        if not {'id','user_id','role','content','created_at'} <= cols:
            return [], {}
        chat = 'chat_id' if 'chat_id' in cols else 'NULL AS chat_id'
        rows = [dict(row) for row in conn.execute('SELECT id,user_id,role,content,created_at,' + chat + ' FROM chat_history ORDER BY id')]
        lexicon = {}
        for table, column, kind in [('users','first_name','PERSON'),('contacts','name','PERSON'),('contacts','preferred_name','PERSON'),('events','location','PLACE')]:
            if column in {row[1] for row in conn.execute(f'PRAGMA table_info({table})')}:
                for row in conn.execute(f'SELECT DISTINCT {column} FROM {table} WHERE {column} IS NOT NULL'):
                    if isinstance(row[0],str) and len(row[0].strip()) >= 2: lexicon[row[0]] = kind
        return rows, lexicon
    finally:
        conn.rollback(); conn.close()

def row_key(row: dict) -> str:
    selected = {k: row.get(k) for k in ('id','user_id','chat_id','role','content','created_at')}
    return hashlib.sha256(json.dumps(selected,sort_keys=True,ensure_ascii=False).encode()).hexdigest()

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
    if hasattr(os, 'O_NOFOLLOW'):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('not_a_regular_file')
        if info.st_size > max_bytes:
            raise ValueError('oversized_source')
        return fd
    except BaseException:
        os.close(fd)
        raise

def _is_gzip_source(path: Path) -> bool:
    return path.suffix == '.gz'

def _is_wal_sidecar(path: Path) -> bool:
    """A `-wal`/`-shm`/`-journal` companion is never its own SQLite database
    (see "Input bounds" in docs/reference/nlu-corpus-methodology.md)."""
    return path.name.endswith(('-wal', '-shm', '-journal'))

def collect(root: Path) -> tuple[list[dict], list[dict], dict[str,str]]:
    rows: dict[str,dict] = {}; sources = []; lexicon = {}
    data = root / 'data'
    databases = sorted(
        path for path in (set(data.glob('*.db')) | set(data.glob('*.db.pre-*')) | set((data/'backups').glob('*.db')) | set((data/'backups').glob('*.db.gz')))
        if not _is_wal_sidecar(path)
    )
    for path in databases:
        source = {'kind':'sqlite','name':str(path.relative_to(root))}
        if not is_safe_source_file(path, root):
            source.update(status='skipped_unsafe_path', rows=0)
            sources.append(source)
            continue
        try:
            fd = open_regular_bounded(path, MAX_DATABASE_BYTES)
            if _is_gzip_source(path):
                with os.fdopen(fd, 'rb') as raw_stream, tempfile.NamedTemporaryFile(suffix='.db') as temporary:
                    opener = gzip.GzipFile(fileobj=raw_stream)
                    total = 0
                    while chunk := opener.read(1024*1024):
                        total += len(chunk)
                        if total > MAX_DATABASE_BYTES: raise ValueError('oversized_database')
                        temporary.write(chunk)
                    temporary.flush()
                    extracted, names = read_database(Path(temporary.name))
            else:
                # fd above already proved (O_NOFOLLOW+fstat) this path was a
                # bounded regular file, not a symlink. SQLite must reopen by
                # path to locate sibling -wal/-shm files, so it can combine
                # committed-but-uncheckpointed WAL rows correctly without a
                # checkpoint/write against a read-only source; this narrows
                # the no-follow guarantee to a standard path-based open, and
                # bounds the -wal/-shm siblings the same way before SQLite
                # reads them. See docs/reference/nlu-corpus-methodology.md
                # ("Input bounds") for the full rationale.
                os.close(fd)
                for sidecar_suffix in ('-wal', '-shm'):
                    try:
                        sidecar_fd = open_regular_bounded(path.with_name(path.name + sidecar_suffix), MAX_DATABASE_BYTES)
                        os.close(sidecar_fd)
                    except FileNotFoundError:
                        pass
                extracted, names = read_database(path)
            lexicon.update(names)
            digests = [row_key(row) for row in extracted]
            logical_sha256 = hashlib.sha256(''.join(digests).encode()).hexdigest()
            lineage_ref = f"{source['name']}#{logical_sha256}"  # hash-qualified so two snapshots that share a path never look like one lineage
            for row, digest in zip(extracted, digests):
                rows.setdefault(digest,dict(row, source_refs=[]))['source_refs'].append(lineage_ref)
            source.update(status='read',rows=len(extracted),logical_sha256=logical_sha256)
        except (OSError, sqlite3.Error, ValueError) as error:
            source.update(status='unreadable',error=type(error).__name__)
        sources.append(source)
    for path in sorted((root/'logs').rglob('*')):
        if not path.is_file() or not (path.name.endswith('.log') or path.name.endswith('.log.gz')): continue
        source = {'kind':'debug_log','name':str(path.relative_to(root))}
        if not is_safe_source_file(path, root):
            source.update(status='skipped_unsafe_path', rows=0)
            sources.append(source)
            continue
        try:
            fd = open_regular_bounded(path, MAX_LOG_BYTES)
            with os.fdopen(fd, 'rb') as raw_stream:
                stream = gzip.GzipFile(fileobj=raw_stream) if _is_gzip_source(path) else raw_stream
                raw = stream.read(MAX_LOG_BYTES+1)
            if len(raw)>MAX_LOG_BYTES: raise ValueError('oversized_log')
            runs = parse_debug_runs(raw.decode('utf-8', errors='replace'))
            source.update(status='read' if runs else 'no_direct_dialogues',rows=len(runs),sha256=hashlib.sha256(raw).hexdigest())
            for index, row in enumerate(runs):
                key = 'log:'+row_key(row)
                rows.setdefault(key,dict(row,source_refs=[]))['source_refs'].append(source['name']+':'+str(index))
        except (OSError,ValueError,EOFError) as error:
            source.update(status='unreadable',error=type(error).__name__)
        sources.append(source)
    return list(rows.values()), sources, lexicon

def user_text(content: str) -> tuple[str,str]:
    try: parsed = json.loads(content)
    except (ValueError,TypeError): return content, 'text'
    if isinstance(parsed,dict):
        kind = parsed.get('kind','text')
        if kind=='command': return str(parsed.get('name',''))+' '+str(parsed.get('args','')), kind
        if kind=='button': return str(parsed.get('label','')), kind
        if isinstance(parsed.get('text'),str): return parsed['text'], str(kind)
    return content, 'structured_unknown'

def observed_tools(content: str) -> list[str]:
    try: parsed = json.loads(content)
    except (ValueError,TypeError): return []
    stack = [parsed]; names = []
    while stack:
        value=stack.pop()
        if isinstance(value,list): stack.extend(value)
        elif isinstance(value,dict):
            if value.get('type')=='function' and isinstance(value.get('function'),dict): names.append(value['function'].get('name',''))
            if value.get('type')=='tool_use': names.append(value.get('name',''))
            stack.extend(v for v in value.values() if isinstance(v,(dict,list)))
    return [name for name in names if _is_name(name)]

def audit(rows: list[dict], key: bytes, lexicon: dict[str,str]) -> tuple[list[dict],dict]:
    normalized, bad_time = place_rows(rows)
    blocked = quarantined_indices(normalized)
    candidates = []; active = {}; active_lineage: dict[str, frozenset[str]] = {}; active_since: dict[str, float] = {}; sessions = {}; turn_times = {}
    detached_unknown_provenance = 0
    detached_stale_session = 0
    for index, row in enumerate(normalized):
        scope=row['scope']
        if row['at']-turn_times.get(scope, float('-inf')) > SESSION_GAP_SECONDS:
            sessions[scope]=row_key(row)
            active.pop(scope,None); active_lineage.pop(scope,None); active_since.pop(scope,None)  # a new session must never inherit a stale open request
        turn_times[scope]=row['at']
        if index in blocked:
            active.pop(scope,None); active_lineage.pop(scope,None); active_since.pop(scope,None); continue
        lineage = frozenset(row.get('source_refs') or [])
        if row['role']=='user':
            text,kind=user_text(row['content'])
            candidate=candidate_record(text,row.get('tools',[]),key,lexicon)
            candidate.update(source_kind=row.get('record_kind','database'), input_kind=kind, source_ref=pseudonym(row_key(row),key,'ROW'), actor_scope=pseudonym(scope,key,'SCOPE'), conversation_id=pseudonym(sessions[scope],key,'CONVERSATION'), source_refs=[pseudonym(ref,key,'SOURCE') for ref in row.get('source_refs',[])], timestamp=row['created_at'], historical_state='not_reconstructed', observed_responses=[])
            if kind=='button': candidate['intent_candidates']=['dialogue.answer']
            candidates.append(candidate)
            if row.get('record_kind')!='debug_run':
                active[scope]=candidate
                active_lineage[scope]=lineage
                active_since[scope]=row['at']  # anchored to this exact request, never pushed forward by later non-user rows
            elif row.get('response'): candidate['observed_responses'].append(redact_candidate(row['response'],key,lexicon))
        elif scope in active and row.get('record_kind')!='debug_run':
            if row['at'] - active_since.get(scope, float('-inf')) > SESSION_GAP_SECONDS:
                detached_stale_session += 1
                active.pop(scope,None); active_lineage.pop(scope,None); active_since.pop(scope,None)
                continue  # a chain of short gaps must never bridge past 1800s from the actual triggering request
            if not (active_lineage.get(scope, frozenset()) & lineage):
                detached_unknown_provenance += 1
                continue  # different or unrecorded snapshot lineage: never stitch it into this candidate's causal turn
            candidate=active[scope]
            candidate['observed_tools']=list(dict.fromkeys(candidate['observed_tools']+observed_tools(row['content'])))
            candidate['observed_responses'].append({'role':row['role'],'content_candidate':redact_candidate(row['content'],key,lexicon)})
    counts = collections.Counter(label for row in candidates for label in row['intent_candidates'])
    summary = {'retained_rows':len(rows), 'invalid_timestamp_rows':bad_time, 'quarantined_auth_rows':len(blocked), 'evidence_detached_unknown_provenance_rows':detached_unknown_provenance, 'evidence_detached_stale_session_rows':detached_stale_session, 'user_candidates':len(candidates), 'candidates_by_source':dict(collections.Counter(row['source_kind'] for row in candidates)), 'candidate_label_counts':dict(counts.most_common()), 'observed_tool_counts':dict(collections.Counter(tool for row in candidates for tool in row['observed_tools']).most_common()), 'gold_count':0, 'train_eligible':0, 'raw_content_published':False, 'limitations':['Candidate labels are unvalidated hypotheses, not accuracy or gold.', 'Privacy transformation is pseudonymization; every free-text record still needs review.', 'Database and debug user records may overlap; source counts are not unique Telegram updates.', 'Historical permissions, entity state and timezone are not reconstructed.', 'Auth-window quarantine is conservative and not a substitute for fixing the ingress logging issue.', 'Assistant/tool rows attach to a candidate only when they share a recorded source-file lineage with the triggering request and arrive within 1800s of that exact request (not a chained series of short gaps); everything else is counted separately instead of being stitched across snapshots or stale windows.']}
    return candidates, summary

def _restricted_stream(path: Path, binary: bool):
    """Create-with-mode in one syscall: never a window where the file has wider-than-owner bits."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    return os.fdopen(fd, 'wb') if binary else os.fdopen(fd, 'w', encoding='utf-8')

def private_json(path: Path, value) -> None:
    with _restricted_stream(path, binary=False) as stream:
        json.dump(value, stream, ensure_ascii=False)

def private_bytes(path: Path, value: bytes) -> None:
    with _restricted_stream(path, binary=True) as stream:
        stream.write(value)

def load_merge_archive(content, archive_digest: str) -> tuple[list[dict], list[dict], dict[str, str]]:
    """Load one --merge input. Refuses a shape this run cannot trust to pair correctly.

    A dict archive is a prior selected.private.json: its rows already carry
    content-hash-qualified lineage refs from their own collect() run, so it is only
    checked for a matching SCHEMA_VERSION. A legacy pre-versioning list archive
    predates lineage tracking entirely, so every row is forced to a lineage marker
    unique to this archive AND this row position -- it can never be treated as
    matching anything, including another row from the very same archive.
    """
    if isinstance(content, dict) and 'rows' in content:
        version = content.get('schema_version')
        if version != SCHEMA_VERSION:
            raise ValueError(f'incompatible merge schema_version {version!r}, expected {SCHEMA_VERSION}')
        return list(content['rows']), list(content.get('sources', [])), dict(content.get('lexicon', {}))
    if isinstance(content, list) and all(isinstance(row, dict) and 'row' in row for row in content):
        rows = []
        for position, entry in enumerate(content):
            names = entry.get('sources') or ['unknown']
            refs = [f'legacy:{archive_digest}:row{position}:{name}' for name in names]
            rows.append(dict(entry['row'], source_refs=refs))
        return rows, [], {}
    raise ValueError('Unsupported archive schema')

def read_bounded_merge_archive(path: Path, max_bytes: int = MAX_DATABASE_BYTES) -> bytes:
    """Read one --merge input under the same O_NOFOLLOW+fstat guard collect() uses.

    The read itself, not just the open-time fstat, is bounded: fstat only
    reflects the file's size at open time, so a file that grows afterward
    (still the same inode, same fd) must not be allowed to make this read
    unbounded.
    """
    fd = open_regular_bounded(path, max_bytes)
    with os.fdopen(fd, 'rb') as stream:
        raw = stream.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise ValueError('merge_archive_oversized')
    return raw

def main() -> None:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--merge',type=Path,action='append',default=[])
    args=parser.parse_args()
    args.out.mkdir(parents=True,exist_ok=False,mode=0o700)
    key=os.urandom(32)
    private_bytes(args.out/'pseudonym.key', key)
    rows,sources,lexicon=collect(args.root)
    for path in args.merge:
        raw_bytes=read_bounded_merge_archive(path)
        content=json.loads(raw_bytes)
        archive_digest=hashlib.sha256(raw_bytes).hexdigest()
        merged_rows,merged_sources,merged_lexicon=load_merge_archive(content,archive_digest)
        rows.extend(merged_rows); lexicon.update(merged_lexicon)
        if isinstance(content,dict): sources.extend(merged_sources)
        else: sources.append({'kind':'retained_archive','name':path.name,'rows':len(content),'status':'read','sha256':archive_digest})
    distinct = {}
    for row in rows:
        identity = row.get('record_kind','database')+':'+row_key(row)
        if identity in distinct:
            distinct[identity]['source_refs']=list(dict.fromkeys(distinct[identity].get('source_refs',[])+row.get('source_refs',[])))
        else:
            distinct[identity]=row
    rows=list(distinct.values())
    exported, export_counts = raw_export(rows, key, lexicon)
    private_json(args.out/'selected.private.json',{'rows':exported,'sources':sources,'lexicon':lexicon,'schema_version':SCHEMA_VERSION})
    candidates,summary=audit(rows,key,lexicon)
    private_json(args.out/'candidates.private.json',candidates)
    summary.update(export_counts, schema_version=SCHEMA_VERSION, captured_at=dt.datetime.now(dt.timezone.utc).isoformat(), source_count=len(sources))
    summary['source_states']=dict(collections.Counter(source['status'] for source in sources))
    summary['source_kinds']=dict(collections.Counter(source['kind'] for source in sources))
    summary['candidate_sha256']=hashlib.sha256((args.out/'candidates.private.json').read_bytes()).hexdigest()
    private_json(args.out/'summary.json',summary)
    print(json.dumps(summary,ensure_ascii=False,indent=2))

if __name__ == '__main__':
    main()
