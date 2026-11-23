"""Real stage-wrapper contract for one isolated session key per fresh database."""

import json
import os
import stat
import sys

from odroid_stage_qa_support import StageWorld


KEY = "TELEGRAM_SESSION_MASTER_KEY"
PROD_KEY = "aa" * 32
PROVISIONED_KEY = "bb" * 32


class StageSessionKey(StageWorld):
    def session_key(self):
        entries = [
            line.partition("=")[2]
            for line in (self.stage / "bot.env").read_text().splitlines()
            if line.partition("=")[0] == KEY
        ]
        self.assertEqual(len(entries), 1, "stage must receive exactly one session key")
        self.assertRegex(entries[0], r"^[0-9a-f]{64}$")
        return entries[0]

    def assert_key_is_private(self, key, result):
        self.assertNotIn(key, result.stdout + result.stderr + self.record_text())
        self.assertEqual(stat.S_IMODE((self.stage / "bot.env").stat().st_mode), 0o600)

    def observe_compose_environment(self):
        original = self.bin / "docker-recording"
        (self.bin / "docker").rename(original)
        self.write_exec(
            self.bin / "docker",
            f"""#!{sys.executable}
import json, os, re, stat, sys
from pathlib import Path
stage = Path({str(self.stage)!r})
if sys.argv[1] == "compose" and "up" in sys.argv[2:]:
    path = stage / "bot.env"
    keys = [line.partition("=")[2] for line in path.read_text().splitlines()
            if line.partition("=")[0] == {KEY!r}]
    snapshot = {{
        "key_count": len(keys),
        "key_valid": len(keys) == 1 and bool(re.fullmatch("[0-9a-f]{{64}}", keys[0])),
        "mode": stat.S_IMODE(path.stat().st_mode),
        "temporary_env_exists": (stage / "bot.env.new").exists(),
        "old_database_exists": (stage / "data/calendar.db").exists(),
    }}
    Path({str(self.rec / "compose-env.json")!r}).write_text(json.dumps(snapshot))
os.execv({str(original)!r}, [{str(original)!r}, *sys.argv[1:]])
""",
        )

    def test_generated_key_is_unique_and_never_copied_from_provisioning_or_production(self):
        with (self.deploy / ".env").open("a") as stream:
            stream.write(f"{KEY}={PROD_KEY}\n{KEY}={PROD_KEY}\n")
        with (self.stage / "stage.env").open("a") as stream:
            stream.write(f"{KEY}={PROVISIONED_KEY}\n{KEY}={PROVISIONED_KEY}\n")

        result = self.run_entry()

        self.assertOutcome(result, 0, "passed")
        key = self.session_key()
        self.assertNotIn(key, (PROD_KEY, PROVISIONED_KEY))
        env_text = (self.stage / "bot.env").read_text()
        for forbidden in (PROD_KEY, PROVISIONED_KEY, "tg-hash", "google-secret", "mtproto-secret"):
            self.assertNotIn(forbidden, env_text)
        self.assert_key_is_private(key, result)
        self.assertNoSecrets(result)

    def test_each_fresh_database_run_gets_an_independent_key(self):
        first = self.run_entry()
        self.assertOutcome(first, 0, "passed")
        first_key = self.session_key()
        self.assert_key_is_private(first_key, first)
        for name in ("calendar.db", "calendar.db-wal", "calendar.db-shm"):
            (self.stage / "data" / name).write_text("previous isolated stage database")

        second = self.run_entry()

        self.assertOutcome(second, 0, "passed")
        second_key = self.session_key()
        self.assertNotEqual(second_key, first_key)
        self.assertEqual(list((self.stage / "data").glob("calendar.db*")), [])
        self.assert_key_is_private(second_key, second)
        self.assertNotIn(first_key, second.stdout + second.stderr + self.record_text())

    def test_complete_private_environment_atomically_replaces_old_file_before_startup(self):
        target = self.stage / "bot.env"
        old = f"BOT_USERNAME=old_stage_bot\n{KEY}={PROVISIONED_KEY}\n"
        target.write_text(old)
        target.chmod(0o600)
        (self.stage / "data/calendar.db").write_text("previous isolated stage database")
        self.observe_compose_environment()
        with target.open() as previous:
            old_inode = os.fstat(previous.fileno()).st_ino
            result = self.run_entry()
            self.assertOutcome(result, 0, "passed")
            self.assertEqual(previous.read(), old)
            self.assertNotEqual(target.stat().st_ino, old_inode)

        self.session_key()
        self.assertEqual(
            json.loads((self.rec / "compose-env.json").read_text()),
            {
                "key_count": 1,
                "key_valid": True,
                "mode": 0o600,
                "temporary_env_exists": False,
                "old_database_exists": False,
            },
        )

    def test_generation_failure_keeps_old_environment_and_never_starts_stage(self):
        target = self.stage / "bot.env"
        previous = f"BOT_USERNAME=old_stage_bot\n{KEY}={PROVISIONED_KEY}\n"
        target.write_text(previous)
        target.chmod(0o600)
        # Fail an interpreter invocation while the environment is being assembled.
        # Earlier artifact checks still use the real interpreter. No runtime hook is added.
        self.write_exec(
            self.bin / "python3",
            f"""#!/bin/bash
if [[ -f {str(self.stage / "bot.env.new")!r} ]]; then
  printf '%s\\n' '{KEY}=incomplete-test-value' >{str(self.stage / "bot.env.new")!r}
  stat -c '%a' {str(self.stage / "bot.env.new")!r} >{str(self.rec / "partial-mode")!r}
  exit 72
fi
exec {sys.executable!r} "$@"
""",
        )

        result = self.run_entry()

        with self.subTest("unexpected generator error is infrastructure failure"):
            self.assertOutcome(result, 4, "infra-error")
        with self.subTest("partial private temporary file is removed"):
            self.assertFalse((self.stage / "bot.env.new").exists())
        self.assertEqual((self.rec / "partial-mode").read_text().strip(), "600")
        self.assertNotIn("incomplete-test-value", result.stdout + result.stderr + self.record_text())
        self.assertNotIn("STAGE_READY", result.stdout)
        self.assertFalse(self.has_event("compose-up"))
        self.assertFalse(self.has_event("health"))
        self.assertEqual(target.read_text(), previous)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
        self.assertTrue(self.has_event("docker-rmi"))


    def assert_allowed_bytes_survive(self, value):
        line = b"AI_BYTE_CONTINUITY=" + value
        with (self.deploy / ".env").open("ab") as stream:
            stream.write(line + b"\n")

        result = self.run_entry()

        self.assertOutcome(result, 0, "passed")
        lines = (self.stage / "bot.env").read_bytes().split(b"\n")
        self.assertTrue(line in lines, "allowed bytes must remain one unchanged LF-delimited entry")
        self.assertFalse(any(entry.startswith(b"GOOGLE_CLIENT_SECRET=") for entry in lines))
        self.assertFalse(any(entry.startswith(b"TELEGRAM_API_HASH=") for entry in lines))
        keys = [entry.partition(b"=")[2] for entry in lines if entry.startswith(KEY.encode() + b"=")]
        self.assertEqual(len(keys), 1)
        self.assertRegex(keys[0], rb"^[0-9a-f]{64}$")
        self.assertNotIn(keys[0].decode(), result.stdout + result.stderr + self.record_text())

    def test_non_utf8_allowed_value_is_preserved(self):
        self.assert_allowed_bytes_survive(b"latin-\xff-value")

    def test_only_lf_separates_allowed_environment_lines(self):
        self.assert_allowed_bytes_survive(
            b"one\vGOOGLE_CLIENT_SECRET=not-a-line\fTELEGRAM_API_HASH=not-a-line"
            b"\x1cfield\x1dfield\x1efield\xc2\x85field\xe2\x80\xa8field\xe2\x80\xa9tail"
        )

    def test_failed_environment_commit_removes_private_temporary_file(self):
        target = self.stage / "bot.env"
        previous = "previous-complete-environment\n"
        target.write_text(previous)
        target.chmod(0o600)
        self.write_exec(
            self.bin / "mv",
            f"""#!/bin/bash
for argument in "$@"; do
  if [[ "$argument" == {str(self.stage / "bot.env.new")!r} ]]; then
    stat -c '%a' "$argument" >{str(self.rec / "partial-mode")!r}
    exit 72
  fi
done
exec /bin/mv "$@"
""",
        )

        result = self.run_entry()

        with self.subTest("commit error is infrastructure failure"):
            self.assertOutcome(result, 4, "infra-error")
        with self.subTest("temporary file is removed"):
            self.assertFalse((self.stage / "bot.env.new").exists())
        self.assertEqual(target.read_text(), previous)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
        self.assertEqual((self.rec / "partial-mode").read_text().strip(), "600")
        self.assertFalse(self.has_event("compose-up"))

    def test_signal_during_partial_generation_removes_only_temporary_file(self):
        target = self.stage / "bot.env"
        previous = "previous-complete-environment\n"
        target.write_text(previous)
        target.chmod(0o600)
        self.write_exec(
            self.bin / "python3",
            f"""#!{sys.executable}
import os, signal, sys, time
from pathlib import Path
temporary = Path({str(self.stage / "bot.env.new")!r})
if temporary.exists():
    temporary.write_text("TELEGRAM_SESSION_MASTER_KEY=incomplete-test-value\\n")
    os.kill(os.getppid(), signal.SIGTERM)
    time.sleep(0.02)
    temporary.write_text("TELEGRAM_SESSION_MASTER_KEY=incomplete-test-value-after-term\\n")
    Path({str(self.rec / "writer-settled")!r}).touch()
    raise SystemExit(0)
os.execv({sys.executable!r}, [{sys.executable!r}, *sys.argv[1:]])
""",
        )

        result = self.run_entry()

        self.assertOutcome(result, 143, "failed")
        self.assertTrue((self.rec / "writer-settled").exists())
        self.assertFalse((self.stage / "bot.env.new").exists())
        self.assertEqual(target.read_text(), previous)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
        self.assertFalse(self.has_event("compose-up"))
        self.assertNotIn("incomplete-test-value", result.stdout + result.stderr + self.record_text())

    def test_required_identity_removed_after_provisioning_is_an_infrastructure_error(self):
        target = self.stage / "bot.env"
        previous = "BOT_TOKEN=previous-token\nBOT_USERNAME=previous-stage-bot\n"
        target.write_text(previous)
        target.chmod(0o600)
        original = self.lib / "stage-fetch-artifact-original.py"
        (self.lib / "stage-fetch-artifact.py").rename(original)
        self.write_exec(
            self.lib / "stage-fetch-artifact.py",
            f"""#!{sys.executable}
import os, sys
from pathlib import Path
if sys.argv[1] == "current":
    stage_env = Path({str(self.stage / "stage.env")!r})
    lines = [line for line in stage_env.read_text().splitlines()
             if not line.startswith("BOT_TOKEN=")]
    stage_env.write_text("\\n".join(lines) + "\\n")
os.execv({sys.executable!r}, [{sys.executable!r}, {str(original)!r}, *sys.argv[1:]])
""",
        )

        result = self.run_entry()

        self.assertTrue(self.has_event("fetch-current"))
        self.assertTrue(self.has_event("docker-load"))
        with self.subTest("a failed required identity read is not a PR verdict"):
            self.assertOutcome(result, 4, "infra-error")
        with self.subTest("stage cannot start with a missing identity"):
            self.assertFalse(self.has_event("compose-up"))
            self.assertNotIn("STAGE_READY", result.stdout)
        with self.subTest("previous complete environment survives"):
            self.assertTrue(target.read_text() == previous, "the previous environment must be unchanged")
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
        self.assertFalse((self.stage / "bot.env.new").exists())
