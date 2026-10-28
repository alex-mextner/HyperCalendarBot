"""First-reply latency of stage-smoke.py counts from the start of the send attempt (#858).

`qa send` returns only after Telegram Web confirmed the message, and a slow bot can make that
confirmation slow too. The reported latency is the time since the send began (an upper bound on the
reply latency, not a precise typing moment); it must include that delay, so `max_first_reply_s` can
fail a slow bot, and must never restart the clock after the confirmation.
"""

import asyncio
import contextlib
import io
import json
import os
import types
import unittest
from unittest import mock

from test_stage_smoke import (
    FAKE_QA,
    SHA,
    STAGE_PEER,
    Base,
    msg,
    smoke,
)

SEND_CONFIRMATION_S = 2.0
WAIT_S = 0.05
READ_S = 1.0


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def monotonic(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class SlowConfirmationTransport(smoke.QaCliTransport):
    """qa() answers from a script and spends fake time: the send confirmation is slow."""

    def __init__(self, clock, send_s=SEND_CONFIRMATION_S):
        super().__init__("qa", STAGE_PEER, "HyperCalendarStageBot")
        self.poll_interval = 0
        self.clock = clock
        self.send_s = send_s

    def qa(self, action, *flags, timeout):
        if action == "send":
            self.clock.advance(self.send_s)
            return 0, {"ok": True, "message": {"id": 100, "out": True}}
        if action == "wait":
            self.clock.advance(WAIT_S)
            return 0, {"ok": True, "message": {"id": 101, "text": "pong"}}
        self.clock.advance(READ_S)
        return 0, {"ok": True, "messages": [{"id": 102, "out": False, "text": "pong again"}]}


class LatencyIncludesTheSendConfirmation(Base):
    def setUp(self):
        super().setUp()
        self.clock = FakeClock()
        patcher = mock.patch.object(
            smoke, "time", types.SimpleNamespace(monotonic=self.clock.monotonic)
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def exchange(self, send_s=SEND_CONFIRMATION_S):
        transport = SlowConfirmationTransport(self.clock, send_s)
        return asyncio.run(transport.exchange("/ping", 60, 0.5))

    def run_case(self, limit, send_s=SEND_CONFIRMATION_S):
        cases = self.write(
            "cases.json",
            json.dumps(
                [{"name": "ping", "send": "/ping", "expect": ["pong"], "max_first_reply_s": limit}]
            ),
        )
        argv = ["run", "--cases-json", cases, "--username", "HyperCalendarStageBot"]
        argv += ["--peer", STAGE_PEER, "--sha", SHA, "--deny", "HyperCalendarBot"]
        argv += ["--receipt", self.dir / "receipt.json"]
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = smoke.main(
                [str(a) for a in argv],
                transport_factory=lambda: SlowConfirmationTransport(self.clock, send_s),
            )
        return code, out.getvalue()

    def test_first_reply_latency_counts_the_slow_send_confirmation(self):
        (text, latency), *_ = self.exchange()
        self.assertEqual(text, "pong")
        self.assertAlmostEqual(latency, SEND_CONFIRMATION_S + WAIT_S)

    def test_a_later_message_is_measured_from_the_same_send_start(self):
        replies = self.exchange()
        latencies = {text: latency for text, latency in replies}
        self.assertEqual(set(latencies), {"pong", "pong again"})
        self.assertAlmostEqual(latencies["pong again"], SEND_CONFIRMATION_S + WAIT_S + READ_S)

    def test_max_first_reply_s_below_the_confirmation_delay_fails_the_case(self):
        code, out = self.run_case(limit=1)
        self.assertEqual(code, 1, out)
        self.assertIn("SMOKE FAIL ping", out)
        self.assertIn("first=2.05s problem=first reply took", out)
        self.assertIn(", limit 1s", out)
        self.assertFalse(json.loads((self.dir / "receipt.json").read_text())["passed"])

    def test_a_limit_above_the_whole_latency_still_passes(self):
        code, out = self.run_case(limit=5)
        self.assertEqual(code, 0, out)
        self.assertIn("SMOKE PASS ping", out)

    def test_a_fast_confirmation_does_not_fail_a_tight_limit(self):
        code, out = self.run_case(limit=1, send_s=0.01)
        self.assertEqual(code, 0, out)


SLOW_SEND_QA = FAKE_QA.replace(
    "    state.update(text=text, reads=0)\n",
    '    time.sleep(scenario.get("send_sleep", 0))\n    state.update(text=text, reads=0)\n',
    1,
)


class SlowSendThroughTheRealQaProcess(Base):
    """The real subprocess transport against a fake `qa` binary whose send confirmation is delayed."""

    def setUp(self):
        super().setUp()
        self.assertNotEqual(SLOW_SEND_QA, FAKE_QA)
        self.qa = self.dir / "qa"
        self.qa.write_text(SLOW_SEND_QA)
        self.qa.chmod(0o755)
        scenario = {
            "peer": STAGE_PEER,
            "username": "HyperCalendarStageBot",
            "send_sleep": 0.6,
            "texts": {"/ping": {"first": msg(101, "pong")}},
        }
        (self.dir / "scenario.json").write_text(json.dumps(scenario))
        patcher = mock.patch.dict(os.environ, {"FAKE_QA_DIR": str(self.dir)})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_the_delay_between_typing_and_the_confirmation_is_in_the_first_reply_latency(self):
        async def go():
            async with smoke.QaCliTransport(str(self.qa), STAGE_PEER, "HyperCalendarStageBot") as t:
                t.poll_interval = 0.01
                return await t.exchange("/ping", 5, 0.05)

        replies = asyncio.run(go())
        self.assertGreaterEqual(replies[0][1], 0.6)
        problems = smoke.judge({"expect": ["pong"], "max_first_reply_s": 0.3}, replies)
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("first reply took", problems[0])


if __name__ == "__main__":
    unittest.main()
