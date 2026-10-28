"""Characterization of scripts/nlu_corpus.py branches the main suite leaves uncovered.

These pin audit(), collect(), read_database(), raw_export(), observed_tools(),
validate_gold_record() and apply_gold_import() so the complexity refactor (GH-860) cannot
change their behavior. Whole-output goldens live in fixtures/nlu_corpus_characterization.json.
"""

import copy
import gzip
import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "nlu_corpus_characterized", ROOT / "scripts" / "nlu_corpus.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
GOLDEN_PATH = (
    pathlib.Path(__file__).resolve().parent / "fixtures" / "nlu_corpus_characterization.json"
)

KEY = b"k" * 32
REF_A = ["a.db#h1"]
REF_B = ["b.db#h2"]
SHA = "a" * 64


def _row(row_id, role, content, at, user=1, chat=None, **extra):
    return dict(
        id=row_id, user_id=user, chat_id=chat, role=role, content=content, created_at=at, **extra
    )


AUDIT_ROWS = [
    _row(1, "user", "Создай встречу завтра", "2026-01-01T10:00:00Z", source_refs=REF_A),
    _row(
        2,
        "assistant",
        json.dumps([{"type": "function", "function": {"name": "create_event"}}]),
        "2026-01-01T10:00:05Z",
        source_refs=REF_A,
    ),
    _row(3, "assistant", "Готово", "2026-01-01T10:00:10Z", source_refs=REF_B),
    _row(4, "assistant", "late bot", "2026-01-01T10:45:00Z", source_refs=REF_A),
    _row(
        5,
        "user",
        json.dumps({"kind": "button", "label": "Да"}),
        "2026-01-01T10:46:00Z",
        source_refs=REF_A,
    ),
    _row(
        6,
        "assistant",
        json.dumps({"type": "tool_use", "name": "confirm_it"}),
        "2026-01-01T10:46:05Z",
        source_refs=REF_A,
    ),
    _row(
        7,
        "user",
        json.dumps({"kind": "command", "name": "/today", "args": ""}),
        "2026-01-01T10:47:00Z",
        source_refs=REF_A,
    ),
    _row(8, "user", "Hello", "2026-01-01T10:00:00Z", user=2, chat=9, source_refs=REF_A),
    _row(
        9,
        "assistant",
        "Hi there user@example.invalid",
        "2026-01-01T10:00:02Z",
        user=2,
        chat=9,
        source_refs=REF_A,
    ),
    _row(10, "user", "/connect_telegram", "2026-01-01T12:00:00Z", source_refs=REF_A),
    _row(11, "assistant", "Enter code", "2026-01-01T12:00:05Z", source_refs=REF_A),
    _row(12, "user", "Покажи расписание", "2026-01-01T15:00:00Z", source_refs=REF_A),
    _row(
        13,
        "user",
        "Пригласи Ивана",
        "2026-01-01T15:00:30Z",
        record_kind="debug_run",
        partial=True,
        tools=["find_x", "find_x"],
        response="Отправил Ивану",
        source_refs=["log:1"],
    ),
    _row(
        14,
        "user",
        "Что нового",
        "2026-01-01T15:01:00Z",
        record_kind="debug_run",
        partial=True,
        response=None,
        source_refs=["log:1"],
    ),
    _row(15, "assistant", "after debug", "2026-01-01T15:01:10Z", source_refs=REF_A),
    {"id": 16, "user_id": 3, "role": "user", "content": "bad time", "created_at": "nonsense"},
    _row(17, "user", "Удали встречу", "2026-01-01T16:00:00Z"),
    _row(18, "assistant", "no lineage", "2026-01-01T16:00:10Z"),
    _row(19, "user", "Найди событие", "2026-01-02T09:00:00Z", source_refs=REF_A),
    _row(20, "assistant", "step one", "2026-01-02T09:20:00Z", source_refs=REF_A),
    _row(21, "assistant", "step two", "2026-01-02T09:40:00Z", source_refs=REF_A),
    _row(22, "user", "Привет", "2026-01-02T09:41:00Z", source_refs=REF_A),
    _row(
        23,
        "assistant",
        json.dumps({"type": "function", "function": {"name": "greet_back"}}),
        "2026-01-02T09:41:10Z",
        source_refs=REF_A,
    ),
]
LEXICON = {"Ивана": "PERSON"}


