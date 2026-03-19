"""
Bidirectional voice call bridge.
Usage: python voice-call-bridge.py <user_id> <session_id> <language>
  language: ru | en
Env: MTPROTO_API_ID, MTPROTO_API_HASH
Session: data/voice_caller.session
"""
from ntgcalls import NTgCalls
NTgCalls.enable_glib_loop(True)

import sys, os, asyncio, json, struct
from pathlib import Path

API_ID = int(os.environ.get("MTPROTO_API_ID", 0))
API_HASH = os.environ.get("MTPROTO_API_HASH", "")

if len(sys.argv) < 4:
    print("Usage: voice-call-bridge.py <user_id> <session_id> <language>", file=sys.stderr)
    sys.exit(1)

USER_ID = int(sys.argv[1])
SESSION_ID = sys.argv[2]
LANGUAGE = sys.argv[3]  # 'ru' | 'en'
WS_URL = f"ws://localhost:3001/call/{SESSION_ID}"

SAMPLE_RATE = 48000
CHUNK_MS = 20
CHUNK_SAMPLES = SAMPLE_RATE * CHUNK_MS // 1000  # 960 samples per chunk
CHUNK_BYTES = CHUNK_SAMPLES * 2  # s16le = 2 bytes per sample
VAD_THRESHOLD = 0.5

import torch
import numpy as np
from silero_vad import load_silero_vad

from pyrogram import Client
from pytgcalls import PyTgCalls
from pytgcalls.types import MediaStream, AudioQuality, AudioReceiver

import websockets

model, _ = load_silero_vad()
model.eval()

def detect_vad(pcm_bytes: bytes) -> bool:
    """Returns True if speech detected in this chunk."""
    audio = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    tensor = torch.from_numpy(audio)
    prob = model(tensor, SAMPLE_RATE).item()
    return prob > VAD_THRESHOLD

def resample_to_16k(pcm_48k: bytes) -> bytes:
    """Downsample 48kHz s16le mono to 16kHz (simple 3:1 decimation)."""
    arr = np.frombuffer(pcm_48k, dtype=np.int16)
    arr_16k = arr[::3]  # every 3rd sample
    return arr_16k.tobytes()

async def main():
    app = Client("voice_caller", api_id=API_ID, api_hash=API_HASH, workdir="data")
    calls = PyTgCalls(app)

    play_task: asyncio.Task | None = None
    current_file: str | None = None
    paused = False
    call_ended = asyncio.Event()
    speaking = False
    seq_num = 0
    play_done_event: asyncio.Event | None = None

    # ------- Connect to Bun WebSocket -------
    async with websockets.connect(WS_URL) as ws:

        async def recv_commands():
            """Receive PLAY/PAUSE/RESUME/STOP from Bun."""
            nonlocal current_file, paused, play_task, play_done_event

            async for raw in ws:
                if isinstance(raw, bytes):
                    continue  # ignore binary from Bun (shouldn't happen)
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue

                cmd = msg.get("type")
                if cmd == "PLAY":
                    file_path = msg.get("file", "")
                    current_file = file_path
                    if play_task and not play_task.done():
                        play_task.cancel()
                    play_done_event = asyncio.Event()
                    await calls.play(USER_ID, MediaStream(file_path, video_flags=MediaStream.Flags.IGNORE))

                    async def wait_done():
                        await play_done_event.wait()
                        await ws.send(json.dumps({"type": "PLAY_DONE"}))

                    play_task = asyncio.create_task(wait_done())

                elif cmd == "PAUSE":
                    paused = True
                    try:
                        await calls.pause(USER_ID)
                    except Exception:
                        pass

                elif cmd == "RESUME":
                    paused = False
                    try:
                        await calls.resume(USER_ID)
                    except Exception:
                        pass

                elif cmd == "STOP":
                    # STOP cancels current audio playback — does NOT end the call.
                    # Bun sends STOP before every PLAY to interrupt in-progress audio.
                    if play_task and not play_task.done():
                        play_task.cancel()
                    try:
                        # pytgcalls >=3.0: skip_stream cancels current audio without hanging up
                        await calls.skip_stream(USER_ID)
                    except Exception:
                        pass  # older pytgcalls may not have skip_stream; cancel of play_task is enough

        async def capture_audio():
            """Capture audio from pytgcalls and run VAD."""
            nonlocal speaking, seq_num

            audio_buffer = b""
            is_speaking = False

            # pytgcalls calls on_audio sequentially in its event loop — audio_buffer is safe without locking
            async def on_audio(chunk: bytes):
                nonlocal audio_buffer, is_speaking, speaking, seq_num

                if paused:
                    return

                audio_buffer += chunk
                while len(audio_buffer) >= CHUNK_BYTES:
                    frame = audio_buffer[:CHUNK_BYTES]
                    audio_buffer = audio_buffer[CHUNK_BYTES:]

                    detected = detect_vad(frame)

                    if detected and not is_speaking:
                        is_speaking = True
                        speaking = True
                        await ws.send(json.dumps({"type": "VAD_START"}))
                        seq_num = 0

                    if is_speaking:
                        # Send binary: 2-byte seq_num + PCM
                        header = struct.pack(">H", seq_num % 65536)
                        if LANGUAGE == "en":
                            frame_to_send = resample_to_16k(frame)
                        else:
                            frame_to_send = frame
                        await ws.send(header + frame_to_send)
                        seq_num += 1

                    if not detected and is_speaking:
                        is_speaking = False
                        speaking = False
                        await ws.send(json.dumps({"type": "VAD_END"}))

            calls.on_stream_audio(USER_ID)(on_audio)

        # ------- Start call -------
        await app.start()
        await calls.start()

        @calls.on_update()
        async def on_update(update):
            name = type(update).__name__
            if "Closed" in name or "HungUp" in name:
                call_ended.set()
            if ("StreamEnded" in name or "StreamAudioEnded" in name) and play_done_event is not None:
                play_done_event.set()

        # Connect to user (muted — no audio yet)
        try:
            await calls.play(
                USER_ID,
                MediaStream(None, video_flags=MediaStream.Flags.IGNORE,  # muted
                            audio_parameters=AudioQuality.HIGH),
            )
        except Exception as e:
            # play() with None is expected to raise on some pytgcalls versions — call still proceeds
            print(f"Note: muted play raised {type(e).__name__}: {e}", file=sys.stderr, flush=True)

        await ws.send(json.dumps({"type": "CALL_CONNECTED"}))

        await asyncio.gather(
            recv_commands(),
            capture_audio(),
            call_ended.wait(),
        )

        await ws.send(json.dumps({"type": "CALL_ENDED"}))

    try:
        await calls.leave_call(USER_ID)
    except Exception:
        pass
    await app.stop()

asyncio.run(main())
