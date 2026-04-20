"""
File-level lock for voice_caller.session access.

All MTProto scripts (resolve-username, send-message, fetch-birthdays, voice-call-bridge)
MUST acquire this lock before calling app.start(). Without it, concurrent Pyrogram processes
can corrupt the session SQLite file — if any field (user_id, is_bot) reads as NULL during a
race, Pyrogram overwrites the auth_key with a new one, permanently destroying the session.

Usage:
    from mtproto_lock import session_lock

    async def main():
        with session_lock():
            app = Client("voice_caller", ...)
            await app.start()
            try:
                ...
            finally:
                await app.stop()
"""
import fcntl
import os
from contextlib import contextmanager

LOCK_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "voice_caller.lock")


@contextmanager
def session_lock(timeout: float = 30):
    """Acquire an exclusive file lock around voice_caller.session access.

    Uses LOCK_EX (blocking). If another script holds the lock, this blocks
    until it's released or the process is killed.
    """
    fd = os.open(LOCK_PATH, os.O_CREAT | os.O_RDWR)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
