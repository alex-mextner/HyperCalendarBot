"""
Resolve a Telegram @username to user info via Pyrogram userbot.
Usage: python resolve-username.py <username>
  username may or may not start with @
Output: JSON {"id": 123456, "firstName": "John", "username": "john"} to stdout
Exit code: 0 on success, 1 on failure
Session: data/voice_caller.session
"""
import sys
import os
import asyncio
import json
import sqlite3

API_ID = int(os.environ.get("MTPROTO_API_ID", 0))
API_HASH = os.environ.get("MTPROTO_API_HASH", "")

if len(sys.argv) < 2:
    print("Usage: resolve-username.py <username>", file=sys.stderr)
    sys.exit(1)

USERNAME = sys.argv[1].lstrip("@")

MAX_RETRIES = 3
RETRY_DELAY = 0.5


async def resolve_with_retry(app):
    for attempt in range(MAX_RETRIES):
        try:
            user = await app.get_users(f"@{USERNAME}")
            return {
                "id": user.id,
                "firstName": user.first_name or "",
                "username": user.username or USERNAME,
            }
        except sqlite3.OperationalError as e:
            if "database is locked" in str(e) and attempt < MAX_RETRIES - 1:
                await asyncio.sleep(RETRY_DELAY * (attempt + 1))
                continue
            print(f"ERROR:{e}", file=sys.stderr, flush=True)
            return None
        except Exception as e:
            print(f"ERROR:{e}", file=sys.stderr, flush=True)
            return None
    return None


async def main():
    from pyrogram import Client
    from mtproto_lock import session_lock

    with session_lock():
        app = Client("voice_caller", api_id=API_ID, api_hash=API_HASH, workdir="data")
        await app.start()
        try:
            result = await resolve_with_retry(app)
            if result is not None:
                print(json.dumps(result), flush=True)
                sys.exit(0)
            else:
                sys.exit(1)
        finally:
            await app.stop()


asyncio.run(main())
