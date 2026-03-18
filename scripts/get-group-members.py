"""
Fetch all members of a Telegram group/supergroup via MTProto.
Usage: python get-group-members.py <chat_id>
Output: JSON array of {"user_id": int} objects, one per line.
Exit code: 0 on success, 1 on failure.
Session: data/voice_caller.session
"""
import sys
import os
import asyncio
import json

API_ID = int(os.environ.get("MTPROTO_API_ID", 0))
API_HASH = os.environ.get("MTPROTO_API_HASH", "")

if len(sys.argv) < 2:
    print("Usage: get-group-members.py <chat_id>", file=sys.stderr)
    sys.exit(1)

CHAT_ID = int(sys.argv[1])


async def main():
    from pyrogram import Client

    app = Client("voice_caller", api_id=API_ID, api_hash=API_HASH, workdir="data")
    await app.start()
    try:
        members = []
        async for member in app.get_chat_members(CHAT_ID):
            if member.user and not member.user.is_bot:
                members.append({"user_id": member.user.id})
        print(json.dumps(members), flush=True)
        sys.exit(0)
    except Exception as e:
        print(f"ERROR:{e}", file=sys.stderr, flush=True)
        sys.exit(1)
    finally:
        await app.stop()


asyncio.run(main())
