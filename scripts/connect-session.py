#!/usr/bin/env python3
"""Pyrogram auth bridge for /connect_telegram flow.

Subcommands:
  send_code          — send verification code to phone
  sign_in            — verify code, produce session file
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
    )


async def cmd_send_code(args: argparse.Namespace) -> None:
    client = make_client(args.session_path)
    await client.connect()
    dc_before = await client.storage.dc_id()
    try:
        sent = await client.send_code(args.phone)
        dc_after = await client.storage.dc_id()
        print(json.dumps({"_dc_before": dc_before, "_dc_after": dc_after}), file=sys.stderr)
        print(json.dumps({"phone_code_hash": sent.phone_code_hash}))
    except PhoneNumberInvalid:
        print(error_json("PHONE_INVALID", "Invalid phone number"))
        sys.exit(1)
    except FloodWait as e:
        print(error_json("FLOOD_WAIT", f"Rate limited for {e.value}s", {"retry_after": e.value}))
        sys.exit(1)
    finally:
        await client.storage.save()
        await client.disconnect()


async def cmd_sign_in(args: argparse.Namespace) -> None:
    client = make_client(args.session_path)
    await client.connect()
    dc_id = await client.storage.dc_id()
    print(json.dumps({"_sign_in_dc": dc_id}), file=sys.stderr)
    try:
        await client.sign_in(args.phone, args.phone_code_hash, args.code)
        print(json.dumps({"status": "ok"}))
    except SessionPasswordNeeded:
        print(json.dumps({"status": "2fa_required"}))
    except PhoneCodeInvalid:
        print(error_json("CODE_INVALID", "Invalid verification code"))
        sys.exit(1)
    except PhoneCodeExpired:
        print(error_json("CODE_EXPIRED", "Verification code expired"))
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

    p_send = sub.add_parser("send_code")
    p_send.add_argument("--phone", required=True)
    p_send.add_argument("--session_path", required=True)

    p_sign = sub.add_parser("sign_in")
    p_sign.add_argument("--phone", required=True)
    p_sign.add_argument("--code", required=True)
    p_sign.add_argument("--phone_code_hash", required=True)
    p_sign.add_argument("--session_path", required=True)

    p_pass = sub.add_parser("check_password")
    p_pass.add_argument("--session_path", required=True)

    p_logout = sub.add_parser("log_out")
    p_logout.add_argument("--session_path", required=True)

    p_auth = sub.add_parser("get_authorizations")
    p_auth.add_argument("--session_path", required=True)

    args = parser.parse_args()

    commands = {
        "send_code": cmd_send_code,
        "sign_in": cmd_sign_in,
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
