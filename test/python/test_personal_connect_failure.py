import contextlib
import importlib.util
import io
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


class Tests(unittest.IsolatedAsyncioTestCase):
    async def test_revoked_connect_and_failed_cleanup_keep_original_result(self):
        errors = types.ModuleType("pyrogram.errors")
        for name in [
            "AuthKeyUnregistered",
            "FloodWait",
            "PeerIdInvalid",
            "SessionRevoked",
            "UserDeactivated",
        ]:
            setattr(errors, name, type(name, (Exception,), {}))
        client = types.SimpleNamespace(
            connect=AsyncMock(side_effect=errors.SessionRevoked("synthetic")),
            disconnect=AsyncMock(side_effect=ConnectionError("already closed")),
            send_message=AsyncMock(),
        )
        pyrogram = types.ModuleType("pyrogram")
        pyrogram.Client = lambda **kwargs: client
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
        spec = importlib.util.spec_from_file_location(
            "tested_personal_sender",
            Path(__file__).resolve().parents[2] / "scripts/send-as-user.py",
        )
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"pyrogram": pyrogram, "pyrogram.errors": errors}):
            spec.loader.exec_module(module)
        output = io.StringIO()
        with (
            contextlib.redirect_stdout(output),
            contextlib.redirect_stderr(io.StringIO()),
            self.assertRaises(SystemExit) as stopped,
        ):
            await module.send_message(
                "/tmp/synthetic.session", 5000000001, "synthetic", None
            )
        self.assertEqual(stopped.exception.code, 1)
        self.assertEqual(json.loads(output.getvalue())["reason"], "revoked")
        client.send_message.assert_not_awaited()
        client.disconnect.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
