"""scripts/stage-smoke.py QaCliTransport: the qa-cli transport behind `run` (send, wait, read, retries, exit codes); `guard` and the judging live in the sibling test_stage_smoke_*.py files (#805, #840)."""

import asyncio
import json
import os
import time
import unittest
from pathlib import Path

from stage_smoke_support import BASE_CASES, SHA, STAGE_PEER, Base, smoke

FAKE_QA = r'''#!/usr/bin/env python3
"""Fake `qa`: emulates `qa telegram chat send|wait|read|open` from a scenario file; logs every argv."""
import json, os, sys, time

state_dir = os.environ["FAKE_QA_DIR"]
argv = sys.argv[1:]
with open(os.path.join(state_dir, "calls.jsonl"), "a") as log:
    log.write(json.dumps(argv) + "\n")
scenario = json.load(open(os.path.join(state_dir, "scenario.json")))
state_path = os.path.join(state_dir, "state.json")
state = json.load(open(state_path)) if os.path.exists(state_path) else {"text": None, "reads": 0}


def emit(payload, code=0):
    if scenario.get("garbage"):
        print("this is not json")
        sys.exit(code)
    print("noise before the json line")
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(code)


if argv[:2] != ["telegram", "chat"] or len(argv) < 3 or argv[2] not in ("open", "send", "wait", "read"):
    emit({"ok": False, "error": "unexpected command"}, 99)
action = argv[2]
flags = {}
rest = argv[3:]
i = 0
while i < len(rest):
    arg = rest[i]
    if arg.startswith("--") and "=" in arg:
        key, _, value = arg.partition("=")
        flags[key] = value
        i += 1
    else:
        flags[arg] = rest[i + 1]
        i += 2
if flags.get("--peer") != scenario["peer"] or flags.get("--username") != scenario["username"]:
    emit({"ok": False, "error": "wrong peer"}, 99)

fail = scenario.get("fail", {}).get(action)
if fail:
    # "times" makes the failure transient: it happens that many times in a row, then the action works.
    failed = state.setdefault("failed", {})
    if failed.get(action, 0) < fail.get("times", 10**9):
        failed[action] = failed.get(action, 0) + 1
        json.dump(state, open(state_path, "w"))
        emit({"ok": False, "error": fail["error"]}, fail["code"])
if action == "open":
    emit({"ok": True, "peer": scenario["peer"], "last_id": 1})
if action == "send":
    text = flags["--text"]
    state.update(text=text, reads=0)
    json.dump(state, open(state_path, "w"))
    emit({"ok": True, "message": {"id": 100, "out": True, "text": text}})
script = scenario["texts"].get(state["text"], {})
if action == "wait":
    if flags.get("--after") != "100" or flags.get("--from") != "peer":
        emit({"ok": False, "error": "bad wait flags"}, 99)
    time.sleep(script.get("wait_sleep", 0))
    if script.get("hang"):
        time.sleep(30)
    first = script.get("first")
    if first is None:
        emit({"ok": False, "error": "timed out waiting for a message"}, 1)
    emit({"ok": True, "message": first})
if action == "read":
    if flags.get("--after") != "100":
        emit({"ok": False, "error": "bad read flags"}, 99)
    reads = script.get("reads", [[]])
    messages = reads[min(state["reads"], len(reads) - 1)]
    state["reads"] += 1
    json.dump(state, open(state_path, "w"))
    emit({"ok": True, "messages": messages})
'''


def msg(message_id, text, out=False):
    return {"id": message_id, "out": out, "text": text}