def audit_output():
    candidates, summary = MODULE.audit(copy.deepcopy(AUDIT_ROWS), KEY, LEXICON)
    return {"candidates": candidates, "summary": summary}


DEBUG_RUN_TEMPLATE = (
    "[{stamp}]\nCHAT: {chat} | USER: uid:{user}\nSUPPLEMENT: {supplement}\nMESSAGE: {message}\n"
    "{calls}Response ({size} chars):\n{response}\n" + "=" * 40 + "\n"
)


def _debug_run(stamp, chat, user, message, response, supplement="false", tools=()):
    calls = "".join(f"TOOL CALL: {tool}\nTOOL RESULT: {tool} → OK\n" for tool in tools)
    return DEBUG_RUN_TEMPLATE.format(
        stamp=stamp,
        chat=chat,
        user=user,
        supplement=supplement,
        message=message,
        calls=calls,
        size=len(response),
        response=response,
    )


def _make_chat_db(path, rows, *, chat_id=True, extras=()):
    conn = sqlite3.connect(str(path))
    try:
        column = ", chat_id INTEGER" if chat_id else ""
        conn.execute(
            f"CREATE TABLE chat_history (id INTEGER PRIMARY KEY, user_id INTEGER, role TEXT, content TEXT, created_at TEXT{column})"
        )
        names = ["id", "user_id", "role", "content", "created_at"] + (
            ["chat_id"] if chat_id else []
        )
        for entry in rows:
            conn.execute(
                f"INSERT INTO chat_history ({','.join(names)}) VALUES ({','.join('?' * len(names))})",
                [entry.get(name) for name in names],
            )
        for statement, parameters in extras:
            conn.execute(statement, parameters)
        conn.commit()
    finally:
        conn.close()


DB_ROWS = [
    _row(1, "user", "Создай встречу завтра у Ивана", "2026-01-01 10:00:00", user=5, chat=5),
    _row(2, "assistant", "Готово", "2026-01-01 10:00:05", user=5, chat=5),
]
EXTRAS = [
    ("CREATE TABLE users (id INTEGER, first_name TEXT)", ()),
    ("INSERT INTO users VALUES (1, ?)", ("Иван",)),
    ("INSERT INTO users VALUES (2, ?)", ("A",)),
    ("INSERT INTO users VALUES (3, NULL)", ()),
    ("CREATE TABLE contacts (id INTEGER, name TEXT)", ()),
    ("INSERT INTO contacts VALUES (1, ?)", ("Мария",)),
    ("CREATE TABLE events (id INTEGER, location TEXT)", ()),
    ("INSERT INTO events VALUES (1, ?)", ("Парк Горького",)),
    ("INSERT INTO events VALUES (2, ?)", ("Иван",)),
]


def build_collect_tree(root):
    data = root / "data"
    backups = data / "backups"
    logs = root / "logs"
    (logs / "sub").mkdir(parents=True)
    backups.mkdir(parents=True)
    _make_chat_db(data / "main.db", DB_ROWS, extras=EXTRAS)
    _make_chat_db(
        data / "old.db.pre-migrate",
        DB_ROWS + [_row(3, "user", "Что нового", "2026-01-01 11:00:00", user=5, chat=5)],
    )
    _make_chat_db(
        data / "nochat.db",
        [_row(1, "user", "Привет", "2026-01-03 10:00:00", user=7)],
        chat_id=False,
    )
    conn = sqlite3.connect(str(data / "empty.db"))
    conn.execute("CREATE TABLE unrelated (x INTEGER)")
    conn.commit()
    conn.close()
    _make_chat_db(root / "plain.db", DB_ROWS)
    (backups / "snap.db.gz").write_bytes(gzip.compress((root / "plain.db").read_bytes(), mtime=0))
    (root / "plain.db").unlink()
    (backups / "corrupt.db").write_bytes(b"not a sqlite database" * 40)
    (backups / "huge.db.gz").write_bytes(gzip.compress(b"\0" * 400_000, mtime=0))
    (data / "link.db").symlink_to(data / "main.db")
    (logs / "a.log").write_text(
        _debug_run("2026-01-02 09:00:00", 5, 5, "Покажи расписание", "Вот", tools=["read_calendar"])
        + _debug_run("2026-01-02 09:01:00", 5, 5, "supplement text", "ignored", supplement="true"),
        encoding="utf-8",
    )
    (logs / "sub" / "b.log.gz").write_bytes(
        gzip.compress(
            _debug_run("2026-01-02 09:02:00", -100, 6, "Удали встречу", "Удалил").encode(), mtime=0
        )
    )
    (logs / "empty.log").write_text("nothing parseable here\n", encoding="utf-8")
    (logs / "notes.txt").write_text("ignored extension", encoding="utf-8")
    (logs / "bad.log.gz").write_bytes(b"not gzip at all")
    (logs / "trunc.log.gz").write_bytes(
        gzip.compress(_debug_run("2026-01-02 09:03:00", 5, 5, "x", "y").encode() * 50, mtime=0)[:60]
    )
    (logs / "big.log").write_text("x" * 5000, encoding="utf-8")
    (logs / "link.log").symlink_to(logs / "a.log")


