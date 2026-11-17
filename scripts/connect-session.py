#!/usr/bin/env python3
"""Pyrogram auth bridge for /connect_telegram flow.

Subcommands:
  send_and_sign      — send code + wait for OTP on stdin + sign in (single process)
  check_password     — enter 2FA password (read from stdin to avoid ps aux leak)
  log_out            — invalidate a Pyrogram session
  get_authorizations — return JSON array of active sessions
  resolve_username   — resolve one public username using the connected account

Exit codes: 0 = success, 1 = known error (JSON on stdout), 2 = unexpected error.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path

from pyrogram import Client
from pyrogram.errors import (
    FloodWait,
    PasswordHashInvalid,
    PhoneCodeExpired,
    PhoneCodeInvalid,
    PhoneNumberInvalid,
    SessionPasswordNeeded,
)

logger = logging.getLogger("connect-session")

API_ID = int(os.environ.get("MTPROTO_API_ID", "0"))
API_HASH = os.environ.get("MTPROTO_API_HASH", "")


def error_json(code: str, message: str, extra: dict | None = None) -> str:
    # Only fixed classifications enter the operational log, never protocol messages or identities.
    if code in {"SESSION_EXPIRED", "SESSION_OWNER_MISMATCH", "AUTH_QUERY_FAILED"}:
        reason = (extra or {}).get("reason")
        if code == "SESSION_EXPIRED" and reason in {"revoked", "expired", "account_unavailable", "local"}:
            logger.warning("Session query failed code=%s reason=%s", code, reason)
        else:
            logger.warning("Session query failed code=%s", code)
    result = {"error": code, "message": message}
    if extra:
        result.update(extra)
    return json.dumps(result)


def make_client(session_path: str) -> Client:
    p = Path(session_path)
    return Client(
        name=p.with_suffix("").name,
        api_id=API_ID,
        api_hash=API_HASH,
        workdir=str(p.parent) or ".",
        device_model="Desktop",
        system_version="Windows 11",
        app_version="5.9.0",
    )


def flood_wait_json(error: FloodWait) -> str:
    return error_json(
        "FLOOD_WAIT", f"Rate limited for {error.value}s", {"retry_after": error.value}
    )


async def relay_two_factor_passwords(client: Client) -> None:
    """Stay alive after 2fa_required: each stdin line is a password attempt, the result goes to stdout."""
    for line in sys.stdin:
        password = line.rstrip("\n")
        if not password:
            continue
        try:
            await client.check_password(password)
            print(json.dumps({"status": "ok"}))
            break
        except PasswordHashInvalid:
            print(error_json("PASSWORD_INVALID", "Wrong 2FA password"))
            sys.stdout.flush()
        except FloodWait as e:
            print(flood_wait_json(e))
            break


async def sign_in_with_code(client: Client, phone: str, phone_code_hash: str, code: str) -> None:
    try:
        await client.sign_in(phone, phone_code_hash, code)
        print(json.dumps({"status": "ok"}))
    except SessionPasswordNeeded:
        print(json.dumps({"status": "2fa_required"}))
        sys.stdout.flush()
        # Handle 2FA in the same process/connection.
        await relay_two_factor_passwords(client)
    except PhoneCodeInvalid:
        print(error_json("CODE_INVALID", "Invalid verification code"))
        sys.exit(1)
    except PhoneCodeExpired:
        print(error_json("CODE_EXPIRED", "Verification code expired"))
        sys.exit(1)


async def cmd_send_and_sign(args: argparse.Namespace) -> None:
    """Single process: send_code, wait for code on stdin, then sign_in.

    Keeps the same Pyrogram Client + MTProto session alive throughout.
    Avoids CODE_EXPIRED caused by reconnecting with a new session_id.

    Protocol:
      stdout line 1: {"phone_code_hash": "..."} — code sent, waiting for input
      stdin  line 1: the 5-digit OTP code
      stdout line 2: {"status": "ok"} or {"status": "2fa_required"}
      (on error: exit 1 with error JSON on stdout)
    """
    client = make_client(args.session_path)
    await client.connect()
    try:
        sent = await client.send_code(args.phone)
        # Signal: code sent, hash available
        print(json.dumps({"phone_code_hash": sent.phone_code_hash}))
        sys.stdout.flush()

        # Wait for the OTP code on stdin (TypeScript pipes it when user enters)
        code = sys.stdin.readline().rstrip("\n")
        if not code:
            print(error_json("NO_CODE", "No code received on stdin"))
            sys.exit(1)

        await sign_in_with_code(client, args.phone, sent.phone_code_hash, code)
    except PhoneNumberInvalid:
        print(error_json("PHONE_INVALID", "Invalid phone number"))
        sys.exit(1)
    except FloodWait as e:
        print(flood_wait_json(e))
        sys.exit(1)
    finally:
        await client.storage.save()
        await client.disconnect()


async def cmd_check_password(args: argparse.Namespace) -> None:
    password = sys.stdin.readline().rstrip("\n")
    client = make_client(args.session_path)
    await client.connect()
    try:
        await client.check_password(password)
        print(json.dumps({"status": "ok"}))
    except PasswordHashInvalid:
        print(error_json("PASSWORD_INVALID", "Wrong 2FA password"))
        sys.exit(1)
    except FloodWait as e:
        print(flood_wait_json(e))
        sys.exit(1)
    finally:
        await client.storage.save()
        await client.disconnect()


async def cmd_log_out(args: argparse.Namespace) -> None:
    client = make_client(args.session_path)
    await client.connect()
    try:
        await client.log_out()
        print(json.dumps({"status": "ok"}))
    except Exception as e:
        print(error_json("LOG_OUT_FAILED", str(e)))
        raise SystemExit(1) from e
    finally:
        await client.storage.save()
        await client.disconnect()


# Telegram error IDs meaning the stored session can never work again; the keepalive reports these as
# SESSION_EXPIRED so the bot drops the session, anything else is a retryable AUTH_QUERY_FAILED.
FATAL_SESSION_ERRORS = {
    "SESSION_REVOKED",
    "SESSION_EXPIRED",
    "AUTH_KEY_UNREGISTERED",
    "AUTH_KEY_INVALID",
    "USER_DEACTIVATED",
    "USER_DEACTIVATED_BAN",
    "AUTH_KEY_DUPLICATED",
}


def authorization_entry(auth) -> dict:
    return {
        "hash": auth.hash,
        "device_model": auth.device_model,
        "platform": auth.platform,
        "system_version": auth.system_version,
        "app_name": auth.app_name,
        "country": auth.country,
        "region": auth.region,
        "ip": auth.ip,
        "date_active": auth.date_active,
        "current": bool(auth.current),
    }


def fatal_session_reason(reason: str) -> str:
    """Who is to blame for a fatal session error: the user (revoked/expired), their account, or this host."""
    if reason == "SESSION_REVOKED":
        return "revoked"
    if reason.startswith("USER_DEACTIVATED"):
        return "account_unavailable"
    if reason == "AUTH_KEY_DUPLICATED":
        return "local"
    return "expired"


def authorization_failure_json(error: Exception) -> str:
    reason = getattr(error, "ID", "")
    if reason not in FATAL_SESSION_ERRORS:
        return error_json("AUTH_QUERY_FAILED", type(error).__name__)
    return error_json(
        "SESSION_EXPIRED",
        type(error).__name__,
        {"reason": fatal_session_reason(reason)},
    )


async def disconnect_quietly(client: Client) -> None:
    try:
        await client.disconnect()
    except Exception as cleanup_error:
        print(
            f"Session query cleanup: {type(cleanup_error).__name__}",
            file=sys.stderr,
        )
        logger.debug("disconnect failed", exc_info=True)


async def cmd_get_authorizations(args: argparse.Namespace) -> None:
    from pyrogram.raw.functions.account import GetAuthorizations

    client = make_client(args.session_path)
    try:
        await client.connect()
        auths = await client.invoke(GetAuthorizations())
        result = [authorization_entry(a) for a in auths.authorizations]
        print(json.dumps({"authorizations": result}))
    except Exception as e:
        print(authorization_failure_json(e))
        raise SystemExit(1) from e
    finally:
        await disconnect_quietly(client)


async def cmd_resolve_username(args: argparse.Namespace) -> None:
    from pyrogram.raw.functions.contacts import ResolveUsername

    client = make_client(args.session_path)
    try:
        await client.connect()
        owner = await client.get_me()
        if owner.id != args.user_id:
            print(error_json("SESSION_OWNER_MISMATCH", "Connected account does not match requester"))
            raise SystemExit(1)
        # get_users('@name') may resolve through Pyrogram's stale username cache.
        # ResolveUsername asks Telegram for the current owner of this exact public handle.
        resolved = await client.invoke(ResolveUsername(username=args.username.lstrip('@')))
        peer_id = getattr(resolved.peer, "user_id", None)
        if peer_id is None:
            print(json.dumps({"profile": None}))
            return
        user = next((entry for entry in resolved.users if entry.id == peer_id), None)
        if user is None:
            raise ValueError("Resolved user missing from response")
        if getattr(user, "deleted", False) or not hasattr(user, "first_name"):
            print(json.dumps({"profile": None}))
            return
        username = getattr(user, "username", None) or args.username
        print(json.dumps({"profile": {
            "id": user.id,
            "firstName": user.first_name or username,
            "username": username,
        }}))
    except Exception as error:
        if getattr(error, "ID", "") in {"USERNAME_NOT_OCCUPIED", "USERNAME_INVALID"}:
            print(json.dumps({"profile": None}))
            return
        print(authorization_failure_json(error))
        raise SystemExit(1) from error
    finally:
        await disconnect_quietly(client)


def initialize_command_log(command: str) -> str:
    """Log operational outcomes without session data, usernames, phone numbers or auth input."""
    path = f"/tmp/hypercal-connect-{time.time_ns()}-{os.getpid()}.log"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    for stream in (os.fdopen(fd, "w"), sys.stderr):
        handler = logging.StreamHandler(stream)
        handler.setFormatter(formatter)
        logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.info("Started command=%s log=%s", command, path)
    return path


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    p_send_sign = sub.add_parser("send_and_sign")
    p_send_sign.add_argument("--phone", required=True)
    p_send_sign.add_argument("--session_path", required=True)

    p_pass = sub.add_parser("check_password")
    p_pass.add_argument("--session_path", required=True)

    p_logout = sub.add_parser("log_out")
    p_logout.add_argument("--session_path", required=True)

    p_auth = sub.add_parser("get_authorizations")
    p_auth.add_argument("--session_path", required=True)

    p_resolve = sub.add_parser("resolve_username")
    p_resolve.add_argument("--session_path", required=True)
    p_resolve.add_argument("--user_id", type=int, required=True)
    p_resolve.add_argument("--username", required=True)

    args = parser.parse_args()

    commands = {
        "send_and_sign": cmd_send_and_sign,
        "check_password": cmd_check_password,
        "log_out": cmd_log_out,
        "get_authorizations": cmd_get_authorizations,
        "resolve_username": cmd_resolve_username,
    }

    log_path = initialize_command_log(args.command)
    started = time.monotonic()
    exit_code = 0
    try:
        asyncio.run(commands[args.command](args))
    except SystemExit as error:
        exit_code = error.code if isinstance(error.code, int) else 1
        raise
    except Exception as error:
        exit_code = 2
        logger.error("Command failed error_type=%s", type(error).__name__)
        print(error_json("UNEXPECTED", type(error).__name__), file=sys.stderr)
        raise SystemExit(2) from error
    finally:
        logger.info("Completed command=%s rc=%s elapsed_s=%.3f log=%s", args.command, exit_code, time.monotonic() - started, log_path)


if __name__ == "__main__":
    main()
