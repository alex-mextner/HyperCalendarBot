"""Deliver to the stable numeric ID; usernames only recover an unknown peer cache."""
class RecipientMismatch(ValueError):
    """Peer lookup disagrees with the invitation recipient."""

async def send_to_recipient(client, user_id: int, text: str, username: str | None = None):
    if type(user_id) is not int or user_id == 0:
        raise RecipientMismatch('RECIPIENT_MISMATCH: a nonzero numeric Telegram ID is required')
    if username:
        try:
            resolved = await client.get_chat(user_id)
        except Exception as exc:
            if getattr(exc, 'ID', None) != 'PEER_ID_INVALID':
                raise
            resolved = await client.get_chat(username.strip().lstrip('@'))
        if resolved.id != user_id:
            raise RecipientMismatch('RECIPIENT_MISMATCH: username hint cannot change the numeric recipient')
    return await client.send_message(user_id, text)
