"""
Bidirectional voice call bridge.
Usage: python voice-call-bridge.py <user_id> <session_id> <language>
  language: ru | en
Env: MTPROTO_API_ID, MTPROTO_API_HASH
Session: data/voice_caller.session
"""

from ntgcalls import NTgCalls
from service_session import start_service_session

NTgCalls.enable_glib_loop(True)

import asyncio
import json
import logging
import os
import struct
import sys

logger = logging.getLogger("voice-call-bridge")

API_ID = int(os.environ.get("MTPROTO_API_ID", "0"))
API_HASH = os.environ.get("MTPROTO_API_HASH", "")

if len(sys.argv) < 4:
    print("Usage: voice-call-bridge.py <user_id> <session_id> <language>", file=sys.stderr)
    sys.exit(1)

USER_ID = int(sys.argv[1])
SESSION_ID = sys.argv[2]
LANGUAGE = sys.argv[3]  # 'ru' | 'en'
WS_URL = f"ws://localhost:3001/call/{SESSION_ID}"

SAMPLE_RATE = 48000
CHUNK_MS = (
    32  # 32ms → exactly 512 samples at 16kHz after 3:1 decimation (silero requires exactly 512)
)
CHUNK_SAMPLES = SAMPLE_RATE * CHUNK_MS // 1000  # 1536 samples per chunk
CHUNK_BYTES = CHUNK_SAMPLES * 2  # s16le mono = 2 bytes per sample
VAD_THRESHOLD = 0.5

import numpy as np
import torch
import websockets
from pyrogram import Client
from pytgcalls import PyTgCalls
from pytgcalls.types import (
    ChatUpdate,
    Direction,
    MediaStream,
    RecordStream,
    StreamFrames,
)
from pytgcalls.types.raw.audio_stream import AudioParameters
from silero_vad import load_silero_vad

model = load_silero_vad()
model.eval()


def detect_vad(pcm_bytes: bytes) -> bool:
    """Returns True if speech detected in this chunk (input: 48kHz s16le mono)."""
    # silero supports only 8kHz/16kHz — resample 48kHz→16kHz before VAD
    pcm_16k = resample_to_16k(pcm_bytes)
    audio = np.frombuffer(pcm_16k, dtype=np.int16).astype(np.float32) / 32768.0
    tensor = torch.from_numpy(audio)
    prob = model(tensor, 16000).item()
    return prob > VAD_THRESHOLD


def resample_to_16k(pcm_48k: bytes) -> bytes:
    """Downsample 48kHz s16le mono to 16kHz (3:1 decimation)."""
    arr = np.frombuffer(pcm_48k, dtype=np.int16)
    arr_16k = arr[::3]  # every 3rd sample
    return arr_16k.tobytes()


