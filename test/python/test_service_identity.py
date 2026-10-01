import os, sys, unittest
from unittest.mock import patch
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from service_session import start_service_session


class Client:
    def __init__(self, user=5000000001, authorized=True):
        self.user = user
        self.authorized = authorized
        self.initialized = False
        self.disconnected = False
        self.connected = False

    async def connect(self):
        self.connected = True
        return self.authorized

    async def get_me(self):
        return SimpleNamespace(id=self.user)

    async def initialize(self):
        self.initialized = True

    async def disconnect(self):
        self.disconnected = True


class Tests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_service_identity_never_connects(self):
        app = Client()
        with self.assertRaises(ValueError):
            await start_service_session(app, 0)
        self.assertFalse(app.connected)

    async def test_wrong_account_disconnects_before_initializing(self):
        app = Client(user=5000000002)
        with self.assertRaises(ValueError):
            await start_service_session(app, 5000000001)
        self.assertTrue(app.disconnected)
        self.assertFalse(app.initialized)

    async def test_unauthorized_never_enters_interactive_login(self):
        app = Client(authorized=False)
        with self.assertRaises(ValueError):
            await start_service_session(app, 5000000001)
        self.assertTrue(app.disconnected)
        self.assertFalse(app.initialized)

    async def test_expected_account_initializes(self):
        app = Client()
        await start_service_session(app, 5000000001)
        self.assertTrue(app.initialized)
        self.assertFalse(app.disconnected)

    async def test_invalid_environment_is_reported_without_connecting(self):
        for value in ["", "garbage", "0"]:
            app = Client()
            with patch.dict(os.environ, {"MTPROTO_SERVICE_USER_ID": value}):
                with self.assertRaisesRegex(
                    ValueError, "SERVICE_IDENTITY_UNCONFIGURED"
                ):
                    await start_service_session(app)
            self.assertFalse(app.connected)

    async def test_boolean_is_not_a_service_identity(self):
        app = Client()
        with self.assertRaises(ValueError):
            await start_service_session(app, True)
        self.assertFalse(app.connected)

    async def test_cleanup_failure_preserves_the_original_identity_error(self):
        class BrokenCleanup(Client):
            async def disconnect(self):
                raise ConnectionError("already disconnected")

        app = BrokenCleanup(user=5000000002)
        with self.assertRaisesRegex(ValueError, "SERVICE_IDENTITY_MISMATCH"):
            await start_service_session(app, 5000000001)


if __name__ == "__main__":
    unittest.main()
