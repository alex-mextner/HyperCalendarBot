"""
Batch-fetch birthday info for Telegram user IDs via Pyrogram.
stdin:  JSON array of integer user IDs
stdout: JSON object { "<user_id>": {"day": N, "month": N, "year": N} | null, ... }
        null  = birthday not visible or not set
        year key absent if user hid birth year
Exit 0: success (partial results ok — unresolvable users omitted, not set to null)
Exit 1: hard failure (session error, flood wait exceeded limit)
"""
from service_session import start_service_session
import sys
import os
import json
import asyncio

API_ID = int(os.environ["MTPROTO_API_ID"])
API_HASH = os.environ["MTPROTO_API_HASH"]
FLOOD_WAIT_MAX = 30


async def fetch(user_ids: list[int]) -> dict:
    from pyrogram import Client
    from pyrogram.errors import FloodWait
    from mtproto_lock import session_lock

    results = {}
    with session_lock():
        app = Client("voice_caller", api_id=API_ID, api_hash=API_HASH, workdir="data")
        await start_service_session(app)
        try:
            for uid in user_ids:
                for attempt in range(2):
                    try:
                        user = await app.get_users(uid)
                        bd = getattr(user, 'birthday', None)
                        if bd is None:
                            results[str(uid)] = None
                        else:
                            entry: dict = {"day": bd.day, "month": bd.month}
                            if getattr(bd, 'year', None):
                                entry["year"] = bd.year
                            results[str(uid)] = entry
                        break
                    except FloodWait as e:
                        if e.value > FLOOD_WAIT_MAX:
                            print(f"FloodWait {e.value}s exceeds limit", file=sys.stderr)
                            sys.exit(1)
                        await asyncio.sleep(e.value)
                    except Exception as e:
                        print(f"skip uid={uid}: {e}", file=sys.stderr)
                        break  # omit unresolvable users
        finally:
            await app.stop()
    return results


def main():
    raw = sys.stdin.read().strip()
    try:
        user_ids = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"Invalid JSON: {e}", file=sys.stderr)
        sys.exit(1)

    results = asyncio.run(fetch(user_ids))
    print(json.dumps(results))


main()
