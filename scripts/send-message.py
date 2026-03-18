"""
Send a text message via Pyrogram userbot.
Usage: python send-message.py <user_id> <text> [username]
Session: data/voice_caller.session (same as voice-call-bridge.py)
Exit code: 0 on success, 1 on failure
"""
import sys
import os
import asyncio
import sqlite3

API_ID = int(os.environ.get("MTPROTO_API_ID", 0))
API_HASH = os.environ.get("MTPROTO_API_HASH", "")

if len(sys.argv) < 3:
    print("Usage: send-message.py <user_id> <text> [username]", file=sys.stderr)
    sys.exit(1)

USER_ID = int(sys.argv[1])
TEXT = sys.argv[2]
USERNAME = sys.argv[3] if len(sys.argv) > 3 else None

MAX_RETRIES = 3
RETRY_DELAY = 0.5


async def send_with_retry(app):
    for attempt in range(MAX_RETRIES):
        try:
            await app.send_message(USER_ID, TEXT)
            print("OK", flush=True)
            return True
        except sqlite3.OperationalError as e:
            if "database is locked" in str(e) and attempt < MAX_RETRIES - 1:
                await asyncio.sleep(RETRY_DELAY * (attempt + 1))
                continue
            print(f"ERROR:{e}", file=sys.stderr, flush=True)
            return False
        except Exception as e:
            msg = str(e)
            if USERNAME and ("not found" in msg.lower() or "peer_id_invalid" in msg.lower()):
                break
            print(f"ERROR:{e}", file=sys.stderr, flush=True)
            return False

    if not USERNAME:
        return False

    for attempt in range(MAX_RETRIES):
        try:
            await app.send_message(f"@{USERNAME}", TEXT)
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


async def main():
    from pyrogram import Client

    app = Client("voice_caller", api_id=API_ID, api_hash=API_HASH, workdir="data")
    await app.start()
    try:
        ok = await send_with_retry(app)
        sys.exit(0 if ok else 1)
    finally:
        await app.stop()


asyncio.run(main())
