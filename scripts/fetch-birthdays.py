"""
Batch-fetch birthday info for Telegram user IDs via Pyrogram.
stdin:  JSON array of integer user IDs
stdout: JSON object { "<user_id>": {"day": N, "month": N, "year": N} | null, ... }
        null   = checked; birthday not visible or not set
        absent = could not check (lookup failed); the caller retries it later
        year key absent if user hid birth year
Exit 0: success (partial results ok — unchecked users omitted, never set to null)
Exit 1: hard failure (session error, flood wait exceeded limit)
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

from service_session import start_service_session

API_ID = int(os.environ["MTPROTO_API_ID"])
API_HASH = os.environ["MTPROTO_API_HASH"]
FLOOD_WAIT_MAX = 30


def birthday_entry(user) -> dict | None:
    """None = checked, no visible birthday; otherwise day/month (+ year unless the user hid it)."""
    bd = getattr(user, "birthday", None)
    if bd is None:
        return None
    entry: dict = {"day": bd.day, "month": bd.month}
    if getattr(bd, "year", None):
        entry["year"] = bd.year
    return entry


async def check_user_birthday(app, uid: int, results: dict) -> None:
    """Record results[str(uid)]; leave it absent when the lookup failed (the caller retries it later).

    One retry after a FloodWait within the limit; a longer FloodWait is a hard failure (exit 1).
    """
    import logging

    from pyrogram.errors import FloodWait

    for _ in range(2):
        try:
            results[str(uid)] = birthday_entry(await app.get_users(uid))
            return
        except FloodWait as e:
            if e.value > FLOOD_WAIT_MAX:
                print(f"FloodWait {e.value}s exceeds limit", file=sys.stderr)
                sys.exit(1)
            await asyncio.sleep(e.value)
        except Exception as e:
            # A lookup that fails for any reason must only drop THIS user, never the whole batch.
            logging.getLogger("fetch-birthdays").warning("skip uid=%s: %s", uid, e, exc_info=True)
            return  # omit unresolvable users


async def fetch(user_ids: list[int]) -> dict:
    from mtproto_lock import session_lock
    from pyrogram import Client

    results = {}
    with session_lock():
        app = Client("voice_caller", api_id=API_ID, api_hash=API_HASH, workdir="data")
        await start_service_session(app)
        try:
            for uid in user_ids:
                await check_user_birthday(app, uid, results)
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
