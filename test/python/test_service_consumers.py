"""Run actual consumer entry points with synthetic clients; never load credentials or Telegram."""

import ast
import asyncio
import contextlib
import io
import json
import os
import runpy
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from service_session import start_service_session

ROOT = Path(__file__).resolve().parents[2]
SERVICE_ID = 5000000001


def run_source(tree, namespace):
    """Run the parsed module in a temp file (runpy, not exec) and return its globals."""
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "snippet.py"
        path.write_text(ast.unparse(ast.fix_missing_locations(tree)))
        return runpy.run_path(str(path), init_globals=namespace)


def consumer_source(name):
    source = (ROOT / "scripts" / name).read_text()
    if name.endswith(".sh"):
        source = source.split("python3 << 'PYEOF'\n", 1)[1].split("\nPYEOF", 1)[0]
        source = source.replace("${USER_ID}", "42").replace("${AUDIO}", "/synthetic.wav")
    return source


def consumer_script_names():
    """Python scripts plus the one shell script that embeds a Python consumer."""
    for path in (ROOT / "scripts").iterdir():
        if path.suffix == ".py" or path.name == "docker-call-test.sh":
            yield path.name


def creates_voice_caller_client(tree):
    return any(
        isinstance(n, ast.Call)
        and isinstance(n.func, ast.Name)
        and n.func.id == "Client"
        and any(
            isinstance(a, ast.Constant) and a.value == "voice_caller"
            for a in [*n.args, *(k.value for k in n.keywords)]
        )
        for n in ast.walk(tree)
    )


def voice_caller_consumers():
    """(file name, parsed source) of every script that builds the shared `voice_caller` Client."""
    for name in consumer_script_names():
        tree = ast.parse(consumer_source(name))
        if creates_voice_caller_client(tree):
            yield name, tree


def imports_start_service_session(tree):
    return any(
        isinstance(n, ast.ImportFrom)
        and n.module == "service_session"
        and any(a.name == "start_service_session" for a in n.names)
        for n in tree.body
    )


def calls_start_service_session(calls):
    return any(isinstance(n.func, ast.Name) and n.func.id == "start_service_session" for n in calls)


def drives_app_lifecycle(calls):
    """True when the script starts or disconnects `app` itself instead of going through the service session."""
    return any(
        isinstance(n.func, ast.Attribute)
        and isinstance(n.func.value, ast.Name)
        and n.func.value.id == "app"
        and n.func.attr in {"start", "disconnect"}
        for n in calls
    )


class OperationFailure(Exception):
    pass


