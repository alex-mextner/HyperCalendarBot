"""Connect-wizard input must never reach the raw export, the candidates or the summary (GH-721)."""

import gzip
import json
import pathlib
import re
import sqlite3
import subprocess
import sys
import tempfile
import unittest

from nlu_corpus_support import MODULE, ROOT

# GH-721 / GH-519: backups taken before the #617 fix hold what a user typed into the Telegram-connect
# wizard. Every value below is synthetic. Neither the code nor the password trips the AUTH regex or the
# NUMBER redaction on its own (the code is too short, the password is a plain word pair), so only the
# quarantine can keep them out of the exports.
SYNTHETIC_PHONE = "+10005550123"
SYNTHETIC_CODE = "543-21"
SYNTHETIC_PASSWORD = (
    "Zebra-Orchid-42"  # gitleaks:allow synthetic test fixture, never a real credential
)
SYNTHETIC_SECRETS = (SYNTHETIC_PHONE, SYNTHETIC_CODE, SYNTHETIC_PASSWORD)
SOURCE_WIZARD_MARKER = "[redacted: connect wizard input]"  # what the #617/#641 chat logging stores
CALENDAR_REQUEST = "Создай встречу завтра в 14:00"


def _bot(text):
    return f'{{"kind": "bot", "text": "{text}"}}'


def _wizard_session_rows(user_id=7, chat_id=7):
    """One English-locale connect-wizard run shaped like the pre-#617 chat_history, then two requests
    three hours later."""
    rows = [
        (
            "user",
            '{"kind": "command", "name": "connect_telegram", "args": ""}',
            "2026-01-01 10:00:00",
        ),
        (
            "assistant",
            _bot("Connect Telegram Account. The bot stores a technical session, no passwords."),
            "2026-01-01 10:00:02",
        ),
        ("user", '{"kind": "button", "label": "Connect"}', "2026-01-01 10:00:10"),
        ("assistant", _bot("Enter phone number in international format:"), "2026-01-01 10:00:11"),
        ("user", SYNTHETIC_PHONE, "2026-01-01 10:00:20"),
        ("assistant", _bot("Verification code sent to Telegram."), "2026-01-01 10:00:25"),
        ("user", SYNTHETIC_CODE, "2026-01-01 10:00:40"),
        (
            "assistant",
            _bot("You have two-factor authentication enabled. Enter your password:"),
            "2026-01-01 10:00:45",
        ),
        ("user", SYNTHETIC_PASSWORD, "2026-01-01 10:01:00"),
        ("assistant", _bot("Telegram account connected"), "2026-01-01 10:01:05"),
        # The first text after the wizard's last message may answer an abandoned prompt, however late.
        ("user", "Спасибо", "2026-01-01 12:59:00"),
        ("assistant", _bot("Пожалуйста"), "2026-01-01 12:59:05"),
        ("user", CALENDAR_REQUEST, "2026-01-01 13:00:00"),
        ("assistant", _bot("Готово"), "2026-01-01 13:00:05"),
    ]
    return [
        {
            "id": index + 1,
            "user_id": user_id,
            "chat_id": chat_id,
            "role": role,
            "content": content,
            "created_at": at,
        }
        for index, (role, content, at) in enumerate(rows)
    ]


