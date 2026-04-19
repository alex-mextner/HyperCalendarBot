#!/usr/bin/env python3
"""Pyrogram auth bridge for /connect_telegram flow.

Subcommands:
  send_and_sign      — send code + wait for OTP on stdin + sign in (single process)
  check_password     — enter 2FA password (read from stdin to avoid ps aux leak)
  log_out            — invalidate a Pyrogram session
  get_authorizations — return JSON array of active sessions

Exit codes: 0 = success, 1 = known error (JSON on stdout), 2 = unexpected error.
"""

import argparse
import asyncio
import json
import os
import sys
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

API_ID = int(os.environ.get("MTPROTO_API_ID", "0"))
API_HASH = os.environ.get("MTPROTO_API_HASH", "")


def error_json(code: str, message: str, extra: dict | None = None) -> str:
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

        try:
            await client.sign_in(args.phone, sent.phone_code_hash, code)
            print(json.dumps({"status": "ok"}))
        except SessionPasswordNeeded:
            print(json.dumps({"status": "2fa_required"}))
        except PhoneCodeInvalid:
            print(error_json("CODE_INVALID", "Invalid verification code"))
            sys.exit(1)
        except PhoneCodeExpired:
            print(error_json("CODE_EXPIRED", "Verification code expired"))
            sys.exit(1)
    except PhoneNumberInvalid:
        print(error_json("PHONE_INVALID", "Invalid phone number"))
        sys.exit(1)
    except FloodWait as e:
        print(error_json("FLOOD_WAIT", f"Rate limited for {e.value}s", {"retry_after": e.value}))
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
        print(error_json("FLOOD_WAIT", f"Rate limited for {e.value}s", {"retry_after": e.value}))
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
        sys.exit(1)
    finally:
        await client.storage.save()
        await client.disconnect()


async def cmd_get_authorizations(args: argparse.Namespace) -> None:
    from pyrogram.raw.functions.account import GetAuthorizations

    client = make_client(args.session_path)
    await client.connect()
    try:
        auths = await client.invoke(GetAuthorizations())
        result = [
            {
                "hash": a.hash,
                "device_model": a.device_model,
                "platform": a.platform,
                "system_version": a.system_version,
                "app_name": a.app_name,
                "country": a.country,
                "region": a.region,
                "ip": a.ip,
                "date_active": a.date_active,
                "current": bool(a.current),
            }
            for a in auths.authorizations
        ]
        print(json.dumps({"authorizations": result}))
    except Exception as e:
        print(error_json("AUTH_QUERY_FAILED", str(e)))
        sys.exit(1)
    finally:
        await client.storage.save()
        await client.disconnect()


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

    args = parser.parse_args()

    commands = {
        "send_and_sign": cmd_send_and_sign,
        "check_password": cmd_check_password,
        "log_out": cmd_log_out,
        "get_authorizations": cmd_get_authorizations,
    }

    try:
        asyncio.run(commands[args.command](args))
    except Exception as e:
        print(error_json("UNEXPECTED", str(e)), file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
