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
CHUNK_MS = 32  # 32ms → exactly 512 samples at 16kHz after 3:1 decimation (silero requires exactly 512)
CHUNK_SAMPLES = SAMPLE_RATE * CHUNK_MS // 1000  # 1536 samples per chunk
CHUNK_BYTES = CHUNK_SAMPLES * 2  # s16le mono = 2 bytes per sample
VAD_THRESHOLD = 0.5

import torch
import numpy as np
from silero_vad import load_silero_vad

from pyrogram import Client
from pytgcalls import PyTgCalls
from pytgcalls.types import MediaStream, AudioQuality, RecordStream, StreamFrames, Direction, ChatUpdate
from pytgcalls.types.raw.audio_stream import AudioParameters

import websockets

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
    app = Client("voice_caller", api_id=API_ID, api_hash=API_HASH, workdir="data")
    calls = PyTgCalls(app)

    play_task: asyncio.Task | None = None
    current_file: str | None = None
    paused = False
    call_ended = asyncio.Event()
    speaking = False
    seq_num = 0
    play_done_event: asyncio.Event | None = None
    audio_buffer = b""
    is_speaking = False
    bun_closed_ws = False

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
                        # skip_stream stops outgoing audio immediately (barge-in).
                        # calls.pause() only "pauses" the track — the remote still
                        # hears buffered audio for several seconds. skip_stream cuts it.
                        await calls.skip_stream(USER_ID)
                    except Exception:
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

        frames_received = 0
        record_file = open('data/last-call-user.raw', 'wb')  # 48kHz s16le mono

        async def on_audio_frame(chunk: bytes):
            """Process incoming audio chunk from the call with VAD."""
            nonlocal audio_buffer, is_speaking, speaking, seq_num, frames_received

            record_file.write(chunk)

            frames_received += 1
            if frames_received == 1:
                print('[vad] first audio frame received', file=sys.stderr, flush=True)
            elif frames_received % 500 == 0:
                print(f'[vad] frames={frames_received} is_speaking={is_speaking}', file=sys.stderr, flush=True)

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
                    speaking = True
                    print('[vad] VAD_START', file=sys.stderr, flush=True)
                    await ws.send(json.dumps({"type": "VAD_START"}))
                    seq_num = 0

                if is_speaking:
                    header = struct.pack(">H", seq_num % 65536)
                    await ws.send(header + frame)
                    seq_num += 1

                if not detected and is_speaking:
                    is_speaking = False
                    speaking = False
                    await ws.send(json.dumps({"type": "VAD_END"}))

        # ------- Start call -------
        await app.start()
        await calls.start()

        @calls.on_update()
        async def on_update(_, update):
            name = type(update).__name__
            if name != 'StreamFrames':
                print(f'[pytgcalls] update: {name}', file=sys.stderr, flush=True)
            if "Closed" in name or "HungUp" in name:
                call_ended.set()
            elif isinstance(update, ChatUpdate) and update.status & ChatUpdate.Status.LEFT_CALL:
                call_ended.set()
            if ("StreamEnded" in name or "StreamAudioEnded" in name) and play_done_event is not None:
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
        await calls.record(USER_ID, RecordStream(audio=True, audio_parameters=AudioParameters(SAMPLE_RATE, 1)))

        ws_task = asyncio.create_task(recv_commands())
        call_done_task = asyncio.create_task(call_ended.wait())
        done, _ = await asyncio.wait([ws_task, call_done_task], return_when=asyncio.FIRST_COMPLETED)
        # True when Bun closed the WS (STT error / forced end), False when user hung up
        bun_closed_ws = ws_task in done and call_done_task not in done
        for t in [ws_task, call_done_task]:
            t.cancel()
        await asyncio.gather(ws_task, call_done_task, return_exceptions=True)
        record_file.close()
        print(f'[vad] recording saved: data/last-call-user.raw ({frames_received} frames)', file=sys.stderr, flush=True)

        # Send CALL_ENDED only if WS is still open (user hung up, not Bun-initiated close)
        try:
            await ws.send(json.dumps({"type": "CALL_ENDED"}))
        except Exception:
            pass

    try:
        await calls.leave_call(USER_ID)
    except Exception:
        pass
    try:
        await app.stop()
    except Exception:
        pass

    if bun_closed_ws:
        sys.exit(1)

asyncio.run(main())
