#!/usr/bin/env python3
"""Send a Telegram message using a user's Pyrogram session."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from pyrogram import Client
from pyrogram.enums import MessageEntityType, ParseMode
from pyrogram.errors import (
    AuthKeyUnregistered,
    FloodWait,
    PeerIdInvalid,
    SessionRevoked,
    UserDeactivated,
)
from pyrogram.types import MessageEntity
from recipient_identity import RecipientMismatch, send_to_recipient

API_ID = int(os.environ.get("MTPROTO_API_ID", "0"))
API_HASH = os.environ.get("MTPROTO_API_HASH", "")


async def send_message(
    session_path: str,
    user_id: int,
    text: str,
    username: str | None,
    italic_footer: list[int] | None = None,
) -> None:
    entities = None
    if italic_footer is not None:
        offset, length = italic_footer
        utf16_text = text.encode("utf-16-le")
        if offset < 0 or length <= 0 or (offset + length) * 2 != len(utf16_text):
            raise ValueError("Invalid italic footer span")
        # Reject a boundary inside an emoji's surrogate pair before connecting.
        utf16_text[offset * 2:].decode("utf-16-le")
        entities = [MessageEntity(type=MessageEntityType.ITALIC, offset=offset, length=length)]
    p = Path(session_path)
    client = Client(
        name=p.with_suffix("").name,
        api_id=API_ID,
        api_hash=API_HASH,
        workdir=str(p.parent) or ".",
    )
    try:
        await client.connect()
        # First-person text is plain: default parsing would strip -- and __ from map
        # place IDs and turn ** or <b> in titles into formatting.
        # Only the generated footer is italic; meeting fields remain literal.
        await send_to_recipient(
            client, user_id, text, username, parse_mode=ParseMode.DISABLED, entities=entities
        )
        print(json.dumps({"status": "ok"}))
    except (AuthKeyUnregistered, SessionRevoked, UserDeactivated) as e:
        print(
            json.dumps(
                {
                    "error": "SESSION_EXPIRED",
                    "message": str(e),
                    "reason": "revoked"
                    if isinstance(e, SessionRevoked)
                    else "account_unavailable"
                    if isinstance(e, UserDeactivated)
                    else "expired",
                }
            )
        )
        sys.exit(1)
    except RecipientMismatch as e:
        print(json.dumps({"error": "RECIPIENT_MISMATCH", "message": str(e)}))
        sys.exit(1)
    except PeerIdInvalid:
        print(json.dumps({"error": "PEER_INVALID", "message": f"Cannot reach user {user_id}"}))
        sys.exit(1)
    except FloodWait as e:
        print(json.dumps({"error": "FLOOD_WAIT", "retry_after": e.value}))
        sys.exit(1)
    finally:
        try:
            await client.disconnect()
        except Exception as cleanup_error:  # noqa: BLE001 - cleanup must not mask the real outcome
            print(f"Session cleanup: {type(cleanup_error).__name__}", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session_path", required=True)
    parser.add_argument("--user_id", type=int, required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--username", default=None)
    parser.add_argument("--italic_footer", type=int, nargs=2, metavar=("OFFSET", "LENGTH"))
    args = parser.parse_args()
    asyncio.run(send_message(args.session_path, args.user_id, args.text, args.username, args.italic_footer))


if __name__ == "__main__":
    main()
