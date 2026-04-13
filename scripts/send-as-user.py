#!/usr/bin/env python3
"""Send a Telegram message using a user's Pyrogram session."""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from pyrogram import Client
from pyrogram.errors import (
    AuthKeyUnregistered,
    FloodWait,
    PeerIdInvalid,
    SessionRevoked,
    UserDeactivated,
)

API_ID = int(os.environ.get("MTPROTO_API_ID", "0"))
API_HASH = os.environ.get("MTPROTO_API_HASH", "")


async def send_message(session_path: str, user_id: int, text: str, username: str | None) -> None:
    p = Path(session_path)
    client = Client(
        name=p.with_suffix("").name,
        api_id=API_ID,
        api_hash=API_HASH,
        workdir=str(p.parent) or ".",
    )
    await client.connect()
    try:
        target = username if username else user_id
        await client.send_message(target, text)
        print(json.dumps({"status": "ok"}))
    except (AuthKeyUnregistered, SessionRevoked, UserDeactivated) as e:
        print(json.dumps({"error": "SESSION_EXPIRED", "message": str(e)}))
        sys.exit(1)
    except PeerIdInvalid:
        print(json.dumps({"error": "PEER_INVALID", "message": f"Cannot reach user {user_id}"}))
        sys.exit(1)
    except FloodWait as e:
        print(json.dumps({"error": "FLOOD_WAIT", "retry_after": e.value}))
        sys.exit(1)
    finally:
        await client.disconnect()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session_path", required=True)
    parser.add_argument("--user_id", type=int, required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--username", default=None)
    args = parser.parse_args()
    asyncio.run(send_message(args.session_path, args.user_id, args.text, args.username))


if __name__ == "__main__":
    main()
