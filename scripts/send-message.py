"""
Send a text message via Pyrogram userbot.
Usage: python send-message.py <user_id> <text> [username]
Session: data/voice_caller.session (same as voice-call-bridge.py)
Exit code: 0 on success, 1 on failure
"""
from service_session import start_service_session
import sys
import os
import asyncio
import sqlite3
from recipient_identity import send_to_recipient

API_ID = int(os.environ.get("MTPROTO_API_ID", 0))
API_HASH = os.environ.get("MTPROTO_API_HASH", "")

MAX_RETRIES = 3
RETRY_DELAY = 0.5


async def send_with_retry(app, user_id: int, text: str, username: str | None = None):
    for attempt in range(MAX_RETRIES):
        try:
            await send_to_recipient(app, user_id, text, username)
            print("OK", flush=True)
            return True
        except sqlite3.OperationalError as e:
            if "database is locked" in str(e) and attempt < MAX_RETRIES - 1:
                await asyncio.sleep(RETRY_DELAY * (attempt + 1))
                continue
            print(f"ERROR:{e}", file=sys.stderr, flush=True)
            return False
        except Exception as e:
            print(f"ERROR:{e}", file=sys.stderr, flush=True)
            return False
    return False


async def main(user_id: int, text: str, username: str | None = None):
    from pyrogram import Client
    from mtproto_lock import session_lock

    with session_lock():
        app = Client("voice_caller", api_id=API_ID, api_hash=API_HASH, workdir="data",
                     device_model="iPhone 16 Pro", system_version="18.3.2",
                     app_version="11.4", lang_code="en", system_lang_code="en-US")
        await start_service_session(app)
        try:
            ok = await send_with_retry(app, user_id, text, username)
            sys.exit(0 if ok else 1)
        finally:
            await app.stop()


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: send-message.py <user_id> <text> [username]", file=sys.stderr)
        sys.exit(1)
    asyncio.run(main(int(sys.argv[1]), sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None))
