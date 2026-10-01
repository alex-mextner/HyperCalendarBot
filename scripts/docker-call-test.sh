#!/bin/bash
# Test voice call from Docker Linux container
# Usage: ./scripts/docker-call-test.sh <user_id> [audio_file]
# Env: MTPROTO_API_ID, MTPROTO_API_HASH, MTPROTO_SERVICE_USER_ID

if [[ ! "${MTPROTO_API_ID:-}" =~ ^[0-9]+$ || -z "${MTPROTO_API_HASH:-}" ]]; then
  echo "MTPROTO_API_ID and MTPROTO_API_HASH must be set" >&2
  exit 1
fi
if [[ ! "${1:-}" =~ ^[0-9]+$ ]]; then
  echo "Usage: ./scripts/docker-call-test.sh <user_id> [audio_file]" >&2
  exit 1
fi

USER_ID=$1
AUDIO=${2:-/app/test.wav}

# Generate test tone inside container if no file
docker run --rm \
  --platform linux/amd64 \
  -v "$(pwd)/data:/app/data" \
  -v "$(pwd)/scripts/service_session.py:/app/service_session.py:ro" \
  -e PYTHONPATH=/app \
  -e MTPROTO_SERVICE_USER_ID \
  -v "/tmp/test-tone.wav:/app/test.wav" \
  -e MTPROTO_API_ID \
  -e MTPROTO_API_HASH \
  python:3.12-slim bash -c "
pip install -q py-tgcalls pyrofork ntgcalls tgcrypto 2>&1 | tail -1
apt-get update -qq && apt-get install -qq -y ffmpeg 2>/dev/null | tail -1

python3 << 'PYEOF'
from ntgcalls import NTgCalls
NTgCalls.enable_glib_loop(True)

import asyncio, os
from pyrogram import Client
from service_session import start_service_session
from pytgcalls import PyTgCalls
from pytgcalls.types import MediaStream
from ntgcalls import StreamMode

async def main():
    app = Client('voice_caller', api_id=int(os.environ['MTPROTO_API_ID']), api_hash=os.environ['MTPROTO_API_HASH'], workdir='/app/data')
    calls = PyTgCalls(app)
    await start_service_session(app)
    try:
        await calls.start()
        binding = calls._binding
        print('CONNECTED', flush=True)

        await calls.play(${USER_ID}, MediaStream('${AUDIO}', video_flags=MediaStream.Flags.IGNORE))
        print('PLAYING', flush=True)

        for i in range(7):
            await asyncio.sleep(1)
            t = await binding.time(${USER_ID}, StreamMode.CAPTURE)
            print(f'[{i+1}s] capture_time={t}', flush=True)

        await calls.leave_call(${USER_ID})
    finally:
        await app.stop()
    print('ENDED', flush=True)

asyncio.run(main())
PYEOF
"
