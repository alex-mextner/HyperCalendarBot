"""connect-session.py: stdout protocol and exit codes of send_and_sign, check_password and get_authorizations.

Fake Pyrogram client and error classes only; nothing here reaches Telegram.
"""

import contextlib
import importlib.util
import io
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/connect-session.py"
ERROR_NAMES = [
    "FloodWait",
    "PasswordHashInvalid",
    "PhoneCodeExpired",
    "PhoneCodeInvalid",
    "PhoneNumberInvalid",
    "SessionPasswordNeeded",
]


def load(client):
    pyrogram = types.ModuleType("pyrogram")
    pyrogram.Client = lambda **kwargs: client
    errors = types.ModuleType("pyrogram.errors")
    for name in ERROR_NAMES:
        setattr(errors, name, type(name, (Exception,), {}))
    spec = importlib.util.spec_from_file_location("tested_connect_session_commands", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {"pyrogram": pyrogram, "pyrogram.errors": errors}):
        spec.loader.exec_module(module)
    return module


def fake_client(**overrides):
    client = types.SimpleNamespace(
        connect=AsyncMock(),
        disconnect=AsyncMock(),
        send_code=AsyncMock(return_value=types.SimpleNamespace(phone_code_hash="hash-1")),
        sign_in=AsyncMock(),
        check_password=AsyncMock(),
        invoke=AsyncMock(),
        storage=types.SimpleNamespace(save=AsyncMock()),
    )
    for key, value in overrides.items():
        setattr(client, key, value)
    return client


