"""scripts/stage-smoke.py `run`: the PC run judges real answers through a transport and writes the receipt (#805, #840)."""

import json
import stat
import unittest

from stage_smoke_support import (
    BASE_CASES,
    REPLAY_CASES,
    SHA,
    STAGE_PEER,
    Base,
    FakeTransport,
    smoke,
)


class RunTests(Base):
    """`run` executes the guarded case list on the PC through a transport and judges the answers."""

    def setUp(self):
        super().setUp()
        self.receipt = self.dir / "receipt.json"

    def run_smoke(
        self,
        answers=None,
        cases=None,
        factory=None,
        extra=(),
        username="HyperCalendarStageBot",
        peer=STAGE_PEER,
    ):
        transport = FakeTransport(
            answers
            if answers is not None
            else {"/ping": [("pong (3ms)", 0.4)], "hi": [("hello", 1.0)]}
        )
        cases_file = self.write(
            "cases-json.json", json.dumps(BASE_CASES if cases is None else cases)
        )
        argv = [
            "run",
            "--cases-json",
            cases_file,
            "--username",
            username,
            "--peer",
            peer,
            "--sha",
            SHA,
            "--deny",
            "HyperCalendarBot",
            "--receipt",
            self.receipt,
            *extra,
        ]
        code, out, err = self.call(argv, transport_factory=factory or (lambda: transport))
        return code, out, err, transport

    def test_passing_run_sends_every_case_and_writes_a_0600_receipt_for_the_sha(self):
        code, out, _, transport = self.run_smoke()
        self.assertEqual(code, 0, out)
        self.assertEqual(transport.sent, ["/ping", "hi"])
        self.assertIn(
            f"STAGE_SMOKE_PASSED sha={SHA} bot=@HyperCalendarStageBot cases=2 failed=0", out
        )
        receipt = json.loads(self.receipt.read_text())
        self.assertEqual((receipt["sha"], receipt["passed"], len(receipt["cases"])), (SHA, True, 2))
        self.assertEqual(receipt["bot"], "HyperCalendarStageBot")
        self.assertEqual(stat.S_IMODE(self.receipt.stat().st_mode), 0o600)

    def test_missing_answer_fails_the_run_and_the_receipt_says_so(self):
        code, out, _, _ = self.run_smoke(answers={"/ping": [("pong", 0.2)]})
        self.assertEqual(code, 1, out)
        self.assertIn("SMOKE FAIL no-error", out)
        self.assertIn("STAGE_SMOKE_FAILED", out)
        self.assertIn("cases=2 failed=1", out)
        self.assertFalse(json.loads(self.receipt.read_text())["passed"])

    def test_wrong_answer_text_fails(self):
        code, out, _, _ = self.run_smoke(
            answers={"/ping": [("something else", 0.2)], "hi": [("ok", 0.2)]}
        )
        self.assertEqual(code, 1)
        self.assertIn("no reply matched any of the expected patterns", out)

    def test_a_failed_case_prints_what_the_stage_bot_answered_one_line_and_cut_short(self):
        long_reply = "line one\nline two " + "x" * 400
        code, out, _, _ = self.run_smoke(
            answers={"/ping": [("something else", 0.2), (long_reply, 0.3)], "hi": [("ok", 0.2)]}
        )
        self.assertEqual(code, 1)
        self.assertIn("SMOKE REPLY ping #1: something else", out)
        second = next(line for line in out.splitlines() if line.startswith("SMOKE REPLY ping #2: "))
        self.assertTrue(second.startswith("SMOKE REPLY ping #2: line one line two xxx"))
        self.assertEqual(len(second), len("SMOKE REPLY ping #2: ") + smoke.REPLY_PREVIEW_CHARS)

    def test_a_passing_case_prints_no_reply_text(self):
        code, out, _, _ = self.run_smoke()
        self.assertEqual(code, 0, out)
        self.assertNotIn("SMOKE REPLY", out)

    def test_forbidden_text_fails(self):
        code, out, _, _ = self.run_smoke(
            answers={"/ping": [("pong", 0.2)], "hi": [("Traceback (most recent call last)", 0.2)]}
        )
        self.assertEqual(code, 1)
        self.assertIn("forbidden pattern", out)

    def test_slow_first_reply_fails_the_latency_limit(self):
        code, out, _, _ = self.run_smoke(answers={"/ping": [("pong", 9.0)], "hi": [("ok", 0.1)]})
        self.assertEqual(code, 1)
        self.assertIn("limit 5s", out)

    def test_a_later_part_of_the_answer_can_satisfy_the_pattern(self):
        code, _, _, _ = self.run_smoke(
            answers={"/ping": [("...", 0.3), ("pong (2ms)", 0.9)], "hi": [("ok", 0.1)]}
        )
        self.assertEqual(code, 0)

    def test_replay_cases_in_the_list_are_reported_with_their_source(self):
        answers = {
            "/ping": [("pong", 0.1)],
            "hi": [("ok", 0.1)],
            "what is on tomorrow": [("tomorrow: nothing", 0.2)],
            "move it": [("done", 0.1)],
        }
        code, out, _, transport = self.run_smoke(
            answers=answers,
            cases=BASE_CASES + REPLAY_CASES,
            extra=("--base-cases", "2", "--min-cases", "2"),
        )
        self.assertEqual(code, 0, out)
        self.assertEqual(transport.sent, ["/ping", "hi", "what is on tomorrow", "move it"])
        receipt = json.loads(self.receipt.read_text())
        self.assertEqual(receipt["cases"][2]["source"], "history:ep-17")
        self.assertIn("source=history:ep-17", out)

    def test_a_failing_replay_case_fails_the_run(self):
        answers = {
            "/ping": [("pong", 0.1)],
            "hi": [("ok", 0.1)],
            "what is on tomorrow": [("nothing", 0.2)],
            "move it": [("ok", 0.1)],
        }
        code, out, _, _ = self.run_smoke(
            answers=answers, cases=BASE_CASES + REPLAY_CASES, extra=("--base-cases", "2")
        )
        self.assertEqual(code, 1)
        self.assertIn("SMOKE FAIL replay-1", out)

    # --- run refuses on its own, never trusting the odroid's guard ------------------------------

    def assertRefused(self, code, err, transport, needle):
        self.assertEqual(code, smoke.REFUSED, err)
        self.assertIn(needle, err)
        self.assertEqual(transport.sent, [])
        self.assertFalse(self.receipt.exists())

    def test_refuses_a_production_username_even_when_not_denied_by_name_shape(self):
        code, _, err, t = self.run_smoke(username="HyperCalendarBot")
        self.assertRefused(code, err, t, "production bot")

    def test_deny_list_ignores_case_and_at_sign(self):
        code, _, err, t = self.run_smoke(
            username="HYPERCALENDARBOT", extra=("--deny", "@hypercalendarstagebot")
        )
        self.assertRefused(code, err, t, "production bot")

    def test_refuses_a_username_that_does_not_look_like_a_stage_bot(self):
        code, _, err, t = self.run_smoke(username="SomeOtherBot")
        self.assertRefused(code, err, t, "stage")

    def test_refuses_a_malformed_username(self):
        code, _, err, t = self.run_smoke(username="bad name;rm")
        self.assertRefused(code, err, t, "username")

    def test_refuses_a_non_numeric_peer(self):
        code, _, err, t = self.run_smoke(peer="@HyperCalendarStageBot")
        self.assertRefused(code, err, t, "peer")

    def test_empty_case_list_is_refused_not_passed(self):
        code, _, err, t = self.run_smoke(cases=[])
        self.assertRefused(code, err, t, "no smoke cases")

    def test_base_list_below_the_floor_is_refused(self):
        code, _, err, t = self.run_smoke(extra=("--min-cases", "3"))
        self.assertRefused(code, err, t, "at least 3")

    def test_replay_cases_cannot_fill_the_floor(self):
        code, _, err, t = self.run_smoke(
            cases=BASE_CASES + REPLAY_CASES, extra=("--min-cases", "3", "--base-cases", "2")
        )
        self.assertRefused(code, err, t, "at least 3")

    def test_base_cases_larger_than_the_list_is_refused(self):
        code, _, err, t = self.run_smoke(extra=("--base-cases", "9"))
        self.assertRefused(code, err, t, "base")

    def test_duplicate_names_are_refused(self):
        code, _, err, t = self.run_smoke(cases=[BASE_CASES[0], BASE_CASES[0]])
        self.assertRefused(code, err, t, "duplicate case name 'ping'")

    def test_a_case_that_asserts_nothing_is_refused(self):
        code, _, err, t = self.run_smoke(cases=[{"name": "x", "send": "hi", "min_replies": 0}])
        self.assertRefused(code, err, t, "asserts nothing")

    def test_a_multi_line_send_text_is_refused_before_anything_is_sent(self):
        code, _, err, t = self.run_smoke(cases=[{"name": "x", "send": "a\nb", "forbid": ["y"]}])
        self.assertRefused(code, err, t, "one line")

    def test_a_non_list_cases_file_is_refused(self):
        cases_file = self.write("obj.json", "{}")
        code, _, _err = self.call(
            [
                "run",
                "--cases-json",
                cases_file,
                "--username",
                "HyperCalendarStageBot",
                "--peer",
                STAGE_PEER,
                "--sha",
                SHA,
            ],
            transport_factory=lambda: FakeTransport({}),
        )
        self.assertEqual(code, smoke.REFUSED)

    def test_unavailable_transport_fails_closed(self):
        class Broken:
            async def __aenter__(self):
                raise ConnectionError("qa-cli is not logged in")

            async def __aexit__(self, *exc):
                return False

        code, _, err, _ = self.run_smoke(factory=Broken)
        self.assertEqual(code, smoke.UNAVAILABLE)
        self.assertIn("STAGE_SMOKE_UNAVAILABLE", err)
        self.assertFalse(self.receipt.exists())

    def test_a_transport_refusal_aborts_the_run_with_64_and_no_receipt(self):
        class Refusing(FakeTransport):
            async def exchange(self, text, timeout, settle):
                raise smoke.Refused("qa refused: not a bot")

        code, _, err, _ = self.run_smoke(factory=lambda: Refusing({}))
        self.assertEqual(code, smoke.REFUSED)
        self.assertIn("qa refused: not a bot", err)
        self.assertFalse(self.receipt.exists())

    def test_timeout_scale_multiplies_the_case_timeout(self):
        seen = []

        class Spy(FakeTransport):
            async def exchange(self, text, timeout, settle):
                seen.append((timeout, settle))
                return [("pong", 0.1)]

        cases = [{"name": "a", "send": "x", "timeout_s": 10, "settle_s": 2, "expect": ["pong"]}]
        code, _, _, _ = self.run_smoke(
            cases=cases, factory=lambda: Spy({}), extra=("--timeout-scale", "0.5")
        )
        self.assertEqual(code, 0)
        self.assertEqual(seen, [(5.0, 2)])


if __name__ == "__main__":
    unittest.main()
