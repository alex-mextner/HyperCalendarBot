"""Run actual consumer entry points with synthetic clients; never load credentials or Telegram."""
import ast
import asyncio
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from service_session import start_service_session

ROOT = Path(__file__).resolve().parents[2]
SERVICE_ID = 5000000001


def consumer_source(name):
    source = (ROOT / 'scripts' / name).read_text()
    if name.endswith('.sh'):
        source = source.split("python3 << 'PYEOF'\n", 1)[1].split('\nPYEOF', 1)[0]
        source = source.replace('${USER_ID}', '42').replace('${AUDIO}', '/synthetic.wav')
    return source


class OperationFailure(Exception):
    pass


class ConsumerTests(unittest.IsolatedAsyncioTestCase):
    async def run_consumer(self, name, identity, expected=SERVICE_ID, authorized=True):
        events = []

        class Client:
            def __init__(self, *args, **kwargs):
                pass

            async def start(self):
                events.append('interactive-start')

            async def connect(self):
                events.append('connect')
                return authorized

            async def get_me(self):
                events.append('get_me')
                return SimpleNamespace(id=identity, username="synthetic_service")

            async def initialize(self):
                events.append('initialize')

            async def disconnect(self):
                events.append('disconnect')

            async def stop(self):
                events.append('stop')

            async def get_chat_members(self, chat_id):
                events.append('members')
                raise OperationFailure()
                yield

        class Calls:
            def __init__(self, client):
                pass

            async def start(self):
                events.append('calls')
                raise OperationFailure()

        tree = ast.parse(consumer_source(name), filename=name)
        entry = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == 'main')
        namespace = dict(Client=Client, PyTgCalls=Calls, start_service_session=start_service_session,
                         asyncio=asyncio, sys=SimpleNamespace(argv=['script', '42']), os=os,
                         json=json, API_ID=123, API_HASH='synthetic')
        exec(compile(ast.Module(body=[entry], type_ignores=[]), name, 'exec'), namespace)
        with patch.dict(os.environ, {'MTPROTO_SERVICE_USER_ID': str(expected), 'MTPROTO_API_ID': '123', 'MTPROTO_API_HASH': 'synthetic'}, clear=True), patch.dict(sys.modules, {'mtproto_lock': SimpleNamespace(session_lock=contextlib.nullcontext), 'pyrogram': SimpleNamespace(Client=Client)}), contextlib.redirect_stdout(io.StringIO()):
            try:
                await namespace['main']()
            except (ValueError, OperationFailure):
                pass
        return events

    async def test_wrong_identity_never_activates_or_double_cleans_up(self):
        for name in ['get-chat-members.py', 'debug-call.py', 'docker-call-test.sh']:
            with self.subTest(consumer=name):
                self.assertEqual(await self.run_consumer(name, SERVICE_ID + 1),
                                 ['connect', 'get_me', 'disconnect'])

    async def test_initialized_client_stops_when_service_operation_fails(self):
        for name, operation in [('get-chat-members.py', 'members'), ('debug-call.py', 'calls'), ('docker-call-test.sh', 'calls')]:
            with self.subTest(consumer=name):
                self.assertEqual(await self.run_consumer(name, SERVICE_ID),
                                 ['connect', 'get_me', 'initialize', operation, 'stop'])

    async def test_unconfigured_service_never_connects(self):
        for name in ['get-chat-members.py', 'debug-call.py', 'docker-call-test.sh']:
            with self.subTest(consumer=name):
                self.assertEqual(await self.run_consumer(name, SERVICE_ID, expected=0), [])

    async def test_unauthorized_service_never_initializes(self):
        for name in ['get-chat-members.py', 'debug-call.py', 'docker-call-test.sh']:
            with self.subTest(consumer=name):
                self.assertEqual(await self.run_consumer(name, SERVICE_ID, authorized=False),
                                 ['connect', 'disconnect'])

    async def test_health_probe_does_not_initialize_or_login(self):
        self.assertEqual(await self.run_consumer('check-session.py', SERVICE_ID),
                         ['connect', 'get_me', 'disconnect'])

    def test_shared_consumer_inventory_and_guards(self):
        expected = {'check-session.py', 'send-message.py', 'resolve-username.py',
                    'fetch-birthdays.py', 'voice-call-bridge.py', 'get-chat-members.py',
                    'debug-call.py', 'docker-call-test.sh', 'pyrogram-auth.py'}
        found = set()
        for path in (ROOT / 'scripts').iterdir():
            if path.suffix not in {'.py', '.sh'}:
                continue
            if path.suffix == '.sh' and path.name != 'docker-call-test.sh':
                continue
            tree = ast.parse(consumer_source(path.name))
            if not any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == 'Client'
                       and any(isinstance(a, ast.Constant) and a.value == 'voice_caller' for a in [*n.args, *(k.value for k in n.keywords)]) for n in ast.walk(tree)):
                continue
            found.add(path.name)
            if path.name in {'pyrogram-auth.py', 'check-session.py'}:
                continue
            self.assertTrue(any(isinstance(n, ast.ImportFrom) and n.module == 'service_session'
                                and any(a.name == 'start_service_session' for a in n.names)
                                for n in tree.body), path.name)
            calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call)]
            self.assertTrue(any(isinstance(n.func, ast.Name) and n.func.id == 'start_service_session' for n in calls), path.name)
            self.assertFalse(any(isinstance(n.func, ast.Attribute) and isinstance(n.func.value, ast.Name)
                                 and n.func.value.id == 'app' and n.func.attr in {'start', 'disconnect'} for n in calls), path.name)
        self.assertEqual(found, expected)
