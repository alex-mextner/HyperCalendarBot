"""Service scripts: explicit per-ID birthday results and fail-closed operator inputs.

Synthetic IDs and credentials only; nothing here loads a session or reaches Telegram or Docker.
"""

import ast
import asyncio
import contextlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
WITH_BIRTHDAY = 5000000101
WITHOUT_BIRTHDAY = 5000000102
UNREACHABLE = 5000000103
CREDENTIALS = {"MTPROTO_API_ID": "123", "MTPROTO_API_HASH": "synthetic"}


class FloodWait(Exception):
    def __init__(self, value):
        super().__init__(value)
        self.value = value


def load_function(script, name, namespace):
    tree = ast.parse((SCRIPTS / script).read_text(), filename=script)
    entry = next(
        n
        for n in tree.body
        if isinstance(n, (ast.AsyncFunctionDef, ast.FunctionDef)) and n.name == name
    )
    exec(compile(ast.Module(body=[entry], type_ignores=[]), script, "exec"), namespace)
    return namespace[name]


class FetchBirthdaysTests(unittest.TestCase):
    def test_every_checked_id_is_reported_and_unchecked_ids_are_omitted(self):
        class Client:
            def __init__(self, *args, **kwargs):
                pass

            async def get_users(self, user_id):
                if user_id == UNREACHABLE:
                    raise RuntimeError("synthetic lookup failure")
                birthday = (
                    SimpleNamespace(day=4, month=7, year=None)
                    if user_id == WITH_BIRTHDAY
                    else None
                )
                return SimpleNamespace(birthday=birthday)

            async def stop(self):
                pass

        async def start_service_session(client):
            return client

        fetch = load_function(
            "fetch-birthdays.py",
            "fetch",
            dict(
                API_ID=123,
                API_HASH="synthetic",
                FLOOD_WAIT_MAX=30,
                asyncio=asyncio,
                sys=sys,
                start_service_session=start_service_session,
            ),
        )
        with patch.dict(
            sys.modules,
            {
                "pyrogram": SimpleNamespace(Client=Client),
                "pyrogram.errors": SimpleNamespace(FloodWait=FloodWait),
                "mtproto_lock": SimpleNamespace(session_lock=contextlib.nullcontext),
            },
        ):
            results = asyncio.run(fetch([WITH_BIRTHDAY, WITHOUT_BIRTHDAY, UNREACHABLE]))

        self.assertEqual(
            results,
            {str(WITH_BIRTHDAY): {"day": 4, "month": 7}, str(WITHOUT_BIRTHDAY): None},
        )


class OperatorScriptInputTests(unittest.TestCase):
    def run_script(self, command, env, fake_bin):
        return subprocess.run(
            command,
            cwd=ROOT,
            env={"PATH": f"{fake_bin}{os.pathsep}/usr/bin:/bin", **env},
            capture_output=True,
            text=True,
            timeout=30,
        )

    def assert_refused(self, command, env, message):
        with tempfile.TemporaryDirectory() as fake_bin:
            marker = Path(fake_bin) / "docker-ran"
            docker = Path(fake_bin) / "docker"
            docker.write_text(f"#!/bin/sh\ntouch '{marker}'\n")
            docker.chmod(0o755)
            result = self.run_script(command, env, fake_bin)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn(message, result.stderr)
            self.assertEqual(result.stdout, "")
            self.assertFalse(marker.exists())

    def test_credentials_are_required_from_the_environment(self):
        for command in [
            [sys.executable, "scripts/pyrogram-auth.py"],
            [sys.executable, "scripts/debug-call.py", "42"],
            ["bash", "scripts/docker-call-test.sh", "42"],
        ]:
            for env in [{}, {"MTPROTO_API_ID": "123"}, {"MTPROTO_API_HASH": "synthetic"}]:
                with self.subTest(command=command[1], env=sorted(env)):
                    self.assert_refused(command, env, "MTPROTO_API_ID and MTPROTO_API_HASH")

    def test_call_target_is_a_required_numeric_argument(self):
        for command in [
            [sys.executable, "scripts/debug-call.py"],
            ["bash", "scripts/docker-call-test.sh"],
        ]:
            for target in [[], [""], ["12a"], ["1); import os #"]]:
                with self.subTest(command=command[1], target=target):
                    self.assert_refused(command + target, CREDENTIALS, "Usage:")


if __name__ == "__main__":
    unittest.main()
