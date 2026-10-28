"""Shared fixtures of the stage-smoke test files: the engine loaded by path, fake credentials, the fake transport, the base case lists and the Base test case."""

import contextlib
import importlib.util
import io
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("stage_smoke", ROOT / "scripts/stage-smoke.py")
smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smoke)


# Fake filler, never real values: only the numeric bot id before the colon matters to the guards.
PROD_CRED = "111111111:" + "P" * 35
STAGE_CRED = "222222222:" + "S" * 35
STAGE_PEER = "222222222"
SHA = "a" * 40


def env_text(values):
    return "".join(f"{key}={value}\n" for key, value in values.items())


def bot_env(cred, username):
    return env_text({"BOT_TOKEN": cred, "BOT_USERNAME": username})


class FakeTransport:
    """Answers from a script: {send text: [(reply, seconds)]}. Records what was sent."""

    def __init__(self, answers):
        self.answers = answers
        self.sent = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def exchange(self, text, timeout, settle):
        self.sent.append(text)
        return self.answers.get(text, [])


BASE_CASES = [
    {"name": "ping", "send": "/ping", "expect": ["pong"], "max_first_reply_s": 5},
    {"name": "no-error", "send": "hi", "forbid": ["Traceback"]},
]
REPLAY_CASES = [
    {
        "name": "replay-1",
        "send": "what is on tomorrow",
        "expect": ["tomorrow"],
        "source": "history:ep-17",
    },
    {"name": "replay-2", "send": "move it", "forbid": ["Traceback"]},
]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def write(self, name, text):
        path = self.dir / name
        path.write_text(text)
        return path

    def call(self, argv, **seams):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = smoke.main([str(a) for a in argv], **seams)
        return code, out.getvalue(), err.getvalue()
