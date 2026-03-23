"""
Auth script for Pyrogram (voice call bridge).
Run: cd hypercalendarbot && venv/bin/python scripts/pyrogram-auth.py [phone]
"""
import asyncio
import os
import sys
from pyrogram import Client

API_ID = int(os.environ.get("MTPROTO_API_ID", 31496323))
API_HASH = os.environ.get("MTPROTO_API_HASH", "e345f63982415e960843085806219f2f")

async def main():
    phone = sys.argv[1] if len(sys.argv) > 1 else None
    app = Client(
        name="voice_caller",
        api_id=API_ID,
        api_hash=API_HASH,
        workdir="data",
        phone_number=phone,
        device_model="iPhone 16 Pro",
        system_version="18.3.2",
        app_version="11.4",
        lang_code="en",
        system_lang_code="en-US",
    )
    await app.start()
    me = await app.get_me()
    print(f"Success! Logged in as {me.first_name} (@{me.username}), ID: {me.id}")
    print("Session saved to data/voice_caller.session")
    await app.stop()

asyncio.run(main())
