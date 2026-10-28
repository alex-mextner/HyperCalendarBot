"""fetch-birthdays.py: birthday shapes, FloodWait retry and the hard-failure limit per looked-up ID.

The script runs main() on import, so its top-level functions are run in isolation with fakes.
"""

import ast
import asyncio
import contextlib
import io
import runpy
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/fetch-birthdays.py"


class RPCError(Exception):
    pass


class FloodWait(Exception):
    def __init__(self, value):
        super().__init__(value)
        self.value = value


def run_fetch(users, user_ids, sleeps):
    """users: uid -> list of outcomes consumed per get_users call (Exception raised, else returned)."""
    calls = []

    class Client:
        def __init__(self, *args, **kwargs):
            pass

        async def get_users(self, uid):
            calls.append(uid)
            outcome = users[uid].pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

        async def stop(self):
            pass

    async def start_service_session(client):
        return client

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    fake_asyncio = SimpleNamespace(sleep=fake_sleep, TimeoutError=asyncio.TimeoutError)
    functions = [
        n
        for n in ast.parse(SCRIPT.read_text()).body
        if isinstance(n, (ast.AsyncFunctionDef, ast.FunctionDef))
    ]
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "snippet.py"
        path.write_text(
            ast.unparse(ast.fix_missing_locations(ast.Module(body=functions, type_ignores=[])))
        )
        namespace = runpy.run_path(
            str(path),
            init_globals={
                "API_ID": 1,
                "API_HASH": "synthetic",
                "FLOOD_WAIT_MAX": 30,
                "asyncio": fake_asyncio,
                "sys": sys,
                "start_service_session": start_service_session,
            },
        )
    stderr = io.StringIO()
    with (
        patch.dict(
            sys.modules,
            {
                "pyrogram": SimpleNamespace(Client=Client),
                "pyrogram.errors": SimpleNamespace(FloodWait=FloodWait, RPCError=RPCError),
                "mtproto_lock": SimpleNamespace(session_lock=contextlib.nullcontext),
            },
        ),
        contextlib.redirect_stderr(stderr),
    ):
        results = asyncio.run(namespace["fetch"](user_ids))
    return results, calls, stderr.getvalue()


def user(day, month, year=None):
    return SimpleNamespace(birthday=SimpleNamespace(day=day, month=month, year=year))


class FetchBirthdayLookupTests(unittest.TestCase):
    def test_year_is_reported_only_when_the_user_shows_it(self):
        results, _, _ = run_fetch(
            {1: [user(4, 7, 1990)], 2: [user(5, 8, None)], 3: [SimpleNamespace()]}, [1, 2, 3], []
        )
        self.assertEqual(
            results,
            {"1": {"day": 4, "month": 7, "year": 1990}, "2": {"day": 5, "month": 8}, "3": None},
        )

    def test_a_short_flood_wait_sleeps_and_retries_once(self):
        sleeps = []
        results, calls, _ = run_fetch({1: [FloodWait(7), user(1, 2)]}, [1], sleeps)
        self.assertEqual(results, {"1": {"day": 1, "month": 2}})
        self.assertEqual((calls, sleeps), ([1, 1], [7]))

    def test_two_flood_waits_leave_the_id_unchecked_and_move_on(self):
        sleeps = []
        results, calls, _ = run_fetch(
            {1: [FloodWait(3), FloodWait(4)], 2: [user(9, 9)]}, [1, 2], sleeps
        )
        self.assertEqual(results, {"2": {"day": 9, "month": 9}})
        self.assertEqual((calls, sleeps), ([1, 1, 2], [3, 4]))

    def test_a_flood_wait_over_the_limit_is_a_hard_failure(self):
        sleeps = []
        with self.assertRaises(SystemExit) as raised:
            run_fetch({1: [FloodWait(31)], 2: [user(1, 1)]}, [1, 2], sleeps)
        self.assertEqual(raised.exception.code, 1)
        self.assertEqual(sleeps, [])

    def test_a_failed_lookup_is_skipped_without_retry_and_reported_on_stderr(self):
        results, calls, err = run_fetch({1: [RPCError("nope")], 2: [user(1, 1)]}, [1, 2], [])
        self.assertEqual(results, {"2": {"day": 1, "month": 1}})
        self.assertEqual(calls, [1, 2])
        self.assertIn("skip uid=1: nope", err)

    def test_any_other_failure_of_one_lookup_drops_only_that_user(self):
        results, calls, err = run_fetch(
            {1: [AttributeError("odd object")], 2: [user(1, 1)]}, [1, 2], []
        )
        self.assertEqual(results, {"2": {"day": 1, "month": 1}})
        self.assertEqual(calls, [1, 2])
        self.assertIn("skip uid=1: odd object", err)


if __name__ == "__main__":
    unittest.main()
