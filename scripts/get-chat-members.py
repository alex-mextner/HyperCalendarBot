#!/usr/bin/env python3
"""Fetch group chat members via Pyrogram. Returns JSON array to stdout."""

import asyncio
import json
import sys
import os
from pyrogram import Client
from service_session import start_service_session


async def main():
    if len(sys.argv) < 2:
        print(
            json.dumps({"error": "Usage: get-chat-members.py <chat_id>"}),
            file=sys.stderr,
        )
        sys.exit(1)

    chat_id = int(sys.argv[1])

    from mtproto_lock import session_lock

    with session_lock():
        app = Client(
            "voice_caller",
            api_id=int(os.environ.get("MTPROTO_API_ID", "0")),
            api_hash=os.environ.get("MTPROTO_API_HASH", ""),
            workdir="data",
        )
        await start_service_session(app)
        try:
            members = []
            async for member in app.get_chat_members(chat_id):
                if member.user and not member.user.is_bot:
                    members.append(
                        {
                            "id": member.user.id,
                            "username": member.user.username,
                            "first_name": member.user.first_name,
                        }
                    )
            print(json.dumps(members))
        finally:
            await app.stop()


asyncio.run(main())
