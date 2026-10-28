"""
Quick session health check — verifies voice_caller.session is authorized.
Usage: python check-session.py
Output: JSON {"ok": true, "user_id": 123, "username": "foo"} to stdout
Exit code: 0 on success, 1 on failure
"""

import asyncio
import contextlib
import os
import sys

API_ID = int(os.environ.get("MTPROTO_API_ID", "0"))
API_HASH = os.environ.get("MTPROTO_API_HASH", "")


async def main():
    import json

    from mtproto_lock import session_lock
    from pyrogram import Client

    with session_lock():
        app = Client("voice_caller", api_id=API_ID, api_hash=API_HASH, workdir="data")
        try:
            await app.connect()
            me = await app.get_me()
            print(
                json.dumps({"ok": True, "user_id": me.id, "username": me.username or ""}),
                flush=True,
            )
        except Exception as e:  # noqa: BLE001 - whatever failed is reported to the caller as ok:false JSON
            print(json.dumps({"ok": False, "error": str(e)[:200]}), flush=True)
            sys.exit(1)
        finally:
            with contextlib.suppress(
                Exception
            ):  # best-effort disconnect after the verdict was printed
                await app.disconnect()


asyncio.run(main())
