"""prepare-runtime-dirs.sh must not hand the deploy's root-only evidence to the bot container (#823)."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/prepare-runtime-dirs.sh"


class PrepareRuntimeDirsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        self.deploy = self.path / "deploy"
        (self.deploy / "logs/chats/1").mkdir(parents=True)
        (self.deploy / "logs/chats/1/a.log").write_text("chat")
        (self.deploy / "logs/release-abc-2026").mkdir()
        (self.deploy / "logs/release-abc-2026/container.log.gz").write_text("raw")
        (self.deploy / "logs/failed-abc-2026").mkdir()
        (self.deploy / "logs/failed-abc-2026/state.txt").write_text("x")
        (self.deploy / "logs/healthcheck.log").write_text("hc")
        # chown to the current user succeeds without privileges; a recording stand-in shows what it touched.
        self.bin = self.path / "bin"
        self.bin.mkdir()
        self.chown_log = self.path / "chown.log"
        (self.bin / "chown").write_text(f'#!/bin/sh\nprintf "%s\\n" "$*" >> "{self.chown_log}"\n')
        (self.bin / "chown").chmod(0o755)

    def run_script(self):
        env = dict(
            os.environ,
            PATH=f"{self.bin}:{os.environ['PATH']}",
            BOT_UID=str(os.getuid()),
            BOT_GID=str(os.getgid()),
        )
        return subprocess.run(
            ["bash", str(SCRIPT), str(self.deploy)],
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )

    def test_evidence_directories_are_never_chowned_to_the_bot(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        touched = self.chown_log.read_text()
        self.assertNotIn("release-abc-2026", touched)
        self.assertNotIn("failed-abc-2026", touched)
        self.assertNotIn("container.log.gz", touched)
        self.assertNotIn("state.txt", touched)

    def test_the_bot_still_owns_its_data_and_its_own_logs(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        touched = self.chown_log.read_text()
        self.assertIn(str(self.deploy / "data"), touched)
        self.assertIn(str(self.deploy / "logs/chats/1/a.log"), touched)
        self.assertIn(str(self.deploy / "logs/healthcheck.log"), touched)


if __name__ == "__main__":
    unittest.main()
