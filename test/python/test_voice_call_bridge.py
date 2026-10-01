"""Run the voice-call bridge's main() against a synthetic call; never load Telegram, VAD models or credentials."""

import ast
import asyncio
import contextlib
import io
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from service_session import start_service_session

SERVICE_ID = 5000000001
CALLEE_ID = 5000000002


class Direction:
    INCOMING = "incoming"
    OUTGOING = "outgoing"


class StreamFrames:
    def __init__(self, frames):
        self.direction = Direction.INCOMING
        self.frames = [SimpleNamespace(frame=f) for f in frames]


class ChatUpdate:
    class Status:
        LEFT_CALL = 1


class CallHungUp:
    pass


class Client:
    def __init__(self, *args, **kwargs):
        pass

    async def connect(self):
        return True

    async def get_me(self):
        return SimpleNamespace(id=SERVICE_ID, username="synthetic_service")

    async def initialize(self):
        pass

    async def disconnect(self):
        pass

    async def stop(self):
        pass


class Bun:
    """The Bun side of the session WebSocket: records what the bridge sends."""

    def __init__(self):
        self.sent = []
        self.closed = asyncio.Event()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def send(self, message):
        self.sent.append(message)

    async def _commands(self):
        await self.closed.wait()
        return
        yield

    def __aiter__(self):
        return self._commands()


def make_calls(caller_frames):
    class Calls:
        """Places the call; once recording starts, the caller speaks, then hangs up."""

        def __init__(self, client):
            self.handler = None

        async def start(self):
            pass

        def on_update(self):
            def register(handler):
                self.handler = handler
                return handler

            return register

        async def play(self, user_id, stream):
            pass

        async def record(self, user_id, stream):
            await self.handler(None, StreamFrames(caller_frames))
            await self.handler(None, CallHungUp())

        async def leave_call(self, user_id):
            pass

    return Calls


class VoiceCallBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def run_call(self, language, caller_frames):
        source = (ROOT / "scripts" / "voice-call-bridge.py").read_text()
        tree = ast.parse(source, filename="voice-call-bridge.py")
        entry = next(
            n
            for n in tree.body
            if isinstance(n, ast.AsyncFunctionDef) and n.name == "main"
        )
        bun = Bun()
        namespace = dict(
            Client=Client,
            PyTgCalls=make_calls(caller_frames),
            StreamFrames=StreamFrames,
            Direction=Direction,
            ChatUpdate=ChatUpdate,
            MediaStream=SimpleNamespace,
            RecordStream=lambda **kwargs: SimpleNamespace(**kwargs),
            AudioParameters=lambda *args: args,
            websockets=SimpleNamespace(connect=lambda url: bun),
            start_service_session=start_service_session,
            detect_vad=lambda frame: True,
            resample_to_16k=lambda pcm: pcm[::3],
            asyncio=asyncio,
            json=json,
            struct=struct,
            sys=sys,
            API_ID=123,
            API_HASH="synthetic",
            USER_ID=CALLEE_ID,
            LANGUAGE=language,
            WS_URL="ws://synthetic/call/session",
            SAMPLE_RATE=48000,
            CHUNK_BYTES=4,
        )
        exec(
            compile(
                ast.Module(body=[entry], type_ignores=[]), "voice-call-bridge.py", "exec"
            ),
            namespace,
        )
        with (
            patch.dict(os.environ, {"MTPROTO_SERVICE_USER_ID": str(SERVICE_ID)}),
            patch.dict(
                sys.modules,
                {"mtproto_lock": SimpleNamespace(session_lock=contextlib.nullcontext)},
            ),
            contextlib.redirect_stderr(io.StringIO()),
        ):
            await namespace["main"]()
        return bun

    async def test_caller_audio_reaches_bun_and_is_never_written_to_disk(self):
        for language in ["en", "ru"]:
            with self.subTest(language=language), tempfile.TemporaryDirectory() as cwd:
                (Path(cwd) / "data").mkdir()
                previous = os.getcwd()
                os.chdir(cwd)
                try:
                    bun = await self.run_call(language, [b"\x01\x02\x03\x04"] * 3)
                finally:
                    os.chdir(previous)
                self.assertTrue(any(isinstance(m, bytes) for m in bun.sent))
                self.assertIn(json.dumps({"type": "CALL_ENDED"}), bun.sent)
                self.assertEqual(
                    [p.relative_to(cwd).as_posix() for p in Path(cwd).rglob("*")],
                    ["data"],
                )


if __name__ == "__main__":
    unittest.main()
