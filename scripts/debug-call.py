"""
Comprehensive debug script for P2P voice call.
Run after 5+ minute cooldown: venv/bin/python scripts/debug-call.py <user_id>
Env: MTPROTO_API_ID, MTPROTO_API_HASH, MTPROTO_SERVICE_USER_ID
"""
import os, sys

if not os.environ.get("MTPROTO_API_ID", "").isdigit() or not os.environ.get("MTPROTO_API_HASH"):
    sys.exit("MTPROTO_API_ID and MTPROTO_API_HASH must be set")
if len(sys.argv) != 2 or not sys.argv[1].isdigit():
    sys.exit("Usage: debug-call.py <user_id>")

from ntgcalls import NTgCalls, StreamMode
NTgCalls.enable_glib_loop(True)

import asyncio, time, json

from pyrogram import Client
from service_session import start_service_session
from pytgcalls import PyTgCalls
from pytgcalls.types import MediaStream

API_ID = int(os.environ["MTPROTO_API_ID"])
API_HASH = os.environ["MTPROTO_API_HASH"]
AUDIO = "/tmp/test-tone.wav"

log = []
def L(msg):
    ts = time.strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    log.append(line)

async def main():
    target = int(sys.argv[1])
    app = Client("voice_caller", api_id=API_ID, api_hash=API_HASH, workdir="data")
    calls = PyTgCalls(app)
    await start_service_session(app)
    try:
        await calls.start()
        binding = calls._binding
        L("CONNECTED to Telegram")

        # Hooks
        sigs_out = []
        conn_states = []
        def on_sig(cid, data): sigs_out.append((time.time(), len(data)))
        def on_conn(cid, info):
            state = f"kind={info.kind} state={info.state}"
            conn_states.append(state)
            L(f"CONN_CHANGE: {state}")
        binding.on_signaling(on_sig)
        binding.on_connection_change(on_conn)

        L(f"Playing {AUDIO}...")
        await calls.play(target, MediaStream(AUDIO, video_flags=MediaStream.Flags.IGNORE))
        L("PLAY called")

        # Monitor for 8 seconds
        for i in range(8):
            await asyncio.sleep(1)
            try:
                t = await asyncio.wait_for(binding.time(target, StreamMode.CAPTURE), timeout=1)
            except:
                t = "timeout"
            L(f"[{i+1}s] capture_time={t} sigs_sent={len(sigs_out)}")

        # Mute toggle to force MediaState
        L("Toggling mute...")
        try:
            await calls.mute(target)
            await asyncio.sleep(0.3)
            await calls.unmute(target)
            L("Mute toggled")
        except Exception as e:
            L(f"Mute toggle error: {e}")

        await asyncio.sleep(3)

        # Summary
        L(f"\n=== SUMMARY ===")
        L(f"Connection states: {conn_states}")
        L(f"Signaling messages sent: {len(sigs_out)}")
        if sigs_out:
            L(f"Sig sizes: {[s[1] for s in sigs_out[:10]]}")
        L(f"Total sig bytes: {sum(s[1] for s in sigs_out)}")

        await calls.leave_call(target)
    finally:
        await app.stop()
    L("ENDED")

    with open("/tmp/debug-call.log", "w") as f:
        f.write("\n".join(log))
    print(f"\nFull log saved to /tmp/debug-call.log")

asyncio.run(main())
