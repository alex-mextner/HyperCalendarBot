# Sub-Project #9: Bidirectional Voice Calls

## Status: Design Spec

---

## 1. Overview

Extends the existing one-way voice call system (sub-project #7) with full bidirectional audio:
the bot listens to the user during a live Telegram call, transcribes speech in real time,
detects interruptions, and responds with synthesized audio. The user can speak to the bot
as naturally as in a phone conversation.

**Scope:** P2P Telegram voice calls via pytgcalls (the existing Python bridge).
WebRTC Mini App calls are out of scope for this sub-project.

---

## 2. Architecture

### 2.1 Overview

```
┌──────────────────────────────────────────────────────────────┐
│                     Bun (main process)                        │
│                                                               │
│  Bun.serve WebSocket server (:3001, internal only)           │
│  CallSessionManager  (Map<sessionId, CallSession>)           │
│   ├── [RU] Nova-3 streaming STT  → Haiku classifier          │
│   ├── [EN] Flux streaming STT    → built-in EOT              │
│   ├── CalendarBotAgent (full agent, live_call inputMode)     │
│   ├── ThinkingPhrasePlayer (pre-recorded audio files)        │
│   └── TtsService (synthesizes bot responses)                 │
└───────────────────────┬──────────────────────────────────────┘
                        │ ws://localhost:3001/call/<sessionId>
           ┌────────────┴────────────┐
           ▼                         ▼
     Python bridge 1           Python bridge N
     ├── pytgcalls              ├── pytgcalls
     ├── Silero VAD [RU]        ├── Silero VAD [RU]
     └── WebSocket client       └── WebSocket client
```

Each Telegram call spawns one Python process. The process connects to the Bun WebSocket server
using its `sessionId` in the URL. Bun routes all messages by WebSocket connection — no PID
lookups, no stdio multiplexing. Multiple concurrent calls are handled naturally by Bun's
single event loop.

### 2.2 Components

| Component | Where | Role |
|-----------|-------|------|
| `CallSessionManager` | Bun | Creates/destroys sessions, routes WS messages |
| `CallSession` | Bun | Per-call state machine, owns STT + classifier + agent |
| `NovaStreamingSTT` | Bun | Nova-3 WebSocket client for Russian |
| `FluxStreamingSTT` | Bun | Flux WebSocket client for English |
| `InterruptionClassifier` | Bun | Haiku call for RU: noise / resume / respond |
| `ThinkingPhrasePlayer` | Bun | Schedules and commands playback of pre-recorded fillers |
| `voice-call-bridge.py` | Python | pytgcalls call setup, Silero VAD, audio capture/playback |

---

## 3. WebSocket Protocol

Port 3001 is internal (localhost only). Each Python bridge connects to
`ws://localhost:3001/call/<sessionId>`.

### 3.1 Python → Bun (text frames)

```json
{ "type": "CALL_CONNECTED" }
{ "type": "VAD_START" }
{ "type": "VAD_END" }
{ "type": "PLAY_DONE" }
{ "type": "CALL_ENDED" }
```

`PLAY_DONE` is sent immediately after pytgcalls finishes playing the current audio file.
Bun uses this solely to delete the temp file — it is NOT a prerequisite gate before
sending the next `PLAY`. Bun may send a new `PLAY` (or `STOP + PLAY`) at any time;
the Python bridge always cancels in-progress playback and starts the new file immediately.
`PLAY_DONE` may arrive after a subsequent `PLAY` has already started — that is expected.

### 3.2 Python → Bun (binary frames)

Audio data during active speech (after `VAD_START`, before `VAD_END`):

```
[2 bytes: uint16 sequence number] [raw PCM s16le 48kHz mono]
```

Frame size: ~1920 bytes (20ms of audio). Sequence number allows Bun to detect dropped frames.

### 3.3 Bun → Python (text frames)

```json
{ "type": "PLAY",   "file": "/tmp/call-<sessionId>-response.ogg" }
{ "type": "PAUSE"  }
{ "type": "RESUME" }
{ "type": "STOP"   }
```

---

## 4. Call Flow

### 4.1 Session Lifecycle

```
BullMQ job fires
  → Bun: create CallSession, synthesize TTS opener → /tmp/opener-<id>.ogg
  → Bun: spawn Python bridge with sessionId
  → Python: connects WS, initiates P2P call via pytgcalls
  → Python → Bun: CALL_CONNECTED
  → Bun → Python: PLAY /tmp/opener-<id>.ogg
  → [conversation loop]
  → Python → Bun: CALL_ENDED  (or timeout)
  → Bun: cleanup session, delete temp files
```

### 4.2 Interruption Flow — Russian (Nova-3 + Silero + Haiku)

```
Bot is playing audio
  │
  ├─ Python: Silero VAD detects speech onset
  ├─ Python → Bun: VAD_START
  ├─ Bun → Python: PAUSE
  │
  ├─ Python: streams PCM binary frames to Bun
  ├─ Bun: forwards audio frames to Nova-3 streaming WebSocket
  ├─ Nova-3: returns interim transcripts (~300ms to first result)
  │
  ├─ Bun: after each interim result → Haiku classifier
  │   Input:  rolling transcript + what bot was saying
  │   Output: "noise" | "resume" | "respond"
  │
  ├─ "noise" or "resume":
  │    Bun → Python: RESUME
  │    Bun: closes Nova-3 WS, discards buffer
  │
  └─ "respond":
       ├─ Bun: waits for VAD_END (Silero detects silence)
       ├─ Nova-3: final transcript on stream close
       ├─ Bun → Python: PLAY thinking_phrase (immediately)
       ├─ Bun: CalendarBotAgent processes transcript
       ├─ TTS synthesizes response → temp file
       └─ Bun → Python: PLAY response file
```

### 4.3 Interruption Flow — English (Flux, built-in EOT)

Two concurrent event sources: Silero VAD in Python (fast local detection) and Flux STT
in Bun (authoritative turn detection). They are not the same event.

```
Bot is playing audio
  │
  ├─ Python: Silero VAD detects speech onset
  ├─ Python → Bun: VAD_START           ← PAUSE trigger (same as Russian)
  ├─ Bun → Python: PAUSE
  │
  ├─ Flux WS: StartOfTurn event        ← confirmation, not the PAUSE trigger
  ├─ Flux: streams interim transcripts in real time
  │
  └─ Flux WS: EndOfTurn event          ← respond trigger
       ├─ Bun → Python: STOP + PLAY thinking_phrase (immediately)
       ├─ Bun: CalendarBotAgent processes final transcript
       ├─ TTS synthesizes response → temp file
       └─ Bun → Python: STOP + PLAY response file
```

`eot_threshold=0.7` in the SDK params tells Deepgram's server to emit `EndOfTurn` only
when it has ≥ 70% confidence in end-of-turn. The `end_of_turn_confidence` field on the
event payload reflects the actual confidence for logging — no runtime threshold check in
Bun code is needed since the server already filtered.

Flux handles noise filtering and false-start rejection internally — no Haiku classifier needed.

---

## 5. STT Configuration

### 5.1 Nova-3 (Russian)

```
Endpoint: wss://api.deepgram.com/v1/listen
Params:   model=nova-3&language=ru&punctuate=true&smart_format=true
          &encoding=linear16&sample_rate=48000&channels=1
          &interim_results=true
Auth:     Token <DEEPGRAM_API_KEY>
```

`smart_format=true` converts spoken numbers/times to digits ("три часа" → "03:00") which
is useful for calendar event processing.

One Nova-3 WebSocket is opened per interruption episode (opened on VAD_START, closed on
VAD_END or resume decision). Not one persistent connection per call.

### 5.2 Flux (English)

Deepgram launched Flux in October 2025 as a conversational STT model with built-in
end-of-turn detection. Verified available: [Introducing Flux](https://deepgram.com/learn/introducing-flux-conversational-speech-recognition).

```
SDK:      deepgram-python-sdk, client.listen.v2.connect()
Params:   model=flux-general-en
          eot_threshold=0.7, eot_timeout_ms=5000
          encoding=linear16, sample_rate=16000, channels=1
Auth:     DEEPGRAM_API_KEY
Events:   StartOfTurn, EndOfTurn (with end_of_turn_confidence)
```

Note: Flux requires 16kHz input (not 48kHz like Nova-3). The Python bridge resamples
pytgcalls output (48kHz) to 16kHz before sending to Flux. For Nova-3, 48kHz is sent as-is.

One Flux WebSocket is opened for the entire call duration. Flux manages turn boundaries
internally via StartOfTurn / EndOfTurn events — the bridge does not need to detect
speech start/end for the Flux stream.

---

## 6. Interruption Classifier (Russian only)

Haiku call triggered by Nova-3 interim results. To avoid a cascade of parallel Haiku
calls (Nova-3 fires every ~300ms), the classifier is debounced:

- A new Haiku call is only started if the previous one has completed AND the transcript
  has grown by at least 3 words since the last call.
- Maximum one in-flight Haiku call at a time per session.

Input: growing transcript + short description of what the bot was saying.

**Decision rules:**

| Signal | Decision |
|--------|----------|
| Empty or single filler word ("угу", "да", "ок", "ага") | `resume` |
| Background speech not addressed to bot | `resume` |
| Transcript contains a question or command | `respond` |
| Haiku call times out (>3s) | `respond` (fail-open) |
| 10s of continuous audio with no `respond` decision | `respond` (fail-open) |

**Fail-open rationale:** better to accidentally stop playback and let the user clarify
than to ignore a real request.

---

## 7. Thinking Phrases

### 7.1 Audio Files

Pre-recorded files in `data/thinking-phrases/{ru,en}/`. Generated once at deploy time,
committed to `.gitignore`.

```
data/thinking-phrases/
├── ru/
│   ├── start_hmm.ogg
│   ├── start_sec.ogg          "Секундочку."
│   ├── start_look.ogg         "Сейчас посмотрю."
│   ├── start_think.ogg        "Дай подумаю."
│   ├── mid_checking.ogg       "Проверяю..."
│   ├── mid_moment.ogg         "Момент."
│   ├── mid_almost.ogg         "Почти готово."
│   └── mid_looking.ogg        "Смотрю в календарь."
└── en/
    ├── start_hmm.ogg
    ├── start_sec.ogg          "One second."
    ├── start_look.ogg         "Let me check."
    ├── start_think.ogg        "Let me think."
    ├── mid_checking.ogg       "Checking..."
    ├── mid_moment.ogg         "Just a moment."
    ├── mid_almost.ogg         "Almost there."
    └── mid_looking.ogg        "Looking at your calendar."
```

### 7.2 Playback Schedule

```
t = 0s          → STOP (if anything playing) + PLAY random start_* phrase
t = 3–5s        → STOP + PLAY random mid_* phrase  (if agent still processing)
t = 7–10s       → STOP + PLAY random mid_* phrase  (if agent still processing)
agent responds  → cancel pending mid phrases, STOP + PLAY response file
```

Each `PLAY` is preceded by an implicit `STOP` to interrupt any currently playing phrase.
Delays are randomized within the range to avoid mechanical repetition across calls.

### 7.3 Generator Script

`scripts/generate-thinking-phrases.ts` — uses `TtsService` (Google TTS) to synthesize
each phrase and save to `data/thinking-phrases/`. Idempotent — skips existing files.
Added to deploy checklist as a one-time step.

---

## 8. inputMode Field

### 8.1 Types Change

`src/services/ai/types.ts`:

```typescript
// Remove:
isVoiceMessage?: boolean;

// Add:
inputMode?: 'text' | 'voice_message' | 'live_call';
```

All existing references to `isVoiceMessage` are updated to use `inputMode === 'voice_message'`.
Update sites: `types.ts:74`, `system-prompt.ts:100`, `src/bot/handlers/message.handler.ts` (voice message handler).

### 8.2 System Prompt Block

`src/services/ai/system-prompt.ts` — three-way switch replacing the existing boolean check:

**`voice_message`** — existing text (transcription errors, don't ask to repeat):
```
## Voice Message
This message was transcribed from a voice message using speech recognition.
The transcription may contain errors — words can be replaced with similar-sounding ones.
Use conversation context and common sense to infer what the user meant.
Do NOT ask to repeat unless the message is completely unintelligible.
```

**`live_call`** — new block:
```
## Live Phone Call
This is a live voice call via Telegram.
Speech recognition may produce artifacts: homophones, merged words, background noise.
When something seems off, make your best guess and ask for confirmation rather than
asking to repeat.
Ask multiple questions in a single response to minimize round-trips — the user is on
a call and each exchange takes time.
Keep responses short and spoken-word friendly: no bullet points, no markdown, no lists.
```

---

## 9. Agent Behavior in live_call Mode

Two behavioral changes driven by the system prompt (no code changes to the agent):

**Multiple questions per turn:** instead of sequential single questions, the agent asks
all needed information in one response. The system prompt instructs this explicitly.

**Short spoken responses:** no markdown formatting, no enumerations. The agent produces
text that TTS can read naturally.

No changes to agent tools or tool routing — the full CalendarBotAgent with all tools is
available in live_call mode.

---

## 10. Environment

```
DEEPGRAM_API_KEY=   # Nova-3 and Flux (same key)
```

---

## 11. Python Bridge Changes

`scripts/voice-call-bridge.py` is extended to:

1. Accept `sessionId` and `language` (`ru` | `en`) as CLI arguments
2. Connect to `ws://localhost:3001/call/<sessionId>` on startup
3. Initiate the P2P call immediately after WS connection is established; enter the call
   in a muted/waiting state (no audio played yet). Send `CALL_CONNECTED` and await the
   first `PLAY` command from Bun before playing anything. This avoids a race between
   TTS synthesis completing in Bun and the user answering.
4. Audio capture and VAD:
   - **Russian:** Run Silero VAD on incoming pytgcalls audio (48kHz s16le). Send
     `VAD_START`, binary PCM frames (48kHz), `VAD_END` to Bun. Bun opens/closes the
     Nova-3 WebSocket in response.
   - **English:** Stream all incoming audio (resampled to 16kHz) to the persistent Flux
     WebSocket that Bun manages. The Python bridge sends `VAD_START` / `VAD_END` based on
     Silero VAD (for Bun to send `PAUSE`/`RESUME` to the bridge), but the `respond`
     decision comes from Flux's `EndOfTurn` event on the Bun side — not from a
     classifier. `PAUSE` is sent to the bridge immediately on `VAD_START` regardless of
     language.
5. Handle `PLAY` / `PAUSE` / `RESUME` / `STOP` commands from Bun. `PLAY` implicitly
   stops any audio currently playing before starting the new file. Send `PLAY_DONE`
   when the file finishes.

Audio output format for TTS files: OGG Opus 48kHz mono (pytgcalls native format).
The `TtsService` must produce OGG Opus output, not MP3 or OGG Vorbis.

Audio capture uses pytgcalls `AudioReceiver`. PCM format: s16le 48kHz mono (native
pytgcalls format, matches Deepgram input requirements).

---

## 12. Temp File Management

Bot response audio files are written to `/tmp/call-<sessionId>-<seq>.ogg` and deleted
after the Python bridge sends `PLAY_DONE`. TTS opener files follow the same pattern.

Session max duration: **30 minutes**. If `CALL_ENDED` is not received within 30 minutes
of `CALL_CONNECTED`, Bun tears down the session, sends `STOP` to the Python bridge, and
cleans up all temp files. 30 minutes is generous for a voice reminder conversation;
it handles edge cases where the Python process crashes without sending `CALL_ENDED`.

Session cleanup (on `CALL_ENDED`, timeout, or error) glob-deletes all
`/tmp/call-<sessionId>-*.ogg` files.

---

## 13. Error Handling

| Scenario | Handling |
|----------|----------|
| Nova-3 WS connect fails | Log error, resume playback, skip STT for this episode |
| Haiku classifier timeout (>3s) | Default to `respond` (fail-open) |
| Flux WS drops mid-call | Reconnect once; on second failure fall back to Nova-3 |
| Python bridge WS disconnect | Session marked failed, call log updated |
| Agent timeout (>30s) | Play "извини, не успел обработать, попробуй ещё раз" |
| TTS synthesis fails | Play pre-recorded error phrase from `data/thinking-phrases/` |

---

## 14. Out of Scope

- WebRTC Mini App calls (covered by spec #7)
- Voice call initiation UI / user settings (covered by spec #7)
- STT for languages other than RU and EN
- Flux for Russian (not yet available; revisit when Deepgram releases `flux-general-ru`)
- Bidirectional audio recording or storage
