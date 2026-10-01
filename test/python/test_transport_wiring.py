import contextlib
import enum
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
ENUMS = types.ModuleType('pyrogram.enums')
ENUMS.ParseMode = enum.Enum('ParseMode', ['DEFAULT', 'MARKDOWN', 'HTML', 'DISABLED'])


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
    with patch.dict(sys.modules, {'pyrogram': pyrogram, 'pyrogram.errors': ERRORS, 'pyrogram.enums': ENUMS}):
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

    async def test_personal_sender_recovers_unknown_peer_without_changing_numeric_recipient(self):
        class UnknownPeer(Exception):
            ID = 'PEER_ID_INVALID'

        class RecoveringClient(SessionClient):
            async def get_chat(self, peer):
                self.lookups.append(peer)
                if type(peer) is int:
                    raise UnknownPeer()
                return types.SimpleNamespace(id=self.resolved_id)

        for resolved_id in [5000000001, 5000000002]:
            with self.subTest(resolved_id=resolved_id):
                client = RecoveringClient(resolved_id)
                script = load_script('send-as-user.py', client)
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    if resolved_id != 5000000001:
                        with self.assertRaises(SystemExit):
                            await script.send_message('/tmp/synthetic-only.session', 5000000001, 'synthetic', '@hint')
                    else:
                        await script.send_message('/tmp/synthetic-only.session', 5000000001, 'synthetic', '@hint')
                self.assertTrue(client.disconnected)
                self.assertEqual(client.lookups, [5000000001, 'hint'])
                self.assertEqual(client.sent, [(5000000001, 'synthetic')] if resolved_id == 5000000001 else [])

    async def test_personal_sender_sends_cached_numeric_peer_despite_reassigned_hint(self):
        class CachedClient(SessionClient):
            async def get_chat(self, peer):
                self.lookups.append(peer)
                return types.SimpleNamespace(id=5000000001 if type(peer) is int else 5000000002)

        client = CachedClient()
        script = load_script('send-as-user.py', client)
        with contextlib.redirect_stdout(io.StringIO()):
            await script.send_message('/tmp/synthetic-only.session', 5000000001, 'synthetic', 'reassigned')
        self.assertTrue(client.disconnected)
        self.assertEqual(client.lookups, [5000000001])
        self.assertEqual(client.sent, [(5000000001, 'synthetic')])

    async def test_personal_sender_delivers_first_person_text_verbatim(self):
        text = (
            'Synthetic **title** <b>tag</b> __under__ ~~strike~~ ||spoiler|| '
            'https://www.google.com/maps/search/?api=1&query=Synthetic&query_place_id=ChIJ--ab__cd--x'
        )
        client = SessionClient()
        script = load_script('send-as-user.py', client)
        with contextlib.redirect_stdout(io.StringIO()):
            await script.send_message('/tmp/synthetic-only.session', 5000000001, text, None)
        self.assertEqual(client.sent, [(5000000001, text)])
        self.assertEqual(client.parse_modes, [ENUMS.ParseMode.DISABLED])

