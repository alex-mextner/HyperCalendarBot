"""Non-interactive startup for an explicitly designated service account."""

import os
import sys


async def start_service_session(client, expected_id=None):
    try:
        expected = (
            expected_id
            if expected_id is not None
            else int(os.environ.get("MTPROTO_SERVICE_USER_ID", "0"))
        )
    except (ValueError, TypeError) as exc:
        raise ValueError("SERVICE_IDENTITY_UNCONFIGURED") from exc
    if type(expected) is not int or expected <= 0:
        raise ValueError("SERVICE_IDENTITY_UNCONFIGURED")
    try:
        authorized = await client.connect()
        if not authorized:
            raise ValueError("SERVICE_SESSION_UNAUTHORIZED")
        me = await client.get_me()
        if me.id != expected:
            raise ValueError("SERVICE_IDENTITY_MISMATCH")
        client.me = me
        await client.initialize()
    except BaseException:
        try:
            await client.disconnect()
        except Exception as cleanup_error:
            print(
                f"Service session cleanup: {type(cleanup_error).__name__}",
                file=sys.stderr,
            )
        raise
    return client
