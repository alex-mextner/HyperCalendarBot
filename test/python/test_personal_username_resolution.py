"""Exercise the real personal-username bridge with fake Pyrogram network boundaries."""

import contextlib
import io
import json
import logging
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from test_connect_session_commands import fake_client, load

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from recipient_identity import RecipientMismatch, send_to_recipient

OWNER = 61001
RECIPIENT = 62002
USERNAME = "requested_person"
PRIVATE_SENTINEL = "synthetic-private-value-never-log"


def profile(**overrides):
    fields = {
        "id": RECIPIENT,
        "first_name": "Requested Person",
        "username": USERNAME,
        "is_deleted": False,
        "deleted": False,
        "phone_number": PRIVATE_SENTINEL,
        "access_hash": PRIVATE_SENTINEL,
    }
    fields.update(overrides)
    return types.SimpleNamespace(**fields)


def resolved(user=None):
    user = user if user is not None else profile()
    return types.SimpleNamespace(peer=types.SimpleNamespace(user_id=user.id), users=[user])


def contacts_module():
    module = types.ModuleType("pyrogram.raw.functions.contacts")
    module.ResolveUsername = lambda **kwargs: types.SimpleNamespace(**kwargs)
    return module


def client_for_lookup(**overrides):
    return fake_client(
        get_me=AsyncMock(return_value=types.SimpleNamespace(id=OWNER)),
        get_users=AsyncMock(return_value=profile(id=RECIPIENT + 1000)),
        invoke=AsyncMock(return_value=resolved()),
        **overrides,
    )


def rpc_failure(error_id):
    return type("SyntheticRpcError", (Exception,), {"ID": error_id})(PRIVATE_SENTINEL)


class StaleSavedPeerClient:
    """A separate saved-session copy retains an old username-to-peer mapping."""

    def __init__(self, live_id=RECIPIENT):
        self.live_id = live_id
        self.saved_username_id = RECIPIENT + 1000
        self.known_ids = {self.saved_username_id}
        self.lookups = []
        self.resolutions = []
        self.sent = []

    async def get_chat(self, peer):
        self.lookups.append(peer)
        if type(peer) is int:
            if peer not in self.known_ids:
                raise rpc_failure("PEER_ID_INVALID")
            return types.SimpleNamespace(id=peer)
        return types.SimpleNamespace(id=self.saved_username_id)

    async def invoke(self, request):
        self.resolutions.append(request.username)
        # Pyrofork Client.invoke stores users/access hashes returned by a raw RPC.
        self.known_ids.add(self.live_id)
        self.saved_username_id = self.live_id
        return resolved(profile(id=self.live_id))

    async def send_message(self, target, text, parse_mode=None):
        if target not in self.known_ids:
            raise rpc_failure("PEER_ID_INVALID")
        self.sent.append((target, text))
        return types.SimpleNamespace(id=1)