class QaCliTransportTests(Base):
    def setUp(self):
        super().setUp()
        self.qa = self.dir / "qa"
        self.qa.write_text(FAKE_QA)
        self.qa.chmod(0o755)
        self.scenario = {"peer": STAGE_PEER, "username": "HyperCalendarStageBot", "texts": {}}
        os.environ["FAKE_QA_DIR"] = str(self.dir)
        self.addCleanup(lambda: os.environ.pop("FAKE_QA_DIR", None))
        self.save()

    def save(self):
        (self.dir / "scenario.json").write_text(json.dumps(self.scenario))

    def calls(self):
        path = self.dir / "calls.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def transport(self, **attrs):
        transport = smoke.QaCliTransport(str(self.qa), STAGE_PEER, "HyperCalendarStageBot")
        transport.poll_interval = 0.01
        for key, value in attrs.items():
            setattr(transport, key, value)
        return transport

    def exchange(self, text, timeout=5, settle=0.05, **attrs):
        async def go():
            async with self.transport(**attrs) as transport:
                return await transport.exchange(text, timeout, settle)

        return asyncio.run(go())

    def test_send_wait_read_argv_is_exact_and_nothing_else_is_invoked(self):
        self.scenario["texts"]["/ping"] = {
            "first": msg(101, "pong"),
            "reads": [[msg(100, "/ping", out=True), msg(101, "pong")]],
        }
        self.save()
        replies = self.exchange("/ping", timeout=7)
        self.assertEqual([text for text, _ in replies], ["pong"])
        calls = self.calls()
        base = ["telegram", "chat"]
        ident = ["--peer", STAGE_PEER, "--username", "HyperCalendarStageBot"]
        self.assertEqual(calls[0], [*base, "send", *ident, "--text", "/ping"])
        self.assertEqual(
            calls[1], [*base, "wait", *ident, "--after", "100", "--from", "peer", "--timeout", "7"]
        )
        for call in calls[2:]:
            self.assertEqual(call, [*base, "read", *ident, "--after", "100"])
        self.assertGreaterEqual(len(calls), 3)
        self.assertTrue(
            all(call[:2] == base and call[2] in ("open", "send", "wait", "read") for call in calls)
        )

    def test_text_travels_as_one_argv_element_without_a_shell(self):
        text = "что у меня завтра? \"quoted\" 'single' $(touch pwned) `touch pwned2` ; && | * a  b"
        self.scenario["texts"][text] = {"first": msg(101, "ok")}
        self.save()
        self.exchange(text)
        send = self.calls()[0]
        self.assertEqual(send[send.index("--text") + 1], text)
        self.assertEqual(len(send), 9)
        self.assertFalse((self.dir / "pwned").exists() or (Path.cwd() / "pwned").exists())
        self.assertFalse((self.dir / "pwned2").exists() or (Path.cwd() / "pwned2").exists())

    def test_a_text_starting_with_a_dash_is_still_a_single_argv_element_argparse_can_take(self):
        self.scenario["texts"]["-5 minutes"] = {"first": msg(101, "ok")}
        self.save()
        self.exchange("-5 minutes")
        send = self.calls()[0]
        self.assertEqual(len(send), 8)
        self.assertEqual(send[-1], "--text=-5 minutes")

    def test_further_incoming_messages_are_collected_and_outgoing_ones_ignored(self):
        self.scenario["texts"]["q"] = {
            "first": msg(101, "part 1"),
            "reads": [
                [msg(101, "part 1")],
                [msg(100, "q", out=True), msg(101, "part 1"), msg(102, "part 2")],
            ],
        }
        self.save()
        replies = self.exchange("q", settle=2)
        self.assertEqual([text for text, _ in replies], ["part 1", "part 2"])

    def test_an_edited_message_replaces_its_earlier_text(self):
        self.scenario["texts"]["q"] = {
            "first": msg(101, "thinking..."),
            "reads": [[msg(101, "thinking...")], [msg(101, "the real answer")]],
        }
        self.save()
        replies = self.exchange("q", settle=2)
        self.assertEqual([text for text, _ in replies], ["the real answer"])

    COLD = "timed out after 30s waiting for Telegram Web to load"

    def count(self, action):
        return sum(1 for call in self.calls() if call[2] == action)

    def test_a_send_that_times_out_loading_telegram_web_is_retried_because_nothing_was_sent(self):
        # The first call of a run starts a cold headless browser on a busy host; that load is slow, not broken.
        self.scenario["fail"] = {"send": {"code": 1, "error": self.COLD, "times": 2}}
        self.scenario["texts"]["/ping"] = {"first": msg(101, "pong"), "reads": [[msg(101, "pong")]]}
        self.save()
        replies = self.exchange("/ping", retry_delay=0)
        self.assertEqual([text for text, _ in replies], ["pong"])
        self.assertEqual(self.count("send"), 3)

    def test_the_search_and_open_timeouts_before_a_send_are_retried_too(self):
        for error in (
            "timed out after 10s waiting for search result for @HyperCalendarStageBot",
            "timed out after 10s waiting for chat 8898802296 to open",
        ):
            with self.subTest(error):
                self.scenario["fail"] = {"send": {"code": 1, "error": error, "times": 1}}
                self.scenario["texts"]["/ping"] = {
                    "first": msg(101, "pong"),
                    "reads": [[msg(101, "pong")]],
                }
                self.save()
                (self.dir / "state.json").unlink(missing_ok=True)
                (self.dir / "calls.jsonl").unlink(missing_ok=True)
                self.assertEqual([t for t, _ in self.exchange("/ping", retry_delay=0)], ["pong"])

    def test_time_spent_retrying_the_send_does_not_shrink_the_window_for_the_answer(self):
        # Two cold-start retries of 0.3 s outlast the 0.5 s exchange budget; the answer still gets its full window.
        self.scenario["fail"] = {"send": {"code": 1, "error": self.COLD, "times": 2}}
        self.scenario["texts"]["q"] = {
            "first": msg(101, "part 1"),
            "reads": [[msg(101, "part 1"), msg(102, "part 2")]],
        }
        self.save()
        replies = self.exchange("q", timeout=0.5, settle=0.05, retry_delay=0.3)
        self.assertEqual([text for text, _ in replies], ["part 1", "part 2"])

    def test_a_cold_load_that_never_finishes_is_unavailable_after_three_attempts(self):
        self.scenario["fail"] = {"send": {"code": 1, "error": self.COLD}}
        self.save()
        with self.assertRaises(ConnectionError):
            self.exchange("/ping", retry_delay=0)
        self.assertEqual(self.count("send"), 3)

    def test_a_send_failing_for_any_other_reason_is_not_retried_in_case_it_was_delivered(self):
        self.scenario["fail"] = {
            "send": {
                "code": 1,
                "error": "timed out after 30s waiting for the message to be confirmed",
            }
        }
        self.save()
        with self.assertRaises(ConnectionError):
            self.exchange("/ping", retry_delay=0)
        self.assertEqual(self.count("send"), 1)

    def test_polling_stops_after_settle_seconds_without_a_change(self):
        self.scenario["texts"]["q"] = {"first": msg(101, "a"), "reads": [[msg(101, "a")]]}
        self.save()
        started = time.monotonic()
        self.exchange("q", timeout=30, settle=0.2)
        self.assertLess(time.monotonic() - started, 5)

    def test_polling_stops_at_the_timeout_even_if_the_chat_keeps_changing(self):
        reads = [[msg(101, "a" * n)] for n in range(1, 400)]
        self.scenario["texts"]["q"] = {"first": msg(101, "a"), "reads": reads}
        self.save()
        replies = self.exchange("q", timeout=1, settle=30)
        self.assertEqual(len(replies), 1)
        self.assertTrue(replies[0][0].startswith("a"))

    def test_first_reply_latency_is_the_time_between_send_and_wait_end(self):
        self.scenario["texts"]["q"] = {"first": msg(101, "a"), "wait_sleep": 0.4}
        self.save()
        replies = self.exchange("q")
        self.assertGreaterEqual(replies[0][1], 0.4)
        self.assertLess(replies[0][1], 5)

    def test_wait_timeout_means_no_replies_and_no_reads(self):
        self.scenario["texts"]["q"] = {"first": None}
        self.save()
        self.assertEqual(self.exchange("q", timeout=3), [])
        self.assertEqual([call[2] for call in self.calls()], ["send", "wait"])

    def test_exit_2_on_send_is_a_refusal(self):
        self.scenario["fail"] = {"send": {"code": 2, "error": "peer is not a bot"}}
        self.save()
        with self.assertRaisesRegex(smoke.Refused, "qa refused: peer is not a bot"):
            self.exchange("x")

    def test_exit_2_on_read_is_a_refusal_too(self):
        self.scenario["texts"]["q"] = {"first": msg(101, "a")}
        self.scenario["fail"] = {"read": {"code": 2, "error": "draft pending"}}
        self.save()
        with self.assertRaisesRegex(smoke.Refused, "qa refused: draft pending"):
            self.exchange("q")

    def test_exit_3_means_not_logged_in(self):
        for action in ("send", "wait"):
            self.scenario["fail"] = {action: {"code": 3, "error": "not logged in"}}
            self.save()
            with self.assertRaises(ConnectionError, msg=action):
                self.exchange("x")

    def test_a_failing_send_fails_closed_as_unavailable(self):
        self.scenario["fail"] = {"send": {"code": 1, "error": "composer not found"}}
        self.save()
        with self.assertRaisesRegex(ConnectionError, "composer not found"):
            self.exchange("x")

    def test_garbage_output_fails_closed_as_unavailable(self):
        self.scenario["garbage"] = True
        self.save()
        with self.assertRaises(ConnectionError):
            self.exchange("x")

    def test_a_missing_qa_binary_is_unavailable(self):
        transport = smoke.QaCliTransport(
            str(self.dir / "nope"), STAGE_PEER, "HyperCalendarStageBot"
        )

        async def go():
            async with transport:
                return await transport.exchange("x", 1, 0.01)

        with self.assertRaises(ConnectionError):
            asyncio.run(go())

    def test_a_hanging_call_is_killed_after_timeout_plus_grace(self):
        self.scenario["texts"]["q"] = {"hang": True, "first": msg(101, "a")}
        self.save()
        with self.assertRaisesRegex(ConnectionError, "did not finish"):
            self.exchange("q", timeout=1, call_grace=0.5)

    def test_a_newline_text_is_refused_and_qa_is_never_called(self):
        with self.assertRaisesRegex(smoke.Refused, "one line"):
            self.exchange("line one\nline two")
        self.assertEqual(self.calls(), [])

    def test_run_end_to_end_through_the_cli_with_the_fake_qa(self):
        self.scenario["texts"]["/ping"] = {"first": msg(101, "pong (3ms)")}
        self.scenario["texts"]["hi"] = {"first": msg(101, "hello")}
        self.save()
        cases_file = self.write(
            "c.json", json.dumps([{**case, "settle_s": 0} for case in BASE_CASES])
        )  # default 1 s polls would only slow the test
        code, out, err = self.call(
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
                "--qa-bin",
                self.qa,
                "--receipt",
                self.dir / "r.json",
            ]
        )
        self.assertEqual(code, 0, out + err)
        self.assertIn("SMOKE PASS ping", out)
        self.assertEqual([c[-1] for c in self.calls() if c[2] == "send"], ["/ping", "hi"])

    def test_run_exits_69_when_qa_is_not_logged_in_and_64_when_it_refuses(self):
        cases_file = self.write("c.json", json.dumps(BASE_CASES))
        argv = [
            "run",
            "--cases-json",
            cases_file,
            "--username",
            "HyperCalendarStageBot",
            "--peer",
            STAGE_PEER,
            "--sha",
            SHA,
            "--qa-bin",
            self.qa,
            "--receipt",
            self.dir / "r.json",
        ]
        for code_in, expected in ((3, smoke.UNAVAILABLE), (2, smoke.REFUSED)):
            self.scenario["fail"] = {"send": {"code": code_in, "error": "boom"}}
            self.save()
            code, _, err = self.call(argv)
            self.assertEqual(code, expected, err)
        self.assertFalse((self.dir / "r.json").exists())

    def test_run_exits_69_when_the_qa_binary_is_missing(self):
        cases_file = self.write("c.json", json.dumps(BASE_CASES))
        code, _, err = self.call(
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
                "--qa-bin",
                self.dir / "nope",
            ]
        )
        self.assertEqual(code, smoke.UNAVAILABLE)
        self.assertIn("STAGE_SMOKE_UNAVAILABLE", err)


