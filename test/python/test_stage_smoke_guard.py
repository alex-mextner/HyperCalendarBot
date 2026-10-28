"""scripts/stage-smoke.py `guard`, case validation and the judging of the shipped case: the odroid guard refuses anything that could reach production and emits the validated cases (#805, #840)."""

import contextlib
import io
import json
import unittest
from pathlib import Path

from stage_smoke_support import (
    BASE_CASES,
    PROD_CRED,
    REPLAY_CASES,
    ROOT,
    SPEC,
    STAGE_CRED,
    STAGE_PEER,
    Base,
    bot_env,
    smoke,
)


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