class PersonalUsernameTests(unittest.IsolatedAsyncioTestCase):
    async def run_lookup(self, client):
        module = load(client)
        stdout = io.StringIO()
        stderr = io.StringIO()
        exit_code = 0
        args = types.SimpleNamespace(
            session_path="/tmp/synthetic-personal-session.session",
            user_id=OWNER,
            username=USERNAME,
        )
        with (
            patch.dict(sys.modules, {"pyrogram.raw.functions.contacts": contacts_module()}),
            contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr),
        ):
            try:
                await module.cmd_resolve_username(args)
            except SystemExit as error:
                exit_code = error.code
        lines = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual(len(lines), 1, "One structured result is required")
        self.assertNotIn(PRIVATE_SENTINEL, stdout.getvalue() + stderr.getvalue())
        client.disconnect.assert_awaited_once()
        return lines[0], exit_code, stderr.getvalue()

    async def test_checks_owner_before_resolving_and_returns_only_public_identity(self):
        client = client_for_lookup()
        calls = Mock()
        for name in ("connect", "get_me", "invoke", "disconnect"):
            calls.attach_mock(getattr(client, name), name)
        result, code, stderr = await self.run_lookup(client)
        self.assertEqual(code, 0)
        self.assertEqual(
            result,
            {"profile": {"id": RECIPIENT, "firstName": "Requested Person", "username": USERNAME}},
        )
        self.assertEqual(
            [call[0] for call in calls.mock_calls],
            ["connect", "get_me", "invoke", "disconnect"],
        )
        client.invoke.assert_awaited_once()
        self.assertEqual(client.invoke.await_args.args[0].username, USERNAME)
        self.assertEqual(stderr, "")

    async def test_reassigned_username_bypasses_stale_pyrogram_peer_cache(self):
        client = client_for_lookup()
        result, code, _ = await self.run_lookup(client)
        self.assertEqual(code, 0)
        self.assertEqual(result["profile"]["id"], RECIPIENT)
        client.get_users.assert_not_awaited()
        client.invoke.assert_awaited_once()

    async def test_lookup_then_send_refreshes_the_separate_saved_peer_cache(self):
        lookup, code, _ = await self.run_lookup(client_for_lookup())
        self.assertEqual(code, 0)
        recipient = lookup["profile"]
        sender = StaleSavedPeerClient()
        with patch.dict(sys.modules, {"pyrogram.raw.functions.contacts": contacts_module()}):
            await send_to_recipient(sender, recipient["id"], "synthetic", recipient["username"])
        self.assertEqual(sender.lookups, [RECIPIENT])
        self.assertEqual(sender.resolutions, [USERNAME])
        self.assertEqual(sender.sent, [(RECIPIENT, "synthetic")])

    async def test_reassignment_after_lookup_cannot_change_the_send_recipient(self):
        lookup, code, _ = await self.run_lookup(client_for_lookup())
        self.assertEqual(code, 0)
        recipient = lookup["profile"]
        sender = StaleSavedPeerClient(live_id=RECIPIENT + 1)
        with (
            patch.dict(sys.modules, {"pyrogram.raw.functions.contacts": contacts_module()}),
            self.assertRaises(RecipientMismatch),
        ):
            await send_to_recipient(sender, recipient["id"], "synthetic", recipient["username"])
        self.assertEqual(sender.sent, [])

    async def test_resolved_peer_id_selects_the_user_instead_of_vector_order(self):
        client = client_for_lookup()
        client.invoke.return_value.users.insert(0, profile(id=RECIPIENT + 1))
        result, code, _ = await self.run_lookup(client)
        self.assertEqual(code, 0)
        self.assertEqual(result["profile"]["id"], RECIPIENT)

    async def test_channel_username_is_not_an_invitable_user(self):
        client = client_for_lookup()
        client.invoke.return_value.peer = types.SimpleNamespace(channel_id=RECIPIENT)
        result, code, _ = await self.run_lookup(client)
        self.assertEqual((result, code), ({"profile": None}, 0))

    async def test_wrong_account_never_reads_the_requested_profile(self):
        client = client_for_lookup()
        client.get_me.return_value = types.SimpleNamespace(id=OWNER + 1)
        result, code, _ = await self.run_lookup(client)
        self.assertEqual(code, 1)
        self.assertEqual(result["error"], "SESSION_OWNER_MISMATCH")
        client.invoke.assert_not_awaited()

    async def test_only_known_absent_username_errors_report_not_found(self):
        for error_id in ("USERNAME_NOT_OCCUPIED", "USERNAME_INVALID"):
            with self.subTest(error_id=error_id):
                client = client_for_lookup()
                client.invoke.side_effect = rpc_failure(error_id)
                result, code, stderr = await self.run_lookup(client)
                self.assertEqual((result, code), ({"profile": None}, 0))
                self.assertEqual(stderr, "")

    async def test_deleted_account_does_not_return_an_invitable_profile(self):
        client = client_for_lookup()
        client.invoke.return_value = resolved(profile(deleted=True))
        result, code, _ = await self.run_lookup(client)
        self.assertEqual((result, code), ({"profile": None}, 0))

    async def test_missing_public_name_uses_the_requested_username(self):
        client = client_for_lookup()
        client.invoke.return_value = resolved(profile(first_name=None, username=None))
        result, code, _ = await self.run_lookup(client)
        self.assertEqual(code, 0)
        self.assertEqual(
            result,
            {"profile": {"id": RECIPIENT, "firstName": USERNAME, "username": USERNAME}},
        )

    async def test_transient_failures_never_report_session_loss(self):
        errors = (
            ConnectionError(PRIVATE_SENTINEL),
            TimeoutError(PRIVATE_SENTINEL),
            rpc_failure("FLOOD_WAIT"),
            rpc_failure("UNRECOGNIZED_RPC_ERROR"),
        )
        for phase in ("connect", "get_me", "invoke"):
            for error in errors:
                with self.subTest(phase=phase, error=type(error).__name__):
                    client = client_for_lookup()
                    getattr(client, phase).side_effect = error
                    result, code, _ = await self.run_lookup(client)
                    self.assertEqual(code, 1)
                    self.assertEqual(
                        result,
                        {"error": "AUTH_QUERY_FAILED", "message": type(error).__name__},
                    )
                    if phase != "invoke":
                        client.invoke.assert_not_awaited()

    async def test_fatal_failures_keep_their_specific_reason_in_every_phase(self):
        expected = {
            "SESSION_REVOKED": "revoked",
            "SESSION_EXPIRED": "expired",
            "AUTH_KEY_UNREGISTERED": "expired",
            "AUTH_KEY_INVALID": "expired",
            "USER_DEACTIVATED": "account_unavailable",
            "USER_DEACTIVATED_BAN": "account_unavailable",
            "AUTH_KEY_DUPLICATED": "local",
        }
        for phase in ("connect", "get_me", "invoke"):
            for error_id, reason in expected.items():
                with self.subTest(phase=phase, error_id=error_id):
                    client = client_for_lookup()
                    getattr(client, phase).side_effect = rpc_failure(error_id)
                    result, code, _ = await self.run_lookup(client)
                    self.assertEqual(code, 1)
                    self.assertEqual(
                        result,
                        {"error": "SESSION_EXPIRED", "message": "SyntheticRpcError", "reason": reason},
                    )
                    if phase != "invoke":
                        client.invoke.assert_not_awaited()

    async def test_cleanup_failure_preserves_success_not_found_and_revocation(self):
        for error_id in (None, "USERNAME_NOT_OCCUPIED", "SESSION_REVOKED"):
            with self.subTest(error_id=error_id):
                client = client_for_lookup()
                client.disconnect.side_effect = ConnectionError(PRIVATE_SENTINEL)
                if error_id:
                    client.invoke.side_effect = rpc_failure(error_id)
                result, code, stderr = await self.run_lookup(client)
                self.assertIn("ConnectionError", stderr)
                if error_id == "SESSION_REVOKED":
                    self.assertEqual(code, 1)
                    self.assertEqual(result["error"], "SESSION_EXPIRED")
                    self.assertEqual(result["reason"], "revoked")
                elif error_id:
                    self.assertEqual((result, code), ({"profile": None}, 0))
                else:
                    self.assertEqual(code, 0)
                    self.assertEqual(result["profile"]["id"], RECIPIENT)


