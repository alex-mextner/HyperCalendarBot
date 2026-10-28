"""deploy-evidence.py keeps logs but never copies secrets or message content (#823)."""

import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "deploy_evidence", ROOT / "scripts/deploy-evidence.py"
)
evidence = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(evidence)

# Built at run time from obviously fake filler, so no credential-shaped literal sits in the source.
FAKE_BOT = "123456789:" + "Z" * 35
FAKE_BEARER = "Bearer " + "q" * 24
FAKE_KEY = "sk-" + "k" * 24
FAKE_PASSWORD = "p" * 12
FAKE_URL_PASSWORD = "u" * 10


class RedactionTests(unittest.TestCase):
    def test_telegram_tokens_keys_and_passwords_are_removed(self):
        text = (
            f"url=https://api.telegram.org/bot{FAKE_BOT}/sendMessage "
            f"Authorization: {FAKE_BEARER} key={FAKE_KEY} "
            f'{{"password":"{FAKE_PASSWORD}","msg":"kept"}} redis://:{FAKE_URL_PASSWORD}@redis:6379'
        )
        out = evidence.redact(text)
        for secret in ("Z" * 35, "q" * 24, "k" * 24, FAKE_PASSWORD, FAKE_URL_PASSWORD):
            self.assertNotIn(secret, out)
        self.assertIn('"msg":"kept"', out)

    def test_message_content_fields_are_blanked_but_the_log_message_stays(self):
        line = '{"level":50,"msg":"handler failed","text":"my private plan \\"x\\"","chatId":1}'
        out = evidence.redact(line)
        self.assertNotIn("private plan", out)
        self.assertIn('"msg":"handler failed"', out)
        self.assertIn('"level":50', out)

    def test_state_line_reports_exit_code_oom_and_error_count(self):
        summary = {
            "State": {"Status": "exited", "ExitCode": 137, "OOMKilled": True},
            "RestartCount": 2,
        }
        line = evidence.state_line(summary, '{"level":50}\n{"level":30}\n{"level":60}\n')
        self.assertIn("exit_code=137", line)
        self.assertIn("oom_killed=True", line)
        self.assertIn("level50plus_in_tail=2", line)


class DirectoryNameTests(unittest.TestCase):
    def test_two_evidence_directories_requested_in_the_same_second_do_not_share_a_directory(
        self,
    ):
        with tempfile.TemporaryDirectory() as tmp:
            first = evidence.make_dir(tmp, "failed-abc-2026-10-25_00-00-00")
            (first / "state.txt").write_text("first attempt")
            second = evidence.make_dir(tmp, "failed-abc-2026-10-25_00-00-00")
            self.assertNotEqual(first, second)
            self.assertEqual((first / "state.txt").read_text(), "first attempt")
            self.assertEqual(second.stat().st_mode & 0o777, 0o700)
            self.assertTrue(second.name.startswith("failed-abc-"))


if __name__ == "__main__":
    unittest.main()