def collect_output():
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        build_collect_tree(root)
        saved = MODULE.MAX_DATABASE_BYTES, MODULE.MAX_LOG_BYTES
        MODULE.MAX_DATABASE_BYTES, MODULE.MAX_LOG_BYTES = 100_000, 4096
        try:
            rows, sources, lexicon = MODULE.collect(root)
        finally:
            MODULE.MAX_DATABASE_BYTES, MODULE.MAX_LOG_BYTES = saved
    return {"rows": rows, "sources": sources, "lexicon": lexicon}


RAW_EXPORT_ROWS = [
    _row(
        1,
        "user",
        "Позвони +7 (999) 123-45-67 завтра",
        "2026-01-01 09:00:00",
        source_refs=REF_A,
        tools=["a_b"],
        tool_results=[["a_b", "OK"]],
        partial=True,
        record_kind="debug_run",
        response="Звоню Ивану",
        extra_field="dropped",
    ),
    _row(2, "user", "Ответ", "2026-01-01 09:01:00", source_refs=REF_A, response=None),
    _row(3, "user", "plain", "2026-01-01 09:02:00", chat=None),
    {"id": 4, "user_id": 1, "role": "user", "created_at": "2026-01-01 09:03:00"},  # no content
    _row(5, "user", "bad tool result", "2026-01-01 09:04:00", tool_results=[["a_b", "MAYBE"]]),
    _row(6, "user", "bad ref", "2026-01-01 09:05:00", source_refs=[3]),
    _row(7, "user", "bad bool", "2026-01-01 09:06:00", partial="yes"),
    _row(8, "user", "bad kind", "2026-01-01 09:07:00", record_kind="database"),
    _row(9, "user", "bad response", "2026-03-01 09:00:00", response=5),
    _row(10, "user", "Пароль: hunter2", "2026-05-01 09:00:00"),
    {
        "id": 11,
        "user_id": "x",
        "role": "user",
        "content": "bad id",
        "created_at": "2026-01-01 09:09:00",
    },
    _row(12, "user", "мой @handle и Иван", "2026-02-01 09:00:00", response="Иван пришёл"),
]


class RawExportTests(unittest.TestCase):
    def test_exports_kept_rows_redacts_text_and_counts_the_rest(self):
        exported, counts = MODULE.raw_export(
            copy.deepcopy(RAW_EXPORT_ROWS), KEY, {"Иван": "PERSON"}
        )
        by_id = {row["id"]: row for row in exported}
        self.assertEqual(
            sorted(by_id), [1, 2, 3, 12]
        )  # 9 holds an unreadable response and 10 a credential term: both open the auth window
        self.assertEqual(counts, {"raw_export_quarantined_rows": 2, "raw_export_omitted_rows": 6})
        self.assertNotIn("extra_field", by_id[1])
        self.assertEqual(
            set(by_id[1]),
            {
                "id",
                "user_id",
                "chat_id",
                "role",
                "created_at",
                "record_kind",
                "partial",
                "tools",
                "tool_results",
                "source_refs",
                "content",
                "response",
            },
        )
        self.assertRegex(by_id[1]["content"], r"^Позвони \[NUMBER_[0-9a-f]{16}\] завтра$")
        self.assertEqual(by_id[1]["response"], "Звоню Ивану")
        self.assertIsNone(by_id[2]["response"])
        self.assertNotIn("response", by_id[3])
        self.assertIsNone(by_id[3]["chat_id"])
        self.assertRegex(
            by_id[12]["content"], r"^мой \[HANDLE_[0-9a-f]{16}\] и \[PERSON_[0-9a-f]{16}\]$"
        )
        self.assertRegex(by_id[12]["response"], r"^\[PERSON_[0-9a-f]{16}\] пришёл$")

    def test_empty_input_exports_nothing(self):
        self.assertEqual(
            MODULE.raw_export([], KEY, {}),
            ([], {"raw_export_quarantined_rows": 0, "raw_export_omitted_rows": 0}),
        )


