"""The unsupported legacy activation route refuses before build or transport.

Command tripwires are benign fixtures. No archive, Docker, network or remote
activation is performed by these tests.
"""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FALLBACK = ROOT / "scripts/deploy-local-fallback.sh"


class LocalFallbackStagingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.record = self.root / "external-command"
        for name in ("git", "bun", "docker", "container", "ssh", "scp"):
            command = self.bin / name
            command.write_text(
                "#!/bin/sh\n"
                f"printf '%s\\n' '{name}' >> '{self.record}'\n"
                "exit 91\n"
            )
            command.chmod(0o755)

    def run_fallback(self, *arguments):
        return subprocess.run(
            ["/bin/bash", str(FALLBACK), *arguments],
            cwd=self.root,
            env={"PATH": f"{self.bin}{os.pathsep}/usr/bin{os.pathsep}/bin"},
            text=True, capture_output=True, timeout=3,
        )

    def test_refuses_before_checkout_or_toolchain_commands(self):
        result = self.run_fallback()
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("native-activation-control-v3", result.stderr)
        self.assertFalse(self.record.exists())
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ["bin"])

    def test_skip_tests_does_not_enable_unsupported_transport(self):
        result = self.run_fallback("--ref", "a" * 40, "--skip-tests")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("native-activation-control-v3", result.stderr)
        self.assertFalse(self.record.exists())

    def test_help_remains_available_without_starting_any_work(self):
        result = self.run_fallback("--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Usage:", result.stdout)
        self.assertFalse(self.record.exists())


if __name__ == "__main__":
    unittest.main()
