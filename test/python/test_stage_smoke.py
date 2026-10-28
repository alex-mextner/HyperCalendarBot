"""scripts/stage-smoke.py: `guard` (odroid) and `run` (PC, qa-cli) judge real answers and refuse anything that could reach production (#805, #840)."""

import asyncio
import contextlib
import importlib.util
import io
import json
import os
import stat
import tempfile
import time
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


class GuardTests(Base):
    """`guard` runs on the odroid next to the stage env; it proves the target is not production and emits the validated cases."""

    def setUp(self):
        super().setUp()
        self.stage_env = self.write("stage.env", bot_env(STAGE_CRED, "HyperCalendarStageBot"))
        self.prod_env = self.write("prod.env", bot_env(PROD_CRED, "HyperCalendarBot"))
        self.cases = self.write("cases.json", json.dumps(BASE_CASES))

    def guard(self, stage_env=None, prod_env=None, cases=None, get_me=None, extra=()):
        argv = [
            "guard",
            "--cases",
            cases or self.cases,
            "--stage-env",
            stage_env or self.stage_env,
            "--prod-env",
            prod_env or self.prod_env,
            *extra,
        ]
        return self.call(argv, get_me=get_me or (lambda cred: "HyperCalendarStageBot"))

    def test_success_prints_one_compact_ascii_stage_guard_line_with_username_peer_and_cases(self):
        code, out, err = self.guard()
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(out.count("\n"), 1)
        self.assertTrue(out.startswith("STAGE_GUARD "))
        raw = out[len("STAGE_GUARD ") :].strip()
        self.assertNotIn(", ", raw)
        self.assertNotIn(": ", raw)
        payload = json.loads(raw)
        self.assertEqual(
            payload,
            {
                "username": "HyperCalendarStageBot",
                "peer": STAGE_PEER,
                "cases": BASE_CASES,
                "base_cases": 2,
            },
        )

    def test_non_ascii_cases_are_escaped_on_the_wire_but_round_trip(self):
        cases = self.write(
            "ru.json",
            json.dumps([{"name": "ru", "send": "что у меня завтра?", "forbid": ["Traceback"]}]),
        )
        code, out, _ = self.guard(cases=cases)
        self.assertEqual(code, 0)
        self.assertTrue(out.isascii())
        self.assertEqual(
            json.loads(out[len("STAGE_GUARD ") :])["cases"][0]["send"], "что у меня завтра?"
        )

    def test_the_token_never_reaches_stdout_or_stderr(self):
        code, out, err = self.guard()
        self.assertEqual(code, 0)
        self.assertNotIn("S" * 35, out + err)

    def test_extra_cases_follow_the_base_cases_and_base_cases_counts_only_the_base(self):
        replay = self.write("replay.json", json.dumps(REPLAY_CASES))
        code, out, _ = self.guard(extra=("--extra-cases", replay))
        self.assertEqual(code, 0)
        payload = json.loads(out[len("STAGE_GUARD ") :])
        self.assertEqual(
            [c["name"] for c in payload["cases"]], ["ping", "no-error", "replay-1", "replay-2"]
        )
        self.assertEqual(payload["cases"][2]["source"], "history:ep-17")
        self.assertEqual(payload["base_cases"], 2)

    def test_refuses_the_production_username(self):
        env = self.write("same.env", bot_env(STAGE_CRED, "HyperCalendarBot"))
        code, out, err = self.guard(stage_env=env, get_me=lambda cred: "HyperCalendarBot")
        self.assertEqual(code, smoke.REFUSED)
        self.assertIn("production bot", err)
        self.assertNotIn("STAGE_GUARD", out)

    def test_production_username_check_ignores_case_and_at_sign(self):
        env = self.write("same.env", bot_env(STAGE_CRED, "@hypercalendarbot"))
        code, _, _ = self.guard(stage_env=env)
        self.assertEqual(code, smoke.REFUSED)

    def test_refuses_usernames_listed_with_deny_even_when_the_prod_env_is_missing(self):
        code, _, _ = self.guard(
            prod_env=self.dir / "absent.env", extra=("--deny", "@HyperCalendarStageBot")
        )
        self.assertEqual(code, smoke.REFUSED)

    def test_refuses_the_inline_bot_username_of_prod(self):
        prod = self.write(
            "prod2.env",
            bot_env(PROD_CRED, "HyperCalendarBot") + "INLINE_BOT_USERNAME=HyperCalendarStageBot\n",
        )
        code, _, err = self.guard(prod_env=prod)
        self.assertEqual(code, smoke.REFUSED)
        self.assertIn("production bot", err)

    def test_refuses_a_username_that_does_not_look_like_a_stage_bot(self):
        env = self.write("other.env", bot_env(STAGE_CRED, "SomeOtherBot"))
        code, out, err = self.guard(stage_env=env, get_me=lambda cred: "SomeOtherBot")
        self.assertEqual(code, smoke.REFUSED)
        self.assertIn("stage", err)
        self.assertNotIn("STAGE_GUARD", out)

    def test_refuses_the_production_credential_under_a_stage_looking_name(self):
        env = self.write("cred.env", bot_env(PROD_CRED, "HyperCalendarStageBot"))
        code, out, err = self.guard(stage_env=env)
        self.assertEqual(code, smoke.REFUSED)
        self.assertIn("production token", err)
        self.assertNotIn("STAGE_GUARD", out)

    def test_refuses_when_the_credential_belongs_to_another_bot_than_the_configured_username(self):
        code, out, err = self.guard(get_me=lambda cred: "HyperCalendarBot")
        self.assertEqual(code, smoke.REFUSED)
        self.assertIn("belongs to @HyperCalendarBot", err)
        self.assertNotIn("STAGE_GUARD", out)

    def test_a_getme_failure_never_echoes_the_credential(self):
        def failing(cred):
            raise smoke.Refused("getMe for the stage token failed (URLError)")

        code, _, err = self.guard(get_me=failing)
        self.assertEqual(code, smoke.REFUSED)
        self.assertNotIn("S" * 35, err)

    def test_empty_case_list_is_refused_not_passed(self):
        code, out, err = self.guard(cases=self.write("empty.json", "[]"))
        self.assertEqual(code, smoke.REFUSED)
        self.assertIn("no smoke cases", err)
        self.assertNotIn("STAGE_GUARD", out)

    def test_a_case_that_asserts_nothing_is_refused(self):
        cases = self.write("weak.json", json.dumps([{"name": "x", "send": "hi", "min_replies": 0}]))
        code, _, err = self.guard(cases=cases)
        self.assertEqual(code, smoke.REFUSED)
        self.assertIn("asserts nothing", err)

    def test_a_case_that_passes_on_silence_is_refused_even_with_a_forbid(self):
        cases = self.write(
            "silent.json",
            json.dumps([{"name": "x", "send": "hi", "min_replies": 0, "forbid": ["Traceback"]}]),
        )
        code, _, err = self.guard(cases=cases)
        self.assertEqual(code, smoke.REFUSED)
        self.assertIn("asserts nothing", err)

    def test_case_fields_of_the_wrong_type_are_refused_not_iterated(self):
        # A string `expect` would be iterated per character and match (or forbid) almost any reply.
        for bad in (
            {"expect": "pong"},
            {"forbid": "Traceback"},
            {"expect": [""]},
            {"expect": [5]},
            {"min_replies": "2"},
            {"timeout_s": "40"},
            {"settle_s": None},
            {"max_first_reply_s": True},
        ):
            with self.subTest(bad=bad):
                cases = self.write(
                    "typed.json",
                    json.dumps([{"name": "x", "send": "hi", "forbid": ["Traceback"], **bad}]),
                )
                code, _, err = self.guard(cases=cases)
                self.assertEqual(code, smoke.REFUSED, bad)
                self.assertIn("STAGE_SMOKE_REFUSED", err)

    def test_a_multi_line_send_text_is_refused_as_a_case_problem(self):
        cases = self.write("nl.json", json.dumps([{"name": "x", "send": "a\nb", "forbid": ["y"]}]))
        code, _, err = self.guard(cases=cases)
        self.assertEqual(code, smoke.REFUSED)
        self.assertIn("one line", err)

    def test_min_cases_refuses_a_list_shorter_than_the_floor(self):
        code, _, err = self.guard(extra=("--min-cases", "3"))
        self.assertEqual(code, smoke.REFUSED)
        self.assertIn("2 smoke cases", err)
        self.assertIn("at least 3", err)

    def test_min_cases_counts_the_base_list_only_so_replay_cases_cannot_fill_the_floor(self):
        replay = self.write("replay.json", json.dumps(REPLAY_CASES))
        code, _, err = self.guard(extra=("--min-cases", "3", "--extra-cases", replay))
        self.assertEqual(code, smoke.REFUSED)
        self.assertIn("at least 3", err)

    def test_a_required_case_missing_from_the_list_is_refused(self):
        code, _, err = self.guard(extra=("--require-case", "ping", "--require-case", "validation"))
        self.assertEqual(code, smoke.REFUSED)
        self.assertIn("required case 'validation'", err)

    def test_all_required_cases_present_passes(self):
        code, _, _ = self.guard(
            extra=("--min-cases", "2", "--require-case", "ping", "--require-case", "no-error")
        )
        self.assertEqual(code, 0)

    def test_a_replay_case_cannot_reuse_a_base_case_name(self):
        shadow = self.write(
            "shadow.json", json.dumps([{"name": "ping", "send": "/ping", "forbid": ["never"]}])
        )
        code, _, err = self.guard(extra=("--extra-cases", shadow))
        self.assertEqual(code, smoke.REFUSED)
        self.assertIn("duplicate case name 'ping'", err)

    def test_an_empty_or_missing_replay_file_is_refused_not_ignored(self):
        for extra in (self.write("none.json", "[]"), self.dir / "absent.json"):
            code, _, err = self.guard(extra=("--extra-cases", extra))
            self.assertEqual(code, smoke.REFUSED, extra)
            self.assertIn("replay", err)

    def test_duplicate_case_names_in_one_list_are_refused(self):
        dup = self.write(
            "dup.json",
            json.dumps(
                [
                    {"name": "a", "send": "x", "forbid": ["y"]},
                    {"name": "a", "send": "z", "forbid": ["y"]},
                ]
            ),
        )
        code, _, err = self.guard(cases=dup)
        self.assertEqual(code, smoke.REFUSED)
        self.assertIn("duplicate case name 'a'", err)

    def test_the_shipped_case_list_passes_the_guard_with_the_trusted_floor(self):
        required = [
            "start",
            "ping",
            "today-read-only-calendar",
            "simple-intent-phrase",
            "validation-search-without-query",
        ]
        extra = ["--min-cases", "5"]
        for name in required:
            extra += ["--require-case", name]
        code, out, err = self.guard(cases=ROOT / "scripts/stage-smoke-cases.json", extra=extra)
        self.assertEqual(code, 0, err)
        self.assertGreaterEqual(json.loads(out[len("STAGE_GUARD ") :])["base_cases"], 5)

    def test_a_subcommand_is_required(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            smoke.main([])

    def test_the_old_telethon_flags_are_gone(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            smoke.main(
                [
                    "guard",
                    "--cases",
                    str(self.cases),
                    "--stage-env",
                    str(self.stage_env),
                    "--prod-env",
                    str(self.prod_env),
                    "--qa-env",
                    "x",
                ]
            )
        self.assertNotIn("telethon", Path(SPEC.origin).read_text().lower())


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
        code, out, _, _ = self.run_smoke(answers={"/ping": [("something else", 0.2), (long_reply, 0.3)], "hi": [("ok", 0.2)]})
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
        for error in ("timed out after 10s waiting for search result for @HyperCalendarStageBot",
                      "timed out after 10s waiting for chat 8898802296 to open"):
            with self.subTest(error):
                self.scenario["fail"] = {"send": {"code": 1, "error": error, "times": 1}}
                self.scenario["texts"]["/ping"] = {"first": msg(101, "pong"), "reads": [[msg(101, "pong")]]}
                self.save()
                (self.dir / "state.json").unlink(missing_ok=True)
                (self.dir / "calls.jsonl").unlink(missing_ok=True)
                self.assertEqual([t for t, _ in self.exchange("/ping", retry_delay=0)], ["pong"])

    def test_time_spent_retrying_the_send_does_not_shrink_the_window_for_the_answer(self):
        # Two cold-start retries of 0.3 s outlast the 0.5 s exchange budget; the answer still gets its full window.
        self.scenario["fail"] = {"send": {"code": 1, "error": self.COLD, "times": 2}}
        self.scenario["texts"]["q"] = {"first": msg(101, "part 1"), "reads": [[msg(101, "part 1"), msg(102, "part 2")]]}
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
        self.scenario["fail"] = {"send": {"code": 1, "error": "timed out after 30s waiting for the message to be confirmed"}}
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


class ValidateCasesMessages(unittest.TestCase):
    """validate_cases called directly: each rule keeps its own refusal text."""

    def refused(self, cases, message):
        with self.assertRaises(smoke.Refused) as caught:
            smoke.validate_cases(cases, "list.json")
        self.assertEqual(str(caught.exception), message)

    def test_a_good_list_is_returned_as_is(self):
        cases = [
            {
                "name": "a",
                "send": "hi",
                "expect": ["x"],
                "forbid": ["y"],
                "min_replies": 2,
                "timeout_s": 1.5,
            },
            {"name": "b", "send": "yo"},
        ]
        self.assertIs(smoke.validate_cases(cases, "list.json"), cases)

    def test_empty_or_non_list_input_is_refused(self):
        for cases in ([], None, {"a": 1}, "x"):
            with self.subTest(cases=cases):
                self.refused(
                    cases, "list.json has no smoke cases; an empty list must never pass a check"
                )
        with self.assertRaises(smoke.Refused) as caught:
            smoke.validate_cases([], "replay.json", "replay")
        self.assertEqual(
            str(caught.exception),
            "replay.json has no replay cases; an empty list must never pass a check",
        )

    def test_each_rule_has_a_specific_message(self):
        ok = {"name": "a", "send": "hi"}
        cases = {
            "not an object": ([ok, "x"], "case #1 needs a name and a send text"),
            "no name": ([{"send": "hi"}], "case #0 needs a name and a send text"),
            "send not a string": (
                [{"name": "a", "send": 5}],
                "case #0 needs a name and a send text",
            ),
            "empty send": ([{"name": "a", "send": ""}], "case #0 needs a name and a send text"),
            "duplicate": ([ok, dict(ok)], "duplicate case name 'a'"),
            "newline": ([{"name": "a", "send": "x\ny"}], "case a: the send text must be one line"),
            "carriage return": (
                [{"name": "a", "send": "x\ry"}],
                "case a: the send text must be one line",
            ),
            "string number": ([{**ok, "min_replies": "2"}], "case a: min_replies must be a number"),
            "bool number": ([{**ok, "timeout_s": True}], "case a: timeout_s must be a number"),
            "none number": ([{**ok, "settle_s": None}], "case a: settle_s must be a number"),
            "latency": (
                [{**ok, "max_first_reply_s": "1"}],
                "case a: max_first_reply_s must be a number",
            ),
            "expect string": (
                [{**ok, "expect": "pong"}],
                "case a: expect must be a list of non-empty patterns",
            ),
            "forbid empty pattern": (
                [{**ok, "forbid": [""]}],
                "case a: forbid must be a list of non-empty patterns",
            ),
            "expect non-string": (
                [{**ok, "expect": [5]}],
                "case a: expect must be a list of non-empty patterns",
            ),
            "asserts nothing": (
                [{**ok, "min_replies": 0}],
                "case a asserts nothing: min_replies must be at least 1",
            ),
            "negative replies": (
                [{**ok, "min_replies": -1}],
                "case a asserts nothing: min_replies must be at least 1",
            ),
        }
        for label, (cases_list, message) in cases.items():
            with self.subTest(label):
                self.refused(cases_list, message)

    def test_a_bad_pattern_is_refused_with_the_regex_error(self):
        for key in ("expect", "forbid"):
            with self.subTest(key):
                self.refused(
                    [{"name": "a", "send": "hi", key: ["ok", "("]}],
                    f"case a: bad {key} pattern (missing ), unterminated subpattern at position 0)",
                )

    def test_the_first_broken_rule_of_a_case_wins(self):
        broken = {"name": "a", "send": "x\ny", "min_replies": "0", "expect": "z"}
        self.refused([broken], "case a: the send text must be one line")
        self.refused([{**broken, "send": "x"}], "case a: min_replies must be a number")
        self.refused(
            [{**broken, "send": "x", "min_replies": 0}],
            "case a: expect must be a list of non-empty patterns",
        )


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


class ShippedSearchValidationCase(unittest.TestCase):
    """The shipped `validation-search-without-query` case judged against how qa-cli renders the bot's usage line.

    Stage QA run 40465541796 (2026-10-27, PR 862) failed this case although the bot answered
    `Provide search text: /search <query>`: qa-cli reads the rendered Telegram Web text, where the
    clickable command and the placeholder can be separated by a line break or a non-breaking space,
    and the case pattern wanted one plain space. The exact rendering of that run was not captured.
    """

    CASE = next(
        case
        for case in json.loads((ROOT / "scripts/stage-smoke-cases.json").read_text())
        if case["name"] == "validation-search-without-query"
    )

    def judge(self, *texts):
        return smoke.judge(self.CASE, [(text, 0.1) for text in texts])

    def test_the_usage_line_passes_whatever_whitespace_separates_the_command_from_the_placeholder(
        self,
    ):
        for separator in (" ", "\n", "\u00a0", " \n ", "\t", "\u2009"):
            for line in (
                "Provide search text: /search{}<query>",
                "Укажите текст для поиска: /search{}<запрос>",
            ):
                with self.subTest(line=line, separator=repr(separator)):
                    self.assertEqual(self.judge(line.format(separator)), [])

    def test_an_empty_second_reply_does_not_hide_the_usage_line(self):
        self.assertEqual(self.judge("Provide search text: /search\n<query>", ""), [])

    def test_a_wrong_command_a_wrong_or_missing_placeholder_or_nonsense_still_fail(self):
        for text in (
            "Provide search text: /find <query>",
            "Provide search text: /search <title>",
            "Provide search text: /search",
            "Provide search text: /search<query>",
            "Provide search text: /searching <query>",
            "Provide search text: <query>",
            "Nothing found",
            "pong",
            "",
        ):
            with self.subTest(text=text):
                self.assertEqual(
                    self.judge(text), ["no reply matched any of the expected patterns"]
                )

    def test_silence_and_an_error_trace_next_to_the_usage_line_still_fail(self):
        self.assertEqual(self.judge(), ["0 replies, expected at least 1"])
        self.assertEqual(
            len(
                self.judge(
                    "Provide search text: /search\n<query>", "Traceback (most recent call last)"
                )
            ),
            1,
        )

    def test_a_late_usage_line_still_fails_the_latency_bound(self):
        late = smoke.judge(
            self.CASE,
            [("Provide search text: /search\n<query>", self.CASE["max_first_reply_s"] + 1)],
        )
        self.assertEqual(len(late), 1)
        self.assertIn("first reply took", late[0])


if __name__ == "__main__":
    unittest.main()