class ConnectWizardExportTests(unittest.TestCase):
    def _write_gzipped_backup(self, root, rows):
        backups = root / "data" / "backups"
        backups.mkdir(parents=True)
        (root / "logs").mkdir()
        plain = root / "plain.db"
        conn = sqlite3.connect(str(plain))
        try:
            conn.execute(
                "CREATE TABLE chat_history (id INTEGER PRIMARY KEY, user_id INTEGER, chat_id INTEGER, role TEXT, content TEXT, created_at TEXT)"
            )
            conn.executemany(
                "INSERT INTO chat_history (id, user_id, chat_id, role, content, created_at) VALUES (:id, :user_id, :chat_id, :role, :content, :created_at)",
                rows,
            )
            conn.commit()
        finally:
            conn.close()
        (backups / "calendar_2026-01-02_03-00-00.db.gz").write_bytes(
            gzip.compress(plain.read_bytes())
        )
        plain.unlink()

    def _run_builder(self, root, out, merges=()):
        command = [
            sys.executable,
            str(ROOT / "scripts" / "nlu_corpus.py"),
            "--root",
            str(root),
            "--out",
            str(out),
        ]
        for archive in merges:
            command += ["--merge", str(archive)]
        return subprocess.run(
            command, stdin=subprocess.DEVNULL, capture_output=True, check=False, timeout=120
        )

    def _assert_no_synthetic_secret_anywhere(self, out, result):
        outputs = {path.name: path.read_bytes() for path in out.iterdir() if path.is_file()}
        outputs["<stdout>"] = result.stdout
        outputs["<stderr>"] = result.stderr
        self.assertIn("selected.private.json", outputs)
        for name, data in outputs.items():
            for secret in SYNTHETIC_SECRETS:
                self.assertFalse(
                    secret.encode() in data, f"a synthetic connect-wizard value reached {name}"
                )  # never dump the file

    def _selected_rows(self, out):
        return json.loads((out / "selected.private.json").read_text(encoding="utf-8"))["rows"]

    def test_a_backup_with_connect_wizard_input_leaks_nothing_into_any_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / "root"
            self._write_gzipped_backup(root, _wizard_session_rows())
            out = pathlib.Path(tmp) / "out"
            result = self._run_builder(root, out)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
            self._assert_no_synthetic_secret_anywhere(out, result)
            contents = [row["content"] for row in self._selected_rows(out)]
            self.assertIn(
                CALENDAR_REQUEST,
                contents,
                "a request outside the wizard window must stay in the raw export",
            )

    def test_a_merged_archive_with_connect_wizard_input_leaks_nothing_into_any_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / "root"
            (root / "data").mkdir(parents=True)
            (root / "logs").mkdir()
            rows = [
                dict(row, source_refs=["data/backups/old.db.gz#synthetic"])
                for row in _wizard_session_rows()
            ]
            current = pathlib.Path(tmp) / "current.json"
            current.write_text(
                json.dumps(
                    {
                        "rows": rows,
                        "sources": [],
                        "lexicon": {},
                        "schema_version": MODULE.SCHEMA_VERSION,
                    }
                )
            )
            legacy = pathlib.Path(tmp) / "legacy.json"
            legacy.write_text(
                json.dumps(
                    [
                        {"row": row, "sources": ["old.db"]}
                        for row in _wizard_session_rows(user_id=8, chat_id=8)
                    ]
                )
            )
            out = pathlib.Path(tmp) / "out"
            result = self._run_builder(root, out, merges=[current, legacy])
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
            self._assert_no_synthetic_secret_anywhere(out, result)

    def test_wizard_rows_are_left_out_of_the_raw_export_and_counted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / "root"
            self._write_gzipped_backup(root, _wizard_session_rows())
            out = pathlib.Path(tmp) / "out"
            self.assertEqual(self._run_builder(root, out).returncode, 0)
            self.assertEqual([row["id"] for row in self._selected_rows(out)], [13, 14])
            summary = json.loads((out / "summary.json").read_text(encoding="utf-8"))
            self.assertEqual(summary["raw_export_quarantined_rows"], 12)

    def test_a_raw_export_merged_again_quarantines_nothing_it_kept(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / "root"
            self._write_gzipped_backup(root, _wizard_session_rows())
            first = pathlib.Path(tmp) / "first"
            self.assertEqual(self._run_builder(root, first).returncode, 0)
            empty_root = pathlib.Path(tmp) / "empty"
            (empty_root / "data").mkdir(parents=True)
            (empty_root / "logs").mkdir()
            second = pathlib.Path(tmp) / "second"
            self.assertEqual(
                self._run_builder(
                    empty_root, second, merges=[first / "selected.private.json"]
                ).returncode,
                0,
            )
            summary = json.loads((second / "summary.json").read_text(encoding="utf-8"))
            self.assertEqual(
                (
                    summary["retained_rows"],
                    summary["quarantined_auth_rows"],
                    summary["user_candidates"],
                ),
                (2, 0, 1),
            )

    def test_the_source_wizard_marker_opens_the_quarantine_window(self):
        rows = [
            {"scope": "a", "at": 0, "role": "user", "text": SOURCE_WIZARD_MARKER},
            {"scope": "a", "at": 60, "role": "user", "text": SYNTHETIC_PASSWORD},
            {"scope": "b", "at": 60, "role": "user", "text": CALENDAR_REQUEST},
        ]
        self.assertEqual(MODULE.quarantined_indices(rows), {0, 1})

    def test_the_answer_to_an_expired_credential_prompt_and_the_reply_to_it_are_quarantined_however_late(
        self,
    ):
        # GH-641: after an idle wizard expires, the next text still answers its credential prompt.
        rows = [
            {"scope": "a", "at": 0, "role": "assistant", "text": _bot("Enter your password:")},
            {"scope": "a", "at": 7200, "role": "user", "text": SYNTHETIC_PASSWORD},
            {
                "scope": "a",
                "at": 7205,
                "role": "assistant",
                "text": _bot("Не понял: " + SYNTHETIC_PASSWORD),
            },
            {"scope": "a", "at": 7300, "role": "user", "text": CALENDAR_REQUEST},
            {"scope": "a", "at": 7305, "role": "assistant", "text": _bot("Готово")},
        ]
        self.assertEqual(MODULE.quarantined_indices(rows), {0, 1, 2})

    def test_a_late_answer_to_a_phone_prompt_is_quarantined(self):
        rows = [
            {
                "scope": "a",
                "at": 0,
                "role": "assistant",
                "text": _bot(
                    "Connect Telegram Account. The bot stores a technical session, no passwords."
                ),
            },
            {
                "scope": "a",
                "at": 10,
                "role": "user",
                "text": '{"kind": "button", "label": "Connect"}',
            },
            {
                "scope": "a",
                "at": 11,
                "role": "assistant",
                "text": _bot("Enter phone number in international format:"),
            },
            {"scope": "a", "at": 7200, "role": "user", "text": SYNTHETIC_PHONE},
            {"scope": "a", "at": 7205, "role": "assistant", "text": _bot("Готово")},
            {"scope": "a", "at": 9000, "role": "user", "text": CALENDAR_REQUEST},
        ]
        self.assertEqual(MODULE.quarantined_indices(rows), {0, 1, 2, 3, 4})

    def test_a_wizard_tail_without_its_consent_screen_is_quarantined(self):
        # A partial source (a --merge of a partial export) may start at the phone prompt; the English
        # phone and code prompts must open the window on their own, as the Russian code prompt does.
        rows = [
            {
                "scope": "a",
                "at": 0,
                "role": "assistant",
                "text": _bot("Enter phone number in international format:"),
            },
            {"scope": "a", "at": 9, "role": "user", "text": SYNTHETIC_PHONE},
            {
                "scope": "a",
                "at": 15,
                "role": "assistant",
                "text": _bot("Verification code sent to Telegram."),
            },
            {"scope": "a", "at": 30, "role": "user", "text": SYNTHETIC_CODE},
            {"scope": "b", "at": 30, "role": "user", "text": CALENDAR_REQUEST},
        ]
        self.assertEqual(MODULE.quarantined_indices(rows), {0, 1, 2, 3})

    def test_every_credential_prompt_of_the_wizard_opens_the_window_in_both_languages(self):
        blocks = []
        for lang in ("en", "ru"):
            module = (
                ROOT / "src" / "config" / "constants" / "messages" / lang / "connect-telegram.ts"
            ).read_text(encoding="utf-8")
            blocks += re.findall(
                r"^  connectTelegram: \{\n(.*?)^  \},$", module, re.MULTILINE | re.DOTALL
            )
        self.assertEqual(len(blocks), 2, "expected the English and Russian connectTelegram strings")
        for block in blocks:
            for prompt in (
                "enterPhone",
                "invalidPhone",
                "codeSent",
                "invalidCode",
                "enter2fa",
                "invalid2fa",
            ):
                text = re.search(
                    r"^    " + prompt + r":\s*'((?:[^'\\]|\\.)*)'", block, re.MULTILINE
                )
                self.assertIsNotNone(
                    text, f"{prompt} is no longer a plain string; update this test"
                )
                self.assertTrue(
                    MODULE.opens_auth_window(text[1]),
                    f"the {prompt} prompt must open the auth window",
                )

    def test_a_copy_of_a_late_answer_kept_by_another_source_is_quarantined_too(self):
        # The database row and the AI debug log's copy of the same late answer are two rows.
        rows = [
            {"scope": "a", "at": 0, "role": "assistant", "text": _bot("Enter your password:")},
            {"scope": "a", "at": 7200, "role": "user", "text": SYNTHETIC_PASSWORD},
            {
                "scope": "a",
                "at": 7201,
                "role": "user",
                "text": SYNTHETIC_PASSWORD + "\n",
                "record_kind": "debug_run",
            },
            {"scope": "a", "at": 9000, "role": "user", "text": CALENDAR_REQUEST},
        ]
        self.assertEqual(MODULE.quarantined_indices(rows), {0, 1, 2})

    def test_a_debug_run_whose_logged_history_holds_a_credential_prompt_is_quarantined(self):
        # Before #617 a cancelled wizard handed its text to the AI; the debug log may be all that is left.
        log = (
            "[2026-01-01T10:00:00Z]\nCHAT: 7 | USER: uid:7\nSUPPLEMENT: false\nMESSAGE: "
            + SYNTHETIC_PASSWORD
            + "\n"
            + "=" * 80
            + "\n\n## HISTORY [1 messages]\n[assistant]\nEnter your password:\n## END HISTORY\n"
            + "[2026-01-01T15:00:00Z]\nCHAT: 7 | USER: uid:7\nSUPPLEMENT: false\nMESSAGE: "
            + CALENDAR_REQUEST
            + "\n"
            + "=" * 80
            + "\n"
        )
        exported, counts = MODULE.raw_export(MODULE.parse_debug_runs(log), b"key", {})
        self.assertEqual([row["content"] for row in exported], [CALENDAR_REQUEST])
        self.assertEqual(counts["raw_export_quarantined_rows"], 1)

    def test_a_credential_prompt_quoted_only_in_a_debug_run_response_opens_the_window(self):
        # A pre-GH-721 export merged again: the AI's reply quoting the prompt may be the only copy left.
        rows = [
            {
                "id": 1,
                "user_id": 7,
                "chat_id": 7,
                "role": "user",
                "content": "покажи календарь",
                "response": "Enter your password:",
                "record_kind": "debug_run",
                "created_at": "2026-01-01T10:00:00Z",
            },
            {
                "id": 2,
                "user_id": 7,
                "chat_id": 7,
                "role": "user",
                "content": SYNTHETIC_PASSWORD,
                "created_at": "2026-01-01T10:01:00Z",
            },
            {
                "id": 3,
                "user_id": 7,
                "chat_id": 7,
                "role": "user",
                "content": CALENDAR_REQUEST,
                "created_at": "2026-01-01T15:00:00Z",
            },
        ]
        exported, counts = MODULE.raw_export(rows, b"key", {})
        self.assertEqual([row["id"] for row in exported], [3])
        self.assertEqual(counts["raw_export_quarantined_rows"], 2)

    def test_an_unreadable_debug_run_response_opens_the_window(self):
        rows = [
            {
                "id": 1,
                "user_id": 7,
                "chat_id": 7,
                "role": "user",
                "content": "ok",
                "response": ["Enter your password:"],
                "record_kind": "debug_run",
                "created_at": "2026-01-01T10:00:00Z",
            },
            {
                "id": 2,
                "user_id": 7,
                "chat_id": 7,
                "role": "user",
                "content": SYNTHETIC_PASSWORD,
                "created_at": "2026-01-01T10:01:00Z",
            },
        ]
        exported, counts = MODULE.raw_export(rows, b"key", {})
        self.assertEqual(exported, [])
        self.assertEqual(counts["raw_export_quarantined_rows"], 2)

    def test_an_empty_quarantined_text_does_not_quarantine_every_empty_row(self):
        rows = [
            {"scope": "a", "at": 0, "role": "assistant", "text": _bot("Enter your password:")},
            {"scope": "a", "at": 10, "role": "user", "text": ""},
            {"scope": "a", "at": 9000, "role": "user", "text": CALENDAR_REQUEST},
            {"scope": "a", "at": 9005, "role": "assistant", "text": ""},
        ]
        self.assertEqual(MODULE.quarantined_indices(rows), {0, 1})

    def test_python_wizard_marker_matches_the_one_chat_logging_stores(self):
        scene = (ROOT / "src" / "bot" / "scenes" / "connect-telegram.scene.ts").read_text(
            encoding="utf-8"
        )
        declared = re.search(
            r"^export const CONNECT_WIZARD_REDACTION = '([^']*)';$", scene, re.MULTILINE
        )
        self.assertIsNotNone(
            declared,
            "CONNECT_WIZARD_REDACTION moved; point nlu_corpus_redaction.py at its new home",
        )
        self.assertEqual(MODULE.CONNECT_WIZARD_REDACTION, declared[1])

    def test_free_text_outside_the_window_is_pseudonymized_in_the_raw_export(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / "root"
            (root / "data").mkdir(parents=True)
            (root / "logs").mkdir()
            (root / "logs" / "ai-debug.log").write_text(
                "[2026-01-01T09:00:00Z]\nCHAT: 5 | USER: uid:9\nSUPPLEMENT: false\nMESSAGE: позвони на "
                + SYNTHETIC_PHONE
                + "\n"
                + "=" * 50
                + "\nResponse (20 chars):\nЗвоню на "
                + SYNTHETIC_PHONE
                + "\n"
                + "=" * 50
                + "\n",
                encoding="utf-8",
            )
            out = pathlib.Path(tmp) / "out"
            result = self._run_builder(root, out)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
            self._assert_no_synthetic_secret_anywhere(out, result)
            [row] = self._selected_rows(out)
            self.assertTrue(
                row["content"].startswith("позвони на [NUMBER_"),
                "the message itself stays in the export, pseudonymized",
            )

    def test_rows_the_export_cannot_place_read_or_rebuild_are_kept_out_and_counted(self):
        rows = [
            {
                "id": 1,
                "user_id": 1,
                "chat_id": 1,
                "role": "user",
                "content": SYNTHETIC_PASSWORD,
                "created_at": "not-a-date",
                "source_refs": ["x#1"],
            },
            {
                "id": 6,
                "user_id": 1,
                "chat_id": 1,
                "role": "user",
                "content": SYNTHETIC_PASSWORD,
                "created_at": 20260101,
                "source_refs": ["x#1"],
            },
            {
                "id": 2,
                "user_id": 2,
                "chat_id": 2,
                "role": "user",
                "content": {"text": SYNTHETIC_CODE},
                "created_at": "2026-01-01 09:00:00",
                "source_refs": ["x#1"],
            },
            {
                "id": 3,
                "user_id": 2,
                "chat_id": 2,
                "role": "user",
                "content": SYNTHETIC_PASSWORD,
                "created_at": "2026-01-01 09:05:00",
                "source_refs": ["x#1"],
            },
            {
                "id": 4,
                "user_id": 1,
                "chat_id": 1,
                "role": "user",
                "content": "Готово",
                "created_at": "2026-01-01 09:10:00",
                "source_refs": ["x#1"],
                "tools": [SYNTHETIC_PASSWORD],
            },
            {
                "id": 5,
                "user_id": 1,
                "chat_id": 1,
                "role": "user",
                "content": CALENDAR_REQUEST,
                "created_at": "2026-01-01 12:00:00",
                "source_refs": ["x#1"],
                "note": SYNTHETIC_PASSWORD,
            },
        ]
        exported, counts = MODULE.raw_export(rows, b"key", {})
        self.assertEqual(
            exported,
            [
                {
                    "id": 5,
                    "user_id": 1,
                    "chat_id": 1,
                    "role": "user",
                    "content": CALENDAR_REQUEST,
                    "created_at": "2026-01-01 12:00:00",
                    "source_refs": ["x#1"],
                }
            ],
        )
        self.assertEqual(
            counts,
            {"raw_export_quarantined_rows": 2, "raw_export_omitted_rows": 3},
            "unreadable text opens the auth window like a credential term",
        )
