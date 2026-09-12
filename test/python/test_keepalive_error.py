import contextlib, importlib.util, io, json, sys, types, unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


class Revoked(Exception):
    ID = "SESSION_REVOKED"


class Flood(Exception):
    ID = "FLOOD_WAIT"


def load(client):
    py = types.ModuleType("pyrogram")
    py.Client = lambda **kwargs: client
    errors = types.ModuleType("pyrogram.errors")
    for name in [
        "FloodWait",
        "PasswordHashInvalid",
        "PhoneCodeExpired",
        "PhoneCodeInvalid",
        "PhoneNumberInvalid",
        "SessionPasswordNeeded",
    ]:
        setattr(errors, name, type(name, (Exception,), {}))
    account = types.ModuleType("pyrogram.raw.functions.account")
    account.GetAuthorizations = lambda: None
    spec = importlib.util.spec_from_file_location(
        "tested_connect_session",
        Path(__file__).resolve().parents[2] / "scripts/connect-session.py",
    )
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {"pyrogram": py, "pyrogram.errors": errors}):
        spec.loader.exec_module(module)
    return module, account


class Tests(unittest.IsolatedAsyncioTestCase):
    async def run_failure(self, error, phase, cleanup_error=None):
        client = types.SimpleNamespace(
            connect=AsyncMock(),
            invoke=AsyncMock(),
            disconnect=AsyncMock(),
            storage=types.SimpleNamespace(save=AsyncMock()),
        )
        getattr(client, phase).side_effect = error
        if cleanup_error:
            client.disconnect.side_effect = cleanup_error
        module, account = load(client)
        out = io.StringIO()
        with (
            patch.dict(sys.modules, {"pyrogram.raw.functions.account": account}),
            contextlib.redirect_stdout(out),
            self.assertRaises(SystemExit),
        ):
            await module.cmd_get_authorizations(
                types.SimpleNamespace(session_path="/tmp/synthetic.session")
            )
        return json.loads(out.getvalue()), client

    async def test_revoked_during_connect_is_reported_to_keepalive(self):
        result, client = await self.run_failure(Revoked(), "connect")
        self.assertEqual(result["error"], "SESSION_EXPIRED")
        self.assertEqual(result["reason"], "revoked")
        client.disconnect.assert_awaited_once()

    async def test_revoked_during_query_is_reported_to_keepalive(self):
        result, client = await self.run_failure(Revoked(), "invoke")
        self.assertEqual(result["error"], "SESSION_EXPIRED")

    async def test_network_failure_does_not_invalidate_credentials(self):
        result, client = await self.run_failure(ConnectionError("offline"), "invoke")
        self.assertEqual(result["error"], "AUTH_QUERY_FAILED")

    async def test_flood_wait_is_not_a_session_revocation(self):
        result, client = await self.run_failure(Flood(), "invoke")
        self.assertEqual(result["error"], "AUTH_QUERY_FAILED")

    async def test_cleanup_failure_preserves_structured_original_failure(self):
        result, client = await self.run_failure(
            Revoked(), "connect", ConnectionError("already disconnected")
        )
        self.assertEqual(result["error"], "SESSION_EXPIRED")
        self.assertEqual(result["reason"], "revoked")

    async def test_account_deactivation_is_not_reported_as_user_session_revocation(
        self,
    ):
        class Deactivated(Exception):
            ID = "USER_DEACTIVATED"

        result, client = await self.run_failure(Deactivated(), "invoke")
        self.assertEqual(result["reason"], "account_unavailable")

    async def test_duplicated_key_is_not_blame_for_user_revocation(self):
        class Duplicated(Exception):
            ID = "AUTH_KEY_DUPLICATED"

        result, client = await self.run_failure(Duplicated(), "invoke")
        self.assertEqual(result["error"], "SESSION_EXPIRED")
        self.assertEqual(result["reason"], "local")


if __name__ == "__main__":
    unittest.main()
