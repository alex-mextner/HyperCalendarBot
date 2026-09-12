import contextlib
import importlib.util
import io
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch
from test_recipient_identity import FakeClient

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
ERRORS = types.ModuleType('pyrogram.errors')
for name in ['AuthKeyUnregistered', 'FloodWait', 'PeerIdInvalid', 'SessionRevoked', 'UserDeactivated']:
    setattr(ERRORS, name, type(name, (Exception,), {}))


class SessionClient(FakeClient):
    def __init__(self, resolved_id=5000000001, revoked=False):
        super().__init__(resolved_id)
        self.revoked = revoked
        self.disconnected = False

    async def connect(self):
        if self.revoked:
            raise ERRORS.SessionRevoked('synthetic revoked session')

    async def disconnect(self):
        self.disconnected = True


def load_script(filename, client=None):
    spec = importlib.util.spec_from_file_location('synthetic_' + filename.replace('-', '_'), SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    pyrogram = types.ModuleType('pyrogram')
    pyrogram.Client = lambda **kwargs: client
    with patch.dict(sys.modules, {'pyrogram': pyrogram, 'pyrogram.errors': ERRORS}):
        spec.loader.exec_module(module)
    return module


class TransportWiringTests(unittest.IsolatedAsyncioTestCase):
    async def test_personal_sender_refuses_a_mismatched_username(self):
        client = SessionClient(5000000002)
        script = load_script('send-as-user.py', client)
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as stopped:
            await script.send_message('/tmp/synthetic-only.session', 5000000001, 'synthetic', 'other')
        self.assertEqual(stopped.exception.code, 1)
        self.assertEqual(json.loads(output.getvalue())['error'], 'RECIPIENT_MISMATCH')
        self.assertEqual(client.sent, [])
        self.assertTrue(client.disconnected)

    async def test_revocation_during_connect_is_normalized(self):
        client = SessionClient(revoked=True)
        script = load_script('send-as-user.py', client)
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as stopped:
            await script.send_message('/tmp/synthetic-only.session', 5000000001, 'synthetic', None)
        self.assertEqual(stopped.exception.code, 1)
        self.assertEqual(json.loads(output.getvalue())['error'], 'SESSION_EXPIRED')
        self.assertEqual(client.sent, [])
        self.assertTrue(client.disconnected)

    async def test_shared_sender_never_falls_back_to_a_different_person(self):
        client = SessionClient(5000000002)
        script = load_script('send-message.py')
        with contextlib.redirect_stderr(io.StringIO()):
            result = await script.send_with_retry(client, 5000000001, 'synthetic', 'other')
        self.assertFalse(result)
        self.assertEqual(client.sent, [])

    async def test_shared_sender_uses_verified_numeric_id(self):
        client = SessionClient()
        script = load_script('send-message.py')
        with contextlib.redirect_stdout(io.StringIO()):
            result = await script.send_with_retry(client, 5000000001, 'synthetic', '@verified')
        self.assertTrue(result)
        self.assertEqual(client.sent, [(5000000001, 'synthetic')])
