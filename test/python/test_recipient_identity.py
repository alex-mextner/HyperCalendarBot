import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from recipient_identity import RecipientMismatch, send_to_recipient


class FakeClient:
    def __init__(self, resolved_id=5000000001):
        self.resolved_id = resolved_id
        self.lookups = []
        self.sent = []

    async def get_chat(self, username):
        self.lookups.append(username)
        return SimpleNamespace(id=self.resolved_id)

    async def send_message(self, target, text):
        self.sent.append((target, text))
        return SimpleNamespace(id=1)


class RecipientIdentityTests(unittest.IsolatedAsyncioTestCase):
    async def test_username_is_only_a_resolution_hint_not_an_alternate_recipient(self):
        client = FakeClient(5000000002)
        with self.assertRaises(RecipientMismatch):
            await send_to_recipient(client, 5000000001, 'synthetic', '@other')
        self.assertEqual(client.sent, [])

    async def test_matching_username_sends_to_numeric_id(self):
        client = FakeClient()
        await send_to_recipient(client, 5000000001, 'synthetic', '@verified')
        self.assertEqual(client.lookups, [5000000001])
        self.assertEqual(client.sent, [(5000000001, 'synthetic')])

    async def test_numeric_only_does_not_invent_a_username(self):
        client = FakeClient()
        await send_to_recipient(client, 5000000001, 'synthetic', None)
        self.assertEqual(client.lookups, [])
        self.assertEqual(client.sent, [(5000000001, 'synthetic')])

    async def test_cached_numeric_identity_survives_reassigned_username(self):
        class Reassigned(FakeClient):
            async def get_chat(self, peer):
                self.lookups.append(peer)
                return SimpleNamespace(id=5000000001 if type(peer) is int else 5000000002)
        client=Reassigned()
        await send_to_recipient(client,5000000001,'synthetic','@reassigned')
        self.assertEqual(client.sent,[(5000000001,'synthetic')])
        self.assertEqual(client.lookups,[5000000001])

    async def test_unknown_peer_can_be_resolved_by_matching_username_only(self):
        class PeerUnknown(Exception): ID='PEER_ID_INVALID'
        class Unknown(FakeClient):
            async def get_chat(self,peer):
                self.lookups.append(peer)
                if type(peer) is int: raise PeerUnknown()
                return SimpleNamespace(id=self.resolved_id)
        client=Unknown()
        await send_to_recipient(client,5000000001,'synthetic','@hint')
        self.assertEqual(client.lookups,[5000000001,'hint'])
        self.assertEqual(client.sent,[(5000000001,'synthetic')])
        other=Unknown(5000000002)
        with self.assertRaises(RecipientMismatch): await send_to_recipient(other,5000000001,'synthetic','@hint')
        self.assertEqual(other.sent,[])

    async def test_network_error_does_not_retarget_by_username(self):
        class Broken(FakeClient):
            async def get_chat(self,peer): raise ConnectionError('offline')
        client=Broken()
        with self.assertRaises(ConnectionError): await send_to_recipient(client,5000000001,'synthetic','hint')
        self.assertEqual(client.sent,[])

    async def test_invalid_id_is_rejected_before_lookup_or_send(self):
        for invalid in [0, True, '5000000001', 1.5]:
            client = FakeClient()
            with self.assertRaises(RecipientMismatch):
                await send_to_recipient(client, invalid, 'synthetic', '@verified')
            self.assertEqual(client.lookups, [])
            self.assertEqual(client.sent, [])


if __name__ == '__main__':
    unittest.main()