class ObservedToolsTests(unittest.TestCase):
    CASES = (
        ("not json", []),
        ("", []),
        ("null", []),
        ("5", []),
        ('"text"', []),
        ("{}", []),
        ('{"type":"function","function":{"name":"make_it"}}', ["make_it"]),
        ('{"type":"function","function":{}}', []),
        ('{"type":"function","function":"make_it"}', []),
        ('{"type":"function","function":{"name":"Bad-Name"}}', []),
        ('{"type":"function","function":{"name":5}}', []),
        ('{"type":"tool_use","name":"use_it"}', ["use_it"]),
        ('{"type":"tool_use"}', []),
        ('{"type":"tool_use","name":"UPPER"}', []),
        ('{"type":"other","name":"nope"}', []),
        (
            '[{"type":"tool_use","name":"first_one"},{"type":"tool_use","name":"second_one"}]',
            ["second_one", "first_one"],
        ),
        (
            '{"outer":{"type":"tool_use","name":"nested_tool"},"list":[{"type":"function","function":{"name":"deep_fn"}}]}',
            ["deep_fn", "nested_tool"],
        ),
        (
            '{"type":"tool_use","name":"top_one","input":{"type":"tool_use","name":"inner_one"}}',
            ["top_one", "inner_one"],
        ),
        (
            '{"type":"function","name":"ignored","function":{"name":"real_one"},"extra":[1,"s",null]}',
            ["real_one"],
        ),
        ('[[{"type":"tool_use","name":"in_list"}]]', ["in_list"]),
        ('{"a":1,"b":"c","d":null,"e":true}', []),
    )

    def test_extracts_tool_names_from_provider_shapes(self):
        for content, expected in self.CASES:
            with self.subTest(content=content):
                self.assertEqual(MODULE.observed_tools(content), expected)

    def test_non_string_content_is_not_an_error(self):
        self.assertEqual(MODULE.observed_tools(None), [])
        self.assertEqual(MODULE.observed_tools(b'{"type":"tool_use","name":"a_b"}'), ["a_b"])


