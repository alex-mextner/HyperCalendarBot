# Telegram Bot API Limits

Full reference. Critical limits are inline in CLAUDE.md, rest is here.

## Message Length
- `sendMessage` / `editMessageText`: **4 096 chars**
- Caption (photo, document, video, etc.): **1 024 chars** (4 096 for Premium)
- Quote in reply: **1 024 chars**
- `answerCallbackQuery` alert: **200 chars**

When text may exceed 4 096 chars, use `splitMessage()` from `src/utils/telegram.ts`.

## Rate Limits
- **~1 msg/sec per chat** — safe burst rate
- **~30 msg/sec globally** across all chats (official FAQ)
- **20 msg/min per group/channel**
- HTTP **429** with `retry_after` **blocks all API calls** — implement global backoff.

## Inline Keyboard
- Max **8 buttons per row**, **100 buttons total**
- Total `reply_markup` JSON: **10 KB**
- `callback_data` per button: **64 bytes** (UTF-8). Exceeding -> `400 BUTTON_DATA_INVALID`.
  - ask_user buttons (`src/services/ai/ask-user-buttons.ts`): the answer rides in `ai_btn:<text>` while that fits in 64 bytes; a longer option is sent as `ai_opt:<index>` and the tap handler reads the answer from the tapped button's label in the message's own keyboard. A 2026-10-31 incident (`BUTTON_DATA_INVALID` for a 45-character Russian option) was the byte-vs-character trap. `handleAskUser` rejects only an empty question or option and more than 100 buttons (the working limit above, which carries no source link); it enforces no label-length or keyboard-size limit, because none is documented. Whether Telegram carries a very long button label whole is unverified (#914). A tap is acknowledged by editing `question + "\n\n✅ " + answer` into the message; past the 4096-character message limit that edit fails, so the tap handler falls back to the answer alone, shortens an answer over 4000 characters, writes it on one line (the "already answered" test looks for a final `✅ ...` line), and also remembers the answered message in process memory, so a failed edit cannot let a second tap reach the AI.

## Commands
- Command name: **1-32 chars** (lowercase a-z, 0-9, `_`)
- Command description: **256 chars**
- Max commands: **100**
- `/start` deep-link payload: **64 bytes**

## File Size
- Upload: **50 MB**
- Download via `getFile`: **20 MB**
- Video note (circle): **12 MB**, max **1 min**, **384px**
- Album (`sendMediaGroup`): **2-10 items**
- File name: **60 chars**

## Inline Queries
- Query text: **256 chars**
- Results per response: **50**

## Formatting
- Max **100 entities per message**
- `parse_mode` and explicit `entities` are mutually exclusive.

## Message Editing
- Editable for **48 hours** after sending (channels: no limit).
- Can't edit messages sent by other bots or users.

## Miscellaneous
- Scheduled messages per chat: **100**
- Scheduled up to: **365 days** ahead
- Poll question: **1-255 chars**; answer option: **1-100 chars**; options: **2-12**