class CommandTests(unittest.IsolatedAsyncioTestCase):
    async def run_command(self, command, client, stdin="", **cli):
        module = load(client)
        out = io.StringIO()
        exit_code = None
        args = types.SimpleNamespace(
            session_path="/tmp/synthetic.session", phone="+10000000000", **cli
        )
        account = types.ModuleType("pyrogram.raw.functions.account")
        account.GetAuthorizations = lambda: None
        with (
            patch.dict(sys.modules, {"pyrogram.raw.functions.account": account}),
            patch.object(sys, "stdin", io.StringIO(stdin)),
            contextlib.redirect_stdout(out),
        ):
            try:
                await getattr(module, command)(args)
            except SystemExit as exit_:
                exit_code = exit_.code
        lines = [json.loads(line) for line in out.getvalue().splitlines()]
        return module, lines, exit_code

    def flood(self, module, seconds=42):
        error = module.FloodWait()
        error.value = seconds
        return error

    async def test_send_and_sign_reports_hash_then_ok(self):
        client = fake_client()
        _, lines, code = await self.run_command("cmd_send_and_sign", client, "12345\n")
        self.assertEqual(lines, [{"phone_code_hash": "hash-1"}, {"status": "ok"}])
        self.assertIsNone(code)
        client.sign_in.assert_awaited_once_with("+10000000000", "hash-1", "12345")
        client.storage.save.assert_awaited_once()
        client.disconnect.assert_awaited_once()

    async def test_send_and_sign_without_a_code_exits_1(self):
        client = fake_client()
        _, lines, code = await self.run_command("cmd_send_and_sign", client, "")
        self.assertEqual(lines[1]["error"], "NO_CODE")
        self.assertEqual(code, 1)
        client.sign_in.assert_not_awaited()
        client.disconnect.assert_awaited_once()

    async def test_invalid_code_error_class_maps_to_code_invalid(self):
        client = fake_client()
        module = load(client)
        client.sign_in.side_effect = module.PhoneCodeInvalid()
        with (
            patch.object(sys, "stdin", io.StringIO("1\n")),
            contextlib.redirect_stdout(io.StringIO()) as out,
            self.assertRaises(SystemExit) as raised,
        ):
            await module.cmd_send_and_sign(
                types.SimpleNamespace(session_path="/tmp/s.session", phone="+1")
            )
        self.assertEqual(raised.exception.code, 1)
        self.assertEqual(json.loads(out.getvalue().splitlines()[1])["error"], "CODE_INVALID")

    async def test_expired_code_error_class_maps_to_code_expired(self):
        client = fake_client()
        module = load(client)
        client.sign_in.side_effect = module.PhoneCodeExpired()
        with (
            patch.object(sys, "stdin", io.StringIO("1\n")),
            contextlib.redirect_stdout(io.StringIO()) as out,
            self.assertRaises(SystemExit) as raised,
        ):
            await module.cmd_send_and_sign(
                types.SimpleNamespace(session_path="/tmp/s.session", phone="+1")
            )
        self.assertEqual(raised.exception.code, 1)
        self.assertEqual(json.loads(out.getvalue().splitlines()[1])["error"], "CODE_EXPIRED")

    async def test_invalid_phone_maps_to_phone_invalid(self):
        client = fake_client()
        module = load(client)
        client.send_code.side_effect = module.PhoneNumberInvalid()
        with (
            contextlib.redirect_stdout(io.StringIO()) as out,
            self.assertRaises(SystemExit) as raised,
        ):
            await module.cmd_send_and_sign(
                types.SimpleNamespace(session_path="/tmp/s.session", phone="+1")
            )
        self.assertEqual(raised.exception.code, 1)
        self.assertEqual(json.loads(out.getvalue())["error"], "PHONE_INVALID")
        client.disconnect.assert_awaited_once()

    async def test_flood_wait_while_sending_the_code_reports_retry_after(self):
        client = fake_client()
        module = load(client)
        client.send_code.side_effect = self.flood(module, 17)
        with (
            contextlib.redirect_stdout(io.StringIO()) as out,
            self.assertRaises(SystemExit) as raised,
        ):
            await module.cmd_send_and_sign(
                types.SimpleNamespace(session_path="/tmp/s.session", phone="+1")
            )
        self.assertEqual(raised.exception.code, 1)
        self.assertEqual(
            json.loads(out.getvalue()),
            {"error": "FLOOD_WAIT", "message": "Rate limited for 17s", "retry_after": 17},
        )

    async def drive_two_factor(self, passwords, check_effects):
        client = fake_client()
        module = load(client)
        client.sign_in.side_effect = module.SessionPasswordNeeded()
        client.check_password.side_effect = [
            effect(module) if callable(effect) else effect for effect in check_effects
        ]
        with (
            patch.object(sys, "stdin", io.StringIO("12345\n" + passwords)),
            contextlib.redirect_stdout(io.StringIO()) as out,
        ):
            await module.cmd_send_and_sign(
                types.SimpleNamespace(session_path="/tmp/s.session", phone="+1")
            )
        return client, [json.loads(line) for line in out.getvalue().splitlines()]

    async def test_two_factor_retries_wrong_passwords_skips_blank_lines_and_stops_on_success(self):
        client, lines = await self.drive_two_factor(
            "\nbad\ngood\nnever-read\n", [lambda m: m.PasswordHashInvalid(), None]
        )
        self.assertEqual(
            lines,
            [
                {"phone_code_hash": "hash-1"},
                {"status": "2fa_required"},
                {"error": "PASSWORD_INVALID", "message": "Wrong 2FA password"},
                {"status": "ok"},
            ],
        )
        self.assertEqual(
            [c.args for c in client.check_password.await_args_list], [("bad",), ("good",)]
        )

    async def test_two_factor_flood_wait_stops_the_relay_without_failing(self):
        _, lines = await self.drive_two_factor("pw\nmore\n", [lambda m: self.flood(m, 9)])
        self.assertEqual(
            lines[-1],
            {"error": "FLOOD_WAIT", "message": "Rate limited for 9s", "retry_after": 9},
        )
        self.assertEqual(len(lines), 3)

    async def test_check_password_ok_wrong_and_flood(self):
        client = fake_client()
        _, lines, code = await self.run_command("cmd_check_password", client, "secret\n")
        self.assertEqual((lines, code), ([{"status": "ok"}], None))
        client.check_password.assert_awaited_once_with("secret")

        client = fake_client()
        module = load(client)
        client.check_password.side_effect = module.PasswordHashInvalid()
        with (
            patch.object(sys, "stdin", io.StringIO("x\n")),
            contextlib.redirect_stdout(io.StringIO()) as out,
            self.assertRaises(SystemExit) as raised,
        ):
            await module.cmd_check_password(types.SimpleNamespace(session_path="/tmp/s.session"))
        self.assertEqual(raised.exception.code, 1)
        self.assertEqual(json.loads(out.getvalue())["error"], "PASSWORD_INVALID")

        client = fake_client()
        module = load(client)
        client.check_password.side_effect = self.flood(module, 3)
        with (
            patch.object(sys, "stdin", io.StringIO("x\n")),
            contextlib.redirect_stdout(io.StringIO()) as out,
            self.assertRaises(SystemExit) as raised,
        ):
            await module.cmd_check_password(types.SimpleNamespace(session_path="/tmp/s.session"))
        self.assertEqual(raised.exception.code, 1)
        self.assertEqual(json.loads(out.getvalue())["retry_after"], 3)

    async def test_get_authorizations_lists_every_session_with_a_boolean_current_flag(self):
        def auth(index, current):
            return types.SimpleNamespace(
                hash=index,
                device_model=f"dev{index}",
                platform="p",
                system_version="s",
                app_name="a",
                country="c",
                region="r",
                ip="1.2.3.4",
                date_active=100 + index,
                current=current,
            )

        client = fake_client(
            invoke=AsyncMock(
                return_value=types.SimpleNamespace(authorizations=[auth(1, 1), auth(2, 0)])
            )
        )
        _, lines, code = await self.run_command("cmd_get_authorizations", client)
        self.assertIsNone(code)
        entries = lines[0]["authorizations"]
        self.assertEqual([e["hash"] for e in entries], [1, 2])
        self.assertEqual([e["current"] for e in entries], [True, False])
        self.assertEqual(
            sorted(entries[0]),
            sorted(
                [
                    "hash",
                    "device_model",
                    "platform",
                    "system_version",
                    "app_name",
                    "country",
                    "region",
                    "ip",
                    "date_active",
                    "current",
                ]
            ),
        )
        client.disconnect.assert_awaited_once()

    async def test_every_fatal_session_error_maps_to_its_reason(self):
        expected = {
            "SESSION_REVOKED": "revoked",
            "SESSION_EXPIRED": "expired",
            "AUTH_KEY_UNREGISTERED": "expired",
            "AUTH_KEY_INVALID": "expired",
            "USER_DEACTIVATED": "account_unavailable",
            "USER_DEACTIVATED_BAN": "account_unavailable",
            "AUTH_KEY_DUPLICATED": "local",
        }
        for error_id, reason in expected.items():
            error = type("Boom", (Exception,), {"ID": error_id})()
            client = fake_client(invoke=AsyncMock(side_effect=error))
            _, lines, code = await self.run_command("cmd_get_authorizations", client)
            self.assertEqual(code, 1, error_id)
            self.assertEqual(
                lines, [{"error": "SESSION_EXPIRED", "message": "Boom", "reason": reason}], error_id
            )

    async def test_unrecognised_failure_is_a_retryable_query_failure_without_reason(self):
        for error in (
            ConnectionError("offline"),
            type("Weird", (Exception,), {"ID": "SOMETHING_ELSE"})(),
        ):
            client = fake_client(invoke=AsyncMock(side_effect=error))
            _, lines, code = await self.run_command("cmd_get_authorizations", client)
            self.assertEqual(code, 1)
            self.assertEqual(
                lines, [{"error": "AUTH_QUERY_FAILED", "message": type(error).__name__}]
            )


if __name__ == "__main__":
    unittest.main()