class ConsumerTests(unittest.IsolatedAsyncioTestCase):
    async def run_consumer(self, name, identity, expected=SERVICE_ID, authorized=True):
        events = []

        class Client:
            def __init__(self, *args, **kwargs):
                pass

            async def start(self):
                events.append("interactive-start")

            async def connect(self):
                events.append("connect")
                return authorized

            async def get_me(self):
                events.append("get_me")
                return SimpleNamespace(id=identity, username="synthetic_service")

            async def initialize(self):
                events.append("initialize")

            async def disconnect(self):
                events.append("disconnect")

            async def stop(self):
                events.append("stop")

            async def get_users(self, user_id):
                events.append("profile")
                raise OperationFailure()

            async def get_chat_members(self, chat_id):
                events.append("members")
                raise OperationFailure()
                yield

        class Calls:
            def __init__(self, client):
                pass

            async def start(self):
                events.append("calls")
                raise OperationFailure()

        tree = ast.parse(consumer_source(name), filename=name)
        entry = next(
            n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "main"
        )
        namespace = run_source(
            ast.Module(body=[entry], type_ignores=[]),
            {
                "Client": Client,
                "PyTgCalls": Calls,
                "start_service_session": start_service_session,
                "asyncio": asyncio,
                "sys": SimpleNamespace(argv=["script", "42"]),
                "os": os,
                "json": json,
                "API_ID": 123,
                "API_HASH": "synthetic",
                "session_lock": contextlib.nullcontext,
                "contextlib": contextlib,
            },
        )
        with (
            patch.dict(
                os.environ,
                {
                    "MTPROTO_SERVICE_USER_ID": str(expected),
                    "MTPROTO_API_ID": "123",
                    "MTPROTO_API_HASH": "synthetic",
                },
                clear=True,
            ),
            patch.dict(
                sys.modules,
                {
                    "mtproto_lock": SimpleNamespace(session_lock=contextlib.nullcontext),
                    "pyrogram": SimpleNamespace(Client=Client),
                },
            ),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            try:
                await namespace["main"](42) if name == "get-user-info.py" else await namespace[
                    "main"
                ]()
            except (ValueError, OperationFailure):
                pass
        return events

    async def test_wrong_identity_never_activates_or_double_cleans_up(self):
        for name in [
            "get-chat-members.py",
            "debug-call.py",
            "docker-call-test.sh",
            "get-user-info.py",
        ]:
            with self.subTest(consumer=name):
                self.assertEqual(
                    await self.run_consumer(name, SERVICE_ID + 1),
                    ["connect", "get_me", "disconnect"],
                )

    async def test_initialized_client_stops_when_service_operation_fails(self):
        for name, operation in [
            ("get-chat-members.py", "members"),
            ("debug-call.py", "calls"),
            ("docker-call-test.sh", "calls"),
            ("get-user-info.py", "profile"),
        ]:
            with self.subTest(consumer=name):
                self.assertEqual(
                    await self.run_consumer(name, SERVICE_ID),
                    ["connect", "get_me", "initialize", operation, "stop"],
                )

    async def test_unconfigured_service_never_connects(self):
        for name in [
            "get-chat-members.py",
            "debug-call.py",
            "docker-call-test.sh",
            "get-user-info.py",
        ]:
            with self.subTest(consumer=name):
                self.assertEqual(await self.run_consumer(name, SERVICE_ID, expected=0), [])

    async def test_unauthorized_service_never_initializes(self):
        for name in [
            "get-chat-members.py",
            "debug-call.py",
            "docker-call-test.sh",
            "get-user-info.py",
        ]:
            with self.subTest(consumer=name):
                self.assertEqual(
                    await self.run_consumer(name, SERVICE_ID, authorized=False),
                    ["connect", "disconnect"],
                )

    async def test_health_probe_does_not_initialize_or_login(self):
        self.assertEqual(
            await self.run_consumer("check-session.py", SERVICE_ID),
            ["connect", "get_me", "disconnect"],
        )

    def test_shared_consumer_inventory_and_guards(self):
        expected = {
            "check-session.py",
            "resolve-username.py",
            "fetch-birthdays.py",
            "voice-call-bridge.py",
            "get-chat-members.py",
            "debug-call.py",
            "docker-call-test.sh",
            "pyrogram-auth.py",
            "get-user-info.py",
        }
        found = set()
        for name, tree in voice_caller_consumers():
            found.add(name)
            if name in {"pyrogram-auth.py", "check-session.py"}:
                continue
            self.assertTrue(imports_start_service_session(tree), name)
            calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call)]
            self.assertTrue(calls_start_service_session(calls), name)
            self.assertFalse(drives_app_lifecycle(calls), name)
        self.assertEqual(found, expected)

    def test_consumer_guards_detect_what_they_claim_to_detect(self):
        def calls_of(tree):
            return [n for n in ast.walk(tree) if isinstance(n, ast.Call)]

        client = ast.parse('app = Client("voice_caller")')
        keyword = ast.parse('app = Client(name="voice_caller")')
        other = ast.parse('app = Client("other")\nClient2("voice_caller")')
        self.assertTrue(creates_voice_caller_client(client))
        self.assertTrue(creates_voice_caller_client(keyword))
        self.assertFalse(creates_voice_caller_client(other))
        imported = ast.parse("from service_session import start_service_session")
        self.assertTrue(imports_start_service_session(imported))
        self.assertFalse(
            imports_start_service_session(ast.parse("from service_session import other"))
        )
        self.assertFalse(
            imports_start_service_session(ast.parse("from elsewhere import start_service_session"))
        )
        self.assertFalse(
            imports_start_service_session(
                ast.parse("def f():\n    from service_session import start_service_session")
            )
        )
        self.assertTrue(
            calls_start_service_session(calls_of(ast.parse("start_service_session(app)")))
        )
        self.assertFalse(
            calls_start_service_session(calls_of(ast.parse("app.start_service_session()")))
        )
        self.assertTrue(drives_app_lifecycle(calls_of(ast.parse("app.start()"))))
        self.assertTrue(drives_app_lifecycle(calls_of(ast.parse("app.disconnect()"))))
        self.assertFalse(drives_app_lifecycle(calls_of(ast.parse("app.get_me()\nother.start()"))))
