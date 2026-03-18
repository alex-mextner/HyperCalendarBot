#!/usr/bin/env python3
"""Fetch group chat members via Pyrogram. Returns JSON array to stdout."""
import asyncio
import json
import sys
from pyrogram import Client


async def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: get-chat-members.py <chat_id>"}), file=sys.stderr)
        sys.exit(1)

    chat_id = int(sys.argv[1])

    app = Client("voice_caller", workdir="data")
    async with app:
        members = []
        async for member in app.get_chat_members(chat_id):
            if member.user and not member.user.is_bot:
                members.append({
                    "id": member.user.id,
                    "username": member.user.username,
                    "first_name": member.user.first_name,
                })
        print(json.dumps(members))


asyncio.run(main())