async def main():
    app = Client(
        "voice_caller",
        api_id=API_ID,
        api_hash=API_HASH,
        workdir="data",
        device_model="iPhone 16 Pro",
        system_version="18.3.2",
        app_version="11.4",
        lang_code="en",
        system_lang_code="en-US",
    )
    calls = PyTgCalls(app)

    play_task: asyncio.Task | None = None
    paused = False
    call_ended = asyncio.Event()
    seq_num = 0
    play_done_event: asyncio.Event | None = None
    audio_buffer = b""
    is_speaking = False
    bun_closed_ws = False

    # ------- Connect to Bun WebSocket -------
    async with websockets.connect(WS_URL) as ws:

        def cancel_current_play():
            if play_task and not play_task.done():
                play_task.cancel()

        async def handle_play(msg):
            nonlocal play_task, play_done_event
            file_path = msg.get("file", "")
            cancel_current_play()
            play_done_event = asyncio.Event()
            await calls.play(USER_ID, MediaStream(file_path, video_flags=MediaStream.Flags.IGNORE))

            async def wait_done():
                await play_done_event.wait()
                await ws.send(json.dumps({"type": "PLAY_DONE"}))

            play_task = asyncio.create_task(wait_done())

        async def handle_pause():
            nonlocal paused
            paused = True
            try:
                # skip_stream stops outgoing audio immediately (barge-in).
                # calls.pause() only "pauses" the track — the remote still
                # hears buffered audio for several seconds. skip_stream cuts it.
                await calls.skip_stream(USER_ID)
            except Exception:
                logger.debug("skip_stream failed; falling back to pause", exc_info=True)
                try:
                    await calls.pause(USER_ID)
                except Exception:
                    logger.debug("pause failed", exc_info=True)

        async def handle_resume():
            nonlocal paused
            paused = False
            try:
                await calls.resume(USER_ID)
            except Exception:
                logger.debug("resume failed", exc_info=True)

        async def handle_stop():
            # STOP cancels current audio playback — does NOT end the call.
            # Bun sends STOP before every PLAY to interrupt in-progress audio.
            cancel_current_play()
            try:
                # pytgcalls >=3.0: skip_stream cancels current audio without hanging up
                await calls.skip_stream(USER_ID)
            except Exception:
                # older pytgcalls may not have skip_stream; cancel of play_task is enough
                logger.debug("skip_stream failed", exc_info=True)

        async def recv_commands():
            """Receive PLAY/PAUSE/RESUME/STOP from Bun."""
            async for raw in ws:
                if isinstance(raw, bytes):
                    continue  # ignore binary from Bun (shouldn't happen)
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue

                cmd = msg.get("type")
                if cmd == "PLAY":
                    await handle_play(msg)
                elif cmd == "PAUSE":
                    await handle_pause()
                elif cmd == "RESUME":
                    await handle_resume()
                elif cmd == "STOP":
                    await handle_stop()

        frames_received = 0

        async def on_audio_frame(chunk: bytes):
            """Process incoming audio chunk from the call with VAD. Caller audio is only streamed
            to Bun for live STT — never written to disk."""
            nonlocal audio_buffer, is_speaking, seq_num, frames_received

            frames_received += 1
            if frames_received == 1:
                print("[vad] first audio frame received", file=sys.stderr, flush=True)
            elif frames_received % 500 == 0:
                print(
                    f"[vad] frames={frames_received} is_speaking={is_speaking}",
                    file=sys.stderr,
                    flush=True,
                )

            if LANGUAGE == "en":
                # For EN (Flux STT): stream all audio unconditionally — Flux handles its own
                # VAD/turn detection and barge-in. paused only affects calls.pause() (outgoing TTS).
                header = struct.pack(">H", seq_num % 65536)
                await ws.send(header + resample_to_16k(chunk))
                seq_num += 1
                return

            # RU: use Python VAD to detect speech boundaries for Nova STT
            # When paused AND not yet speaking: bot is talking, skip incoming audio.
            # When already speaking (VAD_START sent): forward audio regardless of paused
            # so Nova-3 keeps receiving data even after TypeScript sent PAUSE for barge-in.
            if paused and not is_speaking:
                return

            audio_buffer += chunk
            while len(audio_buffer) >= CHUNK_BYTES:
                frame = audio_buffer[:CHUNK_BYTES]
                audio_buffer = audio_buffer[CHUNK_BYTES:]

                detected = detect_vad(frame)

                if detected and not is_speaking:
                    is_speaking = True
                    print("[vad] VAD_START", file=sys.stderr, flush=True)
                    await ws.send(json.dumps({"type": "VAD_START"}))
                    seq_num = 0

                if is_speaking:
                    header = struct.pack(">H", seq_num % 65536)
                    await ws.send(header + frame)
                    seq_num += 1

                if not detected and is_speaking:
                    is_speaking = False
                    await ws.send(json.dumps({"type": "VAD_END"}))

        # ------- Start call (lock session file during start/stop) -------
        from mtproto_lock import session_lock

        with session_lock():
            await start_service_session(app)
        await calls.start()

        @calls.on_update()
        async def on_update(_, update):
            name = type(update).__name__
            if name != "StreamFrames":
                print(f"[pytgcalls] update: {name}", file=sys.stderr, flush=True)
            if (
                "Closed" in name
                or "HungUp" in name
                or isinstance(update, ChatUpdate)
                and update.status & ChatUpdate.Status.LEFT_CALL
            ):
                call_ended.set()
            if (
                "StreamEnded" in name or "StreamAudioEnded" in name
            ) and play_done_event is not None:
                play_done_event.set()
            if isinstance(update, StreamFrames) and update.direction == Direction.INCOMING:
                for frame in update.frames:
                    await on_audio_frame(frame.frame)

        # Connect to user (muted — no audio yet; stream=None is valid in pytgcalls 2.x)
        await calls.play(USER_ID, None)

        await ws.send(json.dumps({"type": "CALL_CONNECTED"}))

        # Enable incoming audio capture — avoids a race where audio arrives
        # before the gather task is scheduled.
        # AudioParameters(48000, 1): 48kHz mono — avoids stereo de-interleave complexity
        await calls.record(
            USER_ID, RecordStream(audio=True, audio_parameters=AudioParameters(SAMPLE_RATE, 1))
        )

        ws_task = asyncio.create_task(recv_commands())
        call_done_task = asyncio.create_task(call_ended.wait())
        done, _ = await asyncio.wait([ws_task, call_done_task], return_when=asyncio.FIRST_COMPLETED)
        # True when Bun closed the WS (STT error / forced end), False when user hung up
        bun_closed_ws = ws_task in done and call_done_task not in done
        for t in [ws_task, call_done_task]:
            t.cancel()
        await asyncio.gather(ws_task, call_done_task, return_exceptions=True)

        # Send CALL_ENDED only if WS is still open (user hung up, not Bun-initiated close)
        try:
            await ws.send(json.dumps({"type": "CALL_ENDED"}))
        except Exception:
            logger.debug("CALL_ENDED send failed (ws closed)", exc_info=True)

    try:
        await calls.leave_call(USER_ID)
    except Exception:
        logger.debug("leave_call failed", exc_info=True)
    try:
        with session_lock():
            await app.stop()
    except Exception:
        logger.debug("app.stop failed", exc_info=True)

    if bun_closed_ws:
        sys.exit(1)


asyncio.run(main())
