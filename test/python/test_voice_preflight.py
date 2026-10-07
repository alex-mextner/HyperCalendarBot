"""Offline checks must never mistake prerequisites for a working call."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("voice_preflight", ROOT / "scripts/voice-preflight.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class VoicePreflightTests(unittest.TestCase):
    def test_bridge_client_is_supplied_by_pyrofork_distribution(self):
        def version(name):
            if name == "pyrofork":
                return "synthetic"
            raise module.importlib.metadata.PackageNotFoundError(name)

        with patch.object(module.importlib.metadata, "version", side_effect=version):
            report = module.collect(Path("/nonexistent"), {})
        self.assertTrue(report["packages"]["pyrofork"])
        self.assertNotIn("pyrogram", report["packages"])
        self.assertNotIn("pyrofork", report["missing_prerequisites"])

    def test_missing_prerequisites_are_reported_without_loading_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".env").write_text("MTPROTO_API_HASH=do-not-read")
            with patch.object(Path, "read_text", side_effect=AssertionError("no file reads")):
                report = module.collect(root, {}, lambda name: False, lambda name: None)
        self.assertFalse(report["live_call_ready"])
        self.assertIn("session_file", report["missing_prerequisites"])
        self.assertIn("MTPROTO_API_HASH", report["missing_prerequisites"])
        self.assertNotIn("do-not-read", json.dumps(report))

    def test_all_prerequisites_still_require_identity_media_and_voice_proof(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "data").mkdir()
            (root / "data/voice_caller.session").write_text("private-session")
            env = dict.fromkeys(module.REQUIRED_ENV, "private-credential")
            with patch.object(Path, "read_bytes", side_effect=AssertionError("no session reads")):
                report = module.collect(root, env, lambda name: True, lambda name: "/synthetic/bin")
        self.assertFalse(report["live_call_ready"])
        self.assertEqual(report["missing_prerequisites"], [])
        self.assertIn("service_identity", report["unverified"])
        self.assertIn("ntgcalls_network_patch", report["unverified"])
        self.assertIn("bracho_tts", report["unverified"])
        self.assertNotIn("private-credential", json.dumps(report))
        self.assertNotIn("private-session", json.dumps(report))

    def test_empty_environment_values_count_as_missing_like_service_tier(self):
        # src/config/env.ts maps "" to unset, so ServiceTier is disabled for blank keys.
        report = module.collect(Path("/nonexistent"), dict.fromkeys(module.REQUIRED_ENV, ""),
                                lambda name: False, lambda name: None)
        self.assertEqual(report["environment"]["MTPROTO_API_HASH"], "empty")
        self.assertIn("MTPROTO_API_HASH", report["missing_prerequisites"])
        self.assertIn("configuration_values", report["unverified"])

    def run_main(self, argv, report):
        with (patch("sys.argv", ["voice-preflight.py", *argv]),
              patch.object(module, "collect", return_value=report),
              patch("builtins.print")):
            return module.main()

    def test_result_exit_codes_never_collide_with_usage_errors_or_crashes(self):
        self.assertEqual(self.run_main([], {"missing_prerequisites": ["session_file"]}), 3)
        self.assertEqual(self.run_main([], {"missing_prerequisites": []}), 4)
        with self.assertRaises(SystemExit) as usage, patch("sys.stderr"):
            self.run_main(["--unknown"], {"missing_prerequisites": []})
        self.assertEqual(usage.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
