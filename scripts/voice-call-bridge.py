"""
Voice call bridge — plays TTS audio in a Telegram P2P call.
Usage: python voice-call-bridge.py <user_id> <audio_file> [duration_seconds]
"""
import sys, os, asyncio
from pathlib import Path

API_ID = int(os.environ.get("MTPROTO_API_ID", 0))
API_HASH = os.environ.get("MTPROTO_API_HASH", "")

USER_ID = int(sys.argv[1]) if len(sys.argv) > 1 else 0
AUDIO_FILE = sys.argv[2] if len(sys.argv) > 2 else ""
DURATION = int(sys.argv[3]) if len(sys.argv) > 3 else 15

if not USER_ID or not AUDIO_FILE or not Path(AUDIO_FILE).exists():
    print("Usage: voice-call-bridge.py <user_id> <audio_file> [duration]", file=sys.stderr)
    sys.exit(1)

from ntgcalls import NTgCalls
NTgCalls.enable_glib_loop(True)

from pyrogram import Client
from pytgcalls import PyTgCalls
from pytgcalls.types import MediaStream

async def main():
    app = Client("voice_caller", api_id=API_ID, api_hash=API_HASH, workdir="data")
    calls = PyTgCalls(app)

    @calls.on_update()
    async def handler(update):
        print(f"[UPDATE] {type(update).__name__}: {vars(update) if hasattr(update, '__dict__') else update}", flush=True)

    await app.start()
    await calls.start()
    print("CONNECTED", flush=True)

    try:
        await calls.play(
            USER_ID,
            MediaStream(AUDIO_FILE, video_flags=MediaStream.Flags.IGNORE),
        )
        print("PLAYING", flush=True)
        await asyncio.sleep(DURATION)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr, flush=True)
    finally:
        try:
            await calls.leave_call(USER_ID)
        except:
            pass
        await app.stop()
        print("ENDED", flush=True)

asyncio.run(main())
