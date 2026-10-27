"""Unit-level characterization of stage-qa-pc.py load_config / validate_ready: the exact refusal text.

test_stage_qa_pc.py drives the whole script through a fake ssh and only asserts exit codes; these
call the two validators directly so every refusal branch keeps its own message.
"""
import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from test_stage_qa_pc import DRIVER, OTHER_SHA, PEER, REQUIRED, SHA, USERNAME, base_cases, ready_payload

FIELDS = ("ssh_target", "ssh_key", "username")


def load_driver_module():
    spec = importlib.util.spec_from_file_location("tested_stage_qa_pc", DRIVER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LoadConfigMessages(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.driver = load_driver_module()

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.path = self.tmp / "config.json"
        self.raw = {"ssh_target": "stage@odroid", "ssh_key": "/k/id", "username": USERNAME}

    def write(self, raw=None, mode=0o600):
        self.path.write_text(json.dumps(self.raw if raw is None else raw))
        self.path.chmod(mode)

    def assert_refused(self, message):
        with self.assertRaises(self.driver.NotProvisioned) as caught:
            self.driver.load_config(str(self.path))
        self.assertEqual(str(caught.exception), message)

    def test_a_valid_config_is_loaded_with_defaults(self):
        self.write({**self.raw, "ssh_known_hosts": "/k/known"})
        config = self.driver.load_config(str(self.path))
        self.assertEqual((config.ssh_target, config.ssh_key, config.ssh_known_hosts), ("stage@odroid", "/k/id", "/k/known"))
        self.assertEqual((config.username, config.min_cases, config.smoke_timeout), (USERNAME, 5, 1500))
        self.assertEqual(config.deny_usernames, ("HyperCalendarBot",))
        self.assertEqual(config.required_cases, tuple(REQUIRED))
        self.assertEqual(config.lock_file, os.path.expanduser("~/.local/state/hypercal-stage-qa/qa.lock"))

    def test_explicit_values_override_the_defaults(self):
        self.write({**self.raw, "min_cases": 3, "lock_max_wait": 0, "required_cases": ["a"], "deny_usernames": []})
        config = self.driver.load_config(str(self.path))
        self.assertEqual((config.min_cases, config.lock_max_wait, config.required_cases, config.deny_usernames), (3, 0, ("a",), ()))

    def test_known_hosts_is_optional(self):
        self.write()
        self.assertIsNone(self.driver.load_config(str(self.path)).ssh_known_hosts)

    def test_config_file_problems_have_specific_messages(self):
        self.assert_refused(f"config {self.path} not found; run scripts/install-stage-qa-pc.sh")
        self.path.mkdir()
        self.assert_refused(f"config: {self.path} is not a regular file")
        self.path.rmdir()
        self.write(mode=0o640)
        self.assert_refused(f"config: {self.path} has mode 0640; it must be 0600")
        self.path.write_text("{nope")
        self.path.chmod(0o600)
        self.assert_refused(f"config: {self.path} is not valid JSON (JSONDecodeError)")
        self.write([1])
        self.assert_refused(f"config: {self.path} must hold a JSON object")

    def test_unknown_and_missing_keys_have_specific_messages(self):
        self.write({**self.raw, "z": 1, "a": 2})
        self.assert_refused("config: unknown key(s): a, z")
        for key in FIELDS:
            with self.subTest(key):
                self.write({k: v for k, v in self.raw.items() if k != key})
                self.assert_refused(f"config: missing required key {key}")

    def test_config_value_problems_have_specific_messages(self):
        bad = {
            "ssh_target": ("-oProxyCommand=x@h", "config: ssh_target must look like user@host"),
            "username": ("HyperCalendarBot", "config: username must be a Telegram bot username containing stage or stg"),
            "min_cases": (0, "config: min_cases must be an integer >= 1"),
            "deny_usernames": ([f"@{USERNAME.upper()}"], "config: username is in deny_usernames"),
            "lock_max_wait": (-1, "config: lock_max_wait must be a number >= 0"),
            "smoke_timeout": (0, "config: smoke_timeout must be a number > 0"),
            "ready_timeout": ("7200", "config: ready_timeout must be a number > 0"),
            "required_cases": ([], "config: required_cases must not be empty"),
            "state_dir": ("state", "config: state_dir must be an absolute path (or start with ~)"),
            "python": ("", "config: python must be a non-empty string"),
            "ssh_known_hosts": ("known", "config: ssh_known_hosts must be an absolute path (or start with ~)"),
        }
        for key, (value, message) in bad.items():
            with self.subTest(key):
                self.write({**self.raw, key: value})
                self.assert_refused(message)


class ValidateReadyMessages(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.driver = load_driver_module()

    def setUp(self):
        self.config = self.driver.Config(
            ssh_target="stage@odroid", ssh_key="/k", ssh_known_hosts=None, username=USERNAME,
            deny_usernames=("HyperCalendarBot", "@Other"), qa_bin="/q", python="python3", lock_file="/l",
            lock_max_wait=1, state_dir="/s", min_cases=5, required_cases=tuple(REQUIRED),
            smoke_timeout=1, ready_timeout=1, done_timeout=1,
        )

    def validate(self, payload, config=None):
        text = payload if isinstance(payload, str) else json.dumps(payload)
        return self.driver.validate_ready(text, config or self.config, SHA)

    def assert_refused(self, payload, message, config=None):
        with self.assertRaises(self.driver.Refused) as caught:
            self.validate(payload, config)
        self.assertEqual(str(caught.exception), message)

    def test_ready_refusals_have_specific_messages(self):
        base = base_cases()
        cases = {
            "bad json": ("{", "STAGE_READY is not valid JSON"),
            "not an object": ([], "STAGE_READY payload is not an object"),
            "sha": (ready_payload(sha=OTHER_SHA), "STAGE_READY names another commit than the one requested"),
            "other bot": (ready_payload(username="SomeOtherStageBot"), "STAGE_READY names another bot than the configured stage bot"),
            "username not a string": (ready_payload(username=5), "STAGE_READY names another bot than the configured stage bot"),
            "peer": (ready_payload(peer="12ab"), "STAGE_READY peer is not a numeric bot id"),
            "no cases": (ready_payload(cases=[], base_cases=0), "STAGE_READY carries no cases"),
            "cases not a list": (ready_payload(cases="x"), "STAGE_READY carries no cases"),
            "nameless case": (ready_payload(cases=[{"name": ""}] * 5), "STAGE_READY has a case without a name"),
            "non-object case": (ready_payload(cases=["start"] * 5), "STAGE_READY has a case without a name"),
            "duplicate names": (ready_payload(cases=[*base[:4], base[0]]), "STAGE_READY has duplicate case names"),
            "base too large": (ready_payload(base_cases=6), "STAGE_READY base_cases is not a valid count"),
            "base zero": (ready_payload(base_cases=0), "STAGE_READY base_cases is not a valid count"),
            "base bool": (ready_payload(base_cases=True), "STAGE_READY base_cases is not a valid count"),
            "below the floor": (ready_payload(cases=base[:4], base_cases=4), "only 4 base cases; at least 5 are required"),
            "missing required": (
                ready_payload(cases=[dict(c, name="x") if c["name"] == "ping" else c for c in base]),
                "required base case(s) missing: ping",
            ),
            "required only in the extras": (
                ready_payload(cases=[*[dict(c, name=f"f{i}") for i, c in enumerate(base)], *base_cases(["start"])]),
                f"required base case(s) missing: {', '.join(REQUIRED)}",
            ),
        }
        for label, (payload, message) in cases.items():
            with self.subTest(label):
                self.assert_refused(payload, message)

    def test_a_denied_bot_is_refused(self):
        denied = self.config._replace(username="@Other", deny_usernames=("other",))
        self.assert_refused(ready_payload(username="OTHER"), "STAGE_READY names a denied (production) bot", denied)

    def test_a_bot_without_a_stage_marker_is_refused(self):
        unmarked = self.config._replace(username="Plain", deny_usernames=())
        self.assert_refused(ready_payload(username="Plain"), "STAGE_READY bot username does not contain stage or stg", unmarked)

    def test_a_valid_ready_is_returned_with_its_base_count(self):
        payload = ready_payload(username=USERNAME.upper())
        ready = self.validate(payload)
        self.assertEqual((ready.cases, ready.base_cases, ready.peer), (payload["cases"], 5, PEER))
        extra = ready_payload(cases=[*base_cases(), {"name": "replay-1"}], base_cases=5)
        self.assertEqual(self.validate(extra).base_cases, 5)


if __name__ == "__main__":
    unittest.main()