class PersonalUsernameMainTests(unittest.TestCase):
    def test_cli_keeps_json_stdout_and_private_operational_logs(self):
        cases = (
            ("success", None, None, None),
            ("owner_mismatch", None, "SESSION_OWNER_MISMATCH", None),
            ("fatal", rpc_failure("SESSION_REVOKED"), "SESSION_EXPIRED", "revoked"),
            ("transient", ConnectionError(PRIVATE_SENTINEL), "AUTH_QUERY_FAILED", None),
            ("unknown_rpc", rpc_failure(PRIVATE_SENTINEL), "AUTH_QUERY_FAILED", None),
        )
        for scenario, failure, error_code, reason in cases:
            with self.subTest(scenario=scenario):
                self._assert_cli_case(scenario, failure, error_code, reason)

    def _assert_cli_case(self, scenario, failure, error_code, reason):
        client = client_for_lookup()
        if scenario == "owner_mismatch":
            client.get_me.return_value = types.SimpleNamespace(id=OWNER + 1)
        elif failure:
            client.get_me.side_effect = failure
        module = load(client)
        stdout = io.StringIO()
        stderr = io.StringIO()
        logfile = io.StringIO()
        isolated_logger = logging.Logger("personal-username-test")
        args = [
            "connect-session.py", "resolve_username",
            "--session_path", f"/tmp/{PRIVATE_SENTINEL}.session",
            "--user_id", str(OWNER), "--username", USERNAME,
        ]
        exit_code = 0
        with (
            patch.dict(sys.modules, {"pyrogram.raw.functions.contacts": contacts_module()}),
            patch.object(sys, "argv", args),
            patch.object(module, "logger", isolated_logger),
            patch.object(module.os, "open", return_value=700) as open_log,
            patch.object(module.os, "fdopen", return_value=logfile),
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
        ):
            try:
                module.main()
            except SystemExit as error:
                exit_code = error.code
        self.assertEqual(exit_code, 1 if error_code else 0)
        result = json.loads(stdout.getvalue())
        if error_code:
            self.assertEqual(result["error"], error_code)
            self.assertEqual(result.get("reason"), reason)
        else:
            self.assertEqual(result["profile"]["id"], RECIPIENT)
        self.assertEqual(open_log.call_args.args[2], 0o600)
        self.assertTrue(open_log.call_args.args[0].startswith("/tmp/"))
        self._assert_operational_logs(
            (stderr.getvalue(), logfile.getvalue()), exit_code, error_code, reason,
        )

    def _assert_operational_logs(self, outputs, exit_code, error_code, reason):
        expected_classification = []
        if error_code:
            suffix = f" reason={reason}" if reason else ""
            expected_classification = [f"code={error_code}{suffix}"]
        for output in outputs:
            self.assertIn("Started command=resolve_username", output)
            self.assertIn(f"Completed command=resolve_username rc={exit_code}", output)
            self.assertNotIn(USERNAME, output)
            self.assertNotIn(PRIVATE_SENTINEL, output)
            self.assertNotIn("Traceback", output)
            self.assertEqual(
                [line.split("Session query failed ", 1)[1]
                 for line in output.splitlines() if "Session query failed " in line],
                expected_classification,
            )


if __name__ == "__main__":
    unittest.main()