class ScriptedTransport(smoke.QaCliTransport):
    """QaCliTransport whose qa() replays scripted (code, payload) answers per action instead of spawning a process."""

    def __init__(self, script):
        super().__init__("qa", STAGE_PEER, "HyperCalendarStageBot")
        self.poll_interval = 0
        self.script = {action: list(answers) for action, answers in script.items()}
        self.actions = []

    def qa(self, action, *flags, timeout):
        self.actions.append(action)
        answers = self.script[action]
        return answers.pop(0) if len(answers) > 1 else answers[0]


class ExchangeEdgeCases(unittest.TestCase):
    def exchange(self, script, settle=0.05, timeout=5):
        transport = ScriptedTransport(script)
        return transport, asyncio.run(transport.exchange("q", timeout, settle))

    def test_a_send_without_a_confirmed_message_id_fails_closed(self):
        cases = {
            "no message": ((0, {"ok": True}), "qa send failed: no confirmed message"),
            "message without id": (
                (0, {"ok": True, "message": {"text": "q"}}),
                "qa send failed: no confirmed message",
            ),
            "not ok": (
                (0, {"ok": False, "error": "composer gone"}),
                "qa send failed: composer gone",
            ),
            "exit 1": (
                (1, {"ok": True, "message": {"id": 1}, "error": "late"}),
                "qa send failed: late",
            ),
        }
        for label, (answer, message) in cases.items():
            with self.subTest(label), self.assertRaisesRegex(ConnectionError, message):
                self.exchange({"send": [answer]})

    def test_a_wait_that_fails_means_no_replies_and_no_reads(self):
        send = (0, {"ok": True, "message": {"id": 7}})
        for wait in ((1, {"ok": False}), (0, {"ok": False})):
            with self.subTest(wait=wait):
                transport, replies = self.exchange({"send": [send], "wait": [wait]})
                self.assertEqual((replies, transport.actions), ([], ["send", "wait"]))

    def test_a_failing_or_ignored_read_never_turns_a_good_answer_into_a_failure(self):
        send = (0, {"ok": True, "message": {"id": 7}})
        first = (0, {"ok": True, "message": {"id": 8}})
        ignored = (
            0,
            {
                "ok": True,
                "messages": [
                    {"id": 9, "text": "no out flag"},
                    {"id": 10, "out": True, "text": "mine"},
                ],
            },
        )
        transport, replies = self.exchange(
            {
                "send": [send],
                "wait": [first],
                "read": [(1, {"ok": False}), (0, {"ok": False}), ignored],
            },
            settle=0.1,
        )
        self.assertEqual([text for text, _ in replies], [""])
        self.assertEqual(transport.actions[:2], ["send", "wait"])
        self.assertEqual(set(transport.actions[2:]), {"read"})

    def test_a_reply_without_text_counts_as_an_empty_reply_and_edits_replace_it(self):
        send = (0, {"ok": True, "message": {"id": 7}})
        first = (0, {"ok": True, "message": {"id": 8, "text": None}})
        read = (
            0,
            {
                "ok": True,
                "messages": [{"id": 8, "out": False, "text": "edited"}, {"id": 9, "out": False}],
            },
        )
        _, replies = self.exchange({"send": [send], "wait": [first], "read": [read]})
        self.assertEqual([text for text, _ in replies], ["edited", ""])

    def test_a_newline_in_the_text_is_refused_before_anything_is_sent(self):
        transport = ScriptedTransport({})
        with self.assertRaisesRegex(smoke.Refused, "case exchange: the send text must be one line"):
            asyncio.run(transport.exchange("a\nb", 5, 0.05))
        self.assertEqual(transport.actions, [])


if __name__ == "__main__":
    unittest.main()