class ReadDatabaseTests(unittest.TestCase):
    def _read(self, build):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "x.db"
            build(path)
            return MODULE.read_database(path)

    def test_reads_rows_ordered_by_id_with_chat_id_and_builds_the_lexicon(self):
        rows, lexicon = self._read(
            lambda path: _make_chat_db(path, list(reversed(DB_ROWS)), extras=EXTRAS)
        )
        self.assertEqual([row["id"] for row in rows], [1, 2])
        self.assertEqual(
            set(rows[0]), {"id", "user_id", "role", "content", "created_at", "chat_id"}
        )
        self.assertEqual(rows[0]["chat_id"], 5)
        self.assertEqual(lexicon, {"Иван": "PLACE", "Мария": "PERSON", "Парк Горького": "PLACE"})

    def test_missing_chat_id_column_reads_as_null(self):
        rows, lexicon = self._read(
            lambda path: _make_chat_db(
                path, [_row(1, "user", "x", "2026-01-01 10:00:00", user=2)], chat_id=False
            )
        )
        self.assertEqual(
            rows,
            [
                {
                    "id": 1,
                    "user_id": 2,
                    "role": "user",
                    "content": "x",
                    "created_at": "2026-01-01 10:00:00",
                    "chat_id": None,
                }
            ],
        )
        self.assertEqual(lexicon, {})

    def test_missing_chat_history_or_required_column_reads_as_empty(self):
        def no_table(path):
            conn = sqlite3.connect(str(path))
            conn.execute("CREATE TABLE other (x INTEGER)")
            conn.commit()
            conn.close()

        def short_table(path):
            conn = sqlite3.connect(str(path))
            conn.execute(
                "CREATE TABLE chat_history (id INTEGER, user_id INTEGER, role TEXT, content TEXT)"
            )
            conn.execute("CREATE TABLE users (first_name TEXT)")
            conn.execute("INSERT INTO users VALUES ('Анна')")
            conn.commit()
            conn.close()

        self.assertEqual(self._read(no_table), ([], {}))
        self.assertEqual(self._read(short_table), ([], {}))

    def test_lexicon_tables_without_the_expected_column_are_skipped_and_values_are_filtered(self):
        def build(path):
            _make_chat_db(
                path,
                DB_ROWS,
                extras=[
                    ("CREATE TABLE users (id INTEGER, nickname TEXT)", ()),
                    ("INSERT INTO users VALUES (1, ?)", ("Нет",)),
                    ("CREATE TABLE contacts (id INTEGER, name TEXT, preferred_name TEXT)", ()),
                    ("INSERT INTO contacts VALUES (1, ?, ?)", (" x ", "Вася")),
                    ("INSERT INTO contacts VALUES (2, ?, NULL)", (12345,)),
                    ("INSERT INTO contacts VALUES (3, ?, ?)", ("Оля", "  ")),
                ],
            )

        rows, lexicon = self._read(build)
        self.assertEqual(len(rows), 2)
        self.assertEqual(lexicon, {"Вася": "PERSON", "Оля": "PERSON", "12345": "PERSON"})

    def test_the_database_file_is_not_modified(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "x.db"
            _make_chat_db(path, DB_ROWS)
            before = path.read_bytes()
            MODULE.read_database(path)
            self.assertEqual(path.read_bytes(), before)

    def test_a_non_database_raises_sqlite_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "x.db"
            path.write_bytes(b"garbage" * 100)
            with self.assertRaises(sqlite3.DatabaseError):
                MODULE.read_database(path)


def _gold(**overrides):
    record = {
        "source_ref": "ref-1",
        "corpus_candidate_sha256": SHA,
        "intent": "event.create",
        "slots": {"title": "x"},
        "expected_outcome": "created",
        "reviews": {
            dimension: {"reviewer_id": f"r-{dimension}", "status": "approved"}
            for dimension in MODULE.GOLD_REVIEW_DIMENSIONS
        },
    }
    record.update(overrides)
    return record


class ValidateGoldRecordTests(unittest.TestCase):
    def _message(self, record):
        with self.assertRaises(ValueError) as caught:
            MODULE.validate_gold_record(record)
        return str(caught.exception)

    def test_a_complete_record_is_accepted(self):
        self.assertIsNone(MODULE.validate_gold_record(_gold()))
        self.assertIsNone(MODULE.validate_gold_record(_gold(slots={}, intent="help")))
        reviews = {
            d: {"reviewer_id": "r", "status": status}
            for d, status in zip(
                MODULE.GOLD_REVIEW_DIMENSIONS,
                ("approved", "rejected", "needs_more_info", "approved"),
            )
        }
        self.assertIsNone(MODULE.validate_gold_record(_gold(reviews=reviews)))

    def test_each_rejection_names_its_field(self):
        compound = " is not a single supported intent label; a compound/multi-operation request must be rejected as unsupported in this bounded scope, never squeezed into one label"
        cases = [
            (
                {"source_ref": "x"},
                "gold record missing required fields: ['corpus_candidate_sha256', 'expected_outcome', 'intent', 'reviews', 'slots']",
            ),
            (_gold(source_ref=""), "gold record source_ref must be a non-empty string"),
            (_gold(source_ref=5), "gold record source_ref must be a non-empty string"),
            (
                _gold(corpus_candidate_sha256=5),
                "gold record corpus_candidate_sha256 must be a 64-character hex sha256 digest",
            ),
            (
                _gold(corpus_candidate_sha256="A" * 64),
                "gold record corpus_candidate_sha256 must be a 64-character hex sha256 digest",
            ),
            (
                _gold(corpus_candidate_sha256="a" * 63),
                "gold record corpus_candidate_sha256 must be a 64-character hex sha256 digest",
            ),
            (
                _gold(intent=""),
                "gold record intent must be a non-empty string, never inferred or left unset",
            ),
            (
                _gold(intent=None),
                "gold record intent must be a non-empty string, never inferred or left unset",
            ),
            (_gold(intent="Event.Create"), "gold record intent 'Event.Create'" + compound),
            (_gold(intent="a.b.c"), "gold record intent 'a.b.c'" + compound),
            (_gold(slots=None), "gold record slots must be a mapping"),
            (_gold(slots=["a"]), "gold record slots must be a mapping"),
            (
                _gold(slots={"a": 1}),
                "gold record slots must be a str-to-str mapping, got key 'a' -> value 1",
            ),
            (
                _gold(slots={1: "a"}),
                "gold record slots must be a str-to-str mapping, got key 1 -> value 'a'",
            ),
            (
                _gold(expected_outcome=""),
                "gold record expected_outcome must be a non-empty string, never inferred from bot prose",
            ),
            (
                _gold(expected_outcome=3),
                "gold record expected_outcome must be a non-empty string, never inferred from bot prose",
            ),
            (_gold(reviews=[]), "gold record reviews must be a mapping"),
            (
                _gold(reviews={}),
                "gold record missing independent review dimensions: ['expected_outcome', 'intent', 'privacy', 'slots']",
            ),
        ]
        for record, message in cases:
            with self.subTest(message=message):
                self.assertEqual(self._message(record), message)

    def test_each_review_dimension_is_checked(self):
        for dimension in MODULE.GOLD_REVIEW_DIMENSIONS:
            for bad, message in [
                ("text", f"gold record {dimension} review needs a non-empty reviewer_id"),
                (
                    {"status": "approved"},
                    f"gold record {dimension} review needs a non-empty reviewer_id",
                ),
                (
                    {"reviewer_id": "", "status": "approved"},
                    f"gold record {dimension} review needs a non-empty reviewer_id",
                ),
                (
                    {"reviewer_id": 5, "status": "approved"},
                    f"gold record {dimension} review needs a non-empty reviewer_id",
                ),
                (
                    {"reviewer_id": "r"},
                    f"gold record {dimension} review has an unknown status: None",
                ),
                (
                    {"reviewer_id": "r", "status": "maybe"},
                    f"gold record {dimension} review has an unknown status: 'maybe'",
                ),
            ]:
                with self.subTest(dimension=dimension, bad=bad):
                    record = _gold()
                    record["reviews"][dimension] = bad
                    self.assertEqual(self._message(record), message)

    def test_the_first_failing_dimension_in_declared_order_is_reported(self):
        record = _gold()
        record["reviews"]["slots"] = {"reviewer_id": "r", "status": "bad"}
        record["reviews"]["privacy"] = {"reviewer_id": "", "status": "approved"}
        self.assertEqual(
            self._message(record), "gold record privacy review needs a non-empty reviewer_id"
        )

    def test_the_first_failing_check_wins_over_a_later_one(self):
        self.assertEqual(
            self._message(_gold(source_ref="", corpus_candidate_sha256="x", intent="")),
            "gold record source_ref must be a non-empty string",
        )


def _candidate(ref, **fields):
    base = {
        "source_ref": ref,
        "text_candidate": "text",
        "privacy_status": "pseudonymized_candidate_needs_review",
        "label_status": "needs_adjudication",
        "gold": None,
        "gold_adjudication": None,
        "train_eligible": False,
    }
    base.update(fields)
    return base


class ApplyGoldImportTests(unittest.TestCase):
    def test_every_outcome_is_counted_and_applied_in_one_import(self):
        candidates = [
            _candidate("ok"),
            _candidate("partial"),
            _candidate(
                "quarantined-status",
                privacy_status="quarantined",
                gold={"x": 1},
                train_eligible=True,
            ),
            _candidate("quarantined-text", text_candidate=MODULE.QUARANTINED_AUTH_MARKER),
            _candidate("untouched"),
        ]
        partial_reviews = _gold()["reviews"]
        partial_reviews["intent"] = {"reviewer_id": "r", "status": "rejected"}
        records = [
            _gold(source_ref="ok"),
            _gold(source_ref="partial", reviews=partial_reviews),
            _gold(source_ref="missing"),
            _gold(source_ref="ok", corpus_candidate_sha256="b" * 64),
            _gold(source_ref="quarantined-status"),
            _gold(source_ref="quarantined-text"),
        ]
        result, report = MODULE.apply_gold_import(candidates, records, SHA)
        self.assertIs(result, candidates)
        self.assertEqual(
            report,
            {
                "gold_fully_approved": 1,
                "gold_partial_or_rejected_recorded": 1,
                "gold_rejected_unknown_source": 1,
                "gold_rejected_corpus_mismatch": 1,
                "gold_rejected_source_quarantined": 2,
            },
        )
        by_ref = {candidate["source_ref"]: candidate for candidate in candidates}
        approved = by_ref["ok"]
        self.assertEqual(
            approved["gold"],
            {
                "intent": "event.create",
                "slots": {"title": "x"},
                "expected_outcome": "created",
                "reviews": records[0]["reviews"],
            },
        )
        self.assertEqual(approved["gold_adjudication"], approved["gold"])
        self.assertEqual(
            (approved["label_status"], approved["train_eligible"]), ("gold_approved", True)
        )
        held = by_ref["partial"]
        self.assertIsNone(held["gold"])
        self.assertEqual(held["gold_adjudication"]["intent"], "event.create")
        self.assertEqual(
            (held["label_status"], held["train_eligible"]), ("gold_partial_or_rejected", False)
        )
        for ref in ("quarantined-status", "quarantined-text"):
            self.assertEqual(
                (
                    by_ref[ref]["label_status"],
                    by_ref[ref]["gold"],
                    by_ref[ref]["gold_adjudication"],
                    by_ref[ref]["train_eligible"],
                ),
                ("gold_rejected_source_quarantined", None, None, False),
            )
        self.assertEqual(by_ref["untouched"], _candidate("untouched"))

    def test_a_mismatched_corpus_hash_is_checked_before_the_source_ref(self):
        candidates = [_candidate("known")]
        _, report = MODULE.apply_gold_import(
            candidates, [_gold(source_ref="unknown", corpus_candidate_sha256="b" * 64)], SHA
        )
        self.assertEqual(
            (report["gold_rejected_corpus_mismatch"], report["gold_rejected_unknown_source"]),
            (1, 0),
        )

    def test_an_invalid_record_raises_after_earlier_records_were_applied(self):
        candidates = [_candidate("ok")]
        with self.assertRaises(ValueError):
            MODULE.apply_gold_import(candidates, [_gold(source_ref="ok"), _gold(intent="")], SHA)
        self.assertEqual(candidates[0]["label_status"], "gold_approved")

    def test_no_records_leave_candidates_untouched(self):
        candidates = [_candidate("ok")]
        _, report = MODULE.apply_gold_import(candidates, [], SHA)
        self.assertEqual(
            report,
            {
                "gold_fully_approved": 0,
                "gold_partial_or_rejected_recorded": 0,
                "gold_rejected_unknown_source": 0,
                "gold_rejected_corpus_mismatch": 0,
                "gold_rejected_source_quarantined": 0,
            },
        )
        self.assertEqual(candidates, [_candidate("ok")])

    def test_the_last_candidate_with_a_duplicate_source_ref_receives_the_label(self):
        first, second = (
            _candidate("dup", text_candidate="first"),
            _candidate("dup", text_candidate="second"),
        )
        MODULE.apply_gold_import([first, second], [_gold(source_ref="dup")], SHA)
        self.assertEqual(
            (first["label_status"], second["label_status"]), ("needs_adjudication", "gold_approved")
        )


class GoldenOutputTests(unittest.TestCase):
    maxDiff = None

    def _golden(self, name):
        return json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))[name]

    def test_audit_output_is_unchanged(self):
        self.assertEqual(json.loads(json.dumps(audit_output())), self._golden("audit"))

    def test_collect_output_is_unchanged(self):
        self.assertEqual(json.loads(json.dumps(collect_output())), self._golden("collect"))

    def test_audit_never_mutates_its_input_rows(self):
        rows = copy.deepcopy(AUDIT_ROWS)
        MODULE.audit(rows, KEY, LEXICON)
        self.assertEqual(rows, AUDIT_ROWS)


if __name__ == "__main__":
    unittest.main()
