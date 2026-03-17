"""
Voice call bridge — rings user + sends TTS as voice message.
Usage: python voice-call-bridge.py <user_id> <audio_file> [ring_seconds]
Env: MTPROTO_API_ID, MTPROTO_API_HASH
Session: data/voice_caller.session (pyrogram)
"""
import sys, os, asyncio, secrets
from pathlib import Path

API_ID = int(os.environ.get("MTPROTO_API_ID", 0))
API_HASH = os.environ.get("MTPROTO_API_HASH", "")

USER_ID = int(sys.argv[1]) if len(sys.argv) > 1 else 0
AUDIO_FILE = sys.argv[2] if len(sys.argv) > 2 else ""
RING_SEC = int(sys.argv[3]) if len(sys.argv) > 3 else 5

if not USER_ID or not AUDIO_FILE or not Path(AUDIO_FILE).exists():
    print("Usage: voice-call-bridge.py <user_id> <audio_file> [ring_seconds]", file=sys.stderr)
    sys.exit(1)

from pyrogram import Client
from pyrogram.raw.functions.phone import RequestCall, DiscardCall
from pyrogram.raw.types import InputPhoneCall, PhoneCallDiscardReasonHangup, PhoneCallProtocol

async def main():
    app = Client("voice_caller", api_id=API_ID, api_hash=API_HASH, workdir="data")
    await app.start()
    peer = await app.resolve_peer(USER_ID)
    print("CONNECTED", flush=True)

    # Step 1: Ring
    try:
        result = await app.invoke(RequestCall(
            user_id=peer,
            random_id=int.from_bytes(secrets.token_bytes(4), byteorder="big", signed=True) & 0x7FFFFFFF,
            g_a_hash=secrets.token_bytes(32),
            protocol=PhoneCallProtocol(
                udp_p2p=True, udp_reflector=True,
                min_layer=92, max_layer=92,
                library_versions=["8.0.0"],
            ),
        ))
        call = result.phone_call
        print(f"RINGING id={call.id}", flush=True)
        await asyncio.sleep(RING_SEC)
        await app.invoke(DiscardCall(
            peer=InputPhoneCall(id=call.id, access_hash=call.access_hash),
            duration=0, reason=PhoneCallDiscardReasonHangup(), connection_id=0,
        ))
        print("HUNG_UP", flush=True)
    except Exception as e:
        print(f"RING_ERROR:{e}", flush=True)

    # Step 2: Send voice message
    try:
        await app.send_voice(USER_ID, AUDIO_FILE)
        print("VOICE_SENT", flush=True)
    except Exception as e:
        print(f"VOICE_ERROR:{e}", flush=True)

    await app.stop()

asyncio.run(main())
