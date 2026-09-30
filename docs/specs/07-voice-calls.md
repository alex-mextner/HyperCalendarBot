# Sub-Project #7: Voice Call Reminders

## Status: Design Spec (Draft)

---

## 1. Overview

The bot calls users via Telegram voice calls to remind them of calendar events. A virtual user account (MTProto userbot) initiates the call, plays a TTS-synthesized reminder, optionally listens to the user's verbal response (STT via Whisper), and processes commands like "snooze" or "cancel" through an AI agent.

**Why calls, not just messages?** Messages get buried. A ringing phone is impossible to ignore. This is the nuclear option for reminders that actually matter.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Bot Process (GramIO)                     │
│                                                              │
│  Notification System ──► BullMQ "call-reminder" job          │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    Worker Process (BullMQ)                    │
│                                                              │
│  1. Check quiet hours & user settings                        │
│  2. Pre-warm RunPod (if needed, based on rolling avg)        │
│  3. Synthesize reminder text → TTS → audio buffer            │
│  4. Initiate call via Virtual User (MTProto)                 │
│  5. Play audio when user answers                             │
│  6. [Optional] Record user response → STT → AI agent         │
│  7. Process command (snooze/cancel/acknowledge)               │
│  8. End call, log result                                     │
└──────────────────────────────┬───────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
┌──────────────────┐ ┌─────────────────┐ ┌──────────────┐
│  Virtual User     │ │  RunPod          │ │  Edge TTS     │
│  (@mtcute/bun)    │ │  (Whisper STT)   │ │  (Synthesis)  │
│                   │ │                  │ │               │
│  MTProto session  │ │  Serverless GPU  │ │  Free, fast   │
│  Voice call init  │ │  Pre-warming     │ │  RU/EN voices │
└──────────────────┘ └─────────────────┘ └──────────────┘
```

### Components

| Component | Technology | Role |
|-----------|-----------|------|
| Job queue | BullMQ + Redis | Schedule and dispatch call reminder jobs |
| Virtual user | @mtcute/bun (MTProto) | Initiate calls as a real Telegram user |
| TTS engine | Edge TTS (primary), OpenAI TTS (fallback) | Convert reminder text to speech audio |
| STT engine | Whisper on RunPod serverless | Transcribe user's verbal response |
| AI agent | LLM (same as bot's AI) | Interpret user response and execute action |
| Call manager | Custom module in worker | Orchestrate the entire call lifecycle |
| Audio transport | tgcalls C++ lib (if feasible) / WebRTC Mini App (fallback) | Actual audio streaming |

---

## 3. Critical Research: Voice Call Feasibility

### 3.1 Telegram Voice Call Protocol (How It Works)

Telegram voice calls use a two-layer architecture:

1. **Signaling layer (MTProto):** Call setup via `phone.requestCall` -> `phone.acceptCall` -> `phone.confirmCall` -> `phone.discardCall`. Includes Diffie-Hellman key exchange for E2E encryption.

2. **Transport layer:** Since Telegram 7.0+ (Aug 2020), uses a modified WebRTC for actual audio/video data. Two channels: MTProto API for signaling, WebRTC for media transport. Audio is encrypted with AES-CTR derived from the DH shared secret.

**Key insight:** The signaling is "just" MTProto API calls. The hard part is the audio transport layer -- it requires binding to Telegram's native `tgcalls` C++ library, which handles WebRTC negotiation, ICE, DTLS, and audio codec management.

### 3.2 @mtcute Voice Call Support

**Finding: @mtcute does NOT support voice calls.**

- The library has no mention of voice/call/VoIP support
- @mtcute is a MTProto client library focused on messages, media, chats -- not real-time communication
- The signaling part (`phone.requestCall` etc.) could theoretically be called via raw TL methods, but without the audio transport layer it is useless -- you would ring the phone but have no way to send audio

### 3.3 Available JavaScript/TypeScript Solutions

| Library | Private calls? | Language | Audio transport | Status |
|---------|---------------|----------|-----------------|--------|
| **tgcallsjs/tgcalls** | No (group calls only) | JS/Node | Custom, s16le raw audio | Mostly inactive, 37 commits |
| **MarshalX/tgcalls** | "Working but not released" | Python only | C++ binding via pybind11, PCM 16-bit 48kHz | Active, but Python-only |
| **pytgcalls** | Group calls | Python | C++ tgcalls binding | Active |
| **gram-tgcalls** | Group calls | JS (GramJS) | Via tgcallsjs | Inactive |

**Conclusion:** There is NO production-ready JavaScript/TypeScript library for **private native Telegram voice calls** (MTProto-based). The only library that claims private call support (MarshalX/tgcalls) is Python-only and the feature is unreleased. However, this does NOT mean voice calls in JS/TS are impossible — WebRTC-based calls via Mini App work perfectly fine. See Approach C below.

### 3.4 Approach Decision Matrix

#### Approach A: Native Telegram Call via tgcalls C++ binding

**How it would work:**

1. Use @mtcute for MTProto signaling (`phone.requestCall`, etc.)
2. Build a Node/Bun native addon wrapping Telegram's tgcalls C++ library
3. Feed TTS audio into the tgcalls stream, capture response audio for STT

**Pros:**

- Real Telegram call -- phone rings natively, works like any other call
- User answers normally, no extra steps
- Works even when user has no internet (Wi-Fi calling / cellular)
- Best UX by far

**Cons:**

- tgcalls C++ library has no JS bindings, would need to build from scratch
- Massive engineering effort (estimate: 2-4 weeks just for the binding)
- Fragile: tgcalls updates with every Telegram release, bindings break
- Bun native addon support is immature compared to Node.js
- Private call support is undocumented even in Python binding
- Risk of Telegram banning the userbot account for automated calls

**Verdict:** Too risky and too expensive for v1. Reserve for v2 if call feature proves valuable.

#### Approach B: Python sidecar for voice calls

**How it would work:**

1. Run a Python microservice alongside the Bun worker
2. Use MarshalX/tgcalls (Python) for the actual call
3. Communicate via Redis/BullMQ or HTTP between Bun worker and Python sidecar

**Pros:**

- Leverages the only library with (unreleased) private call support
- Keeps the hard C++ binding problem in Python where it is already solved
- Real Telegram call -- same UX as Approach A

**Cons:**

- Adds Python as a runtime dependency (goes against pure Bun/TS stack)
- MarshalX private calls are unreleased and undocumented
- Extra operational complexity (two runtimes)
- Still has the userbot ban risk

**Verdict:** Viable fallback if we need real calls. Evaluate once MarshalX/tgcalls releases private call support.

#### Approach C: WebRTC Mini App (Recommended for v1)

**How it would work:**

1. Bot sends a push notification / message: "Upcoming event: [title]. Tap to hear reminder."
2. Message includes an inline button that opens a Telegram Mini App (WebApp)
3. Mini App establishes WebRTC connection to our server
4. Server plays TTS audio via WebRTC
5. User can respond verbally (STT pipeline processes it)
6. AI agent handles the response

**Reference implementation exists and is proven in `voice-ai-agent-ios` project.** The WebRTC approach is NOT experimental — it's already working. Key files:

- `voice-ai-agent-ios/server/src/simple-webrtc.js` — WebSocket signaling + `@roamhq/wrtc` peer connections, working
- `voice-ai-agent-ios/server/src/webrtc-loader.js` — graceful wrtc module loading
- Audio processing pipeline with Whisper STT already integrated and tested

**Pros:**

- 100% JavaScript/TypeScript, runs in Bun
- No native C++ bindings needed
- No userbot ban risk (it is a regular bot feature)
- WebRTC is well-understood, `@roamhq/wrtc` works for server-side
- **Proven reference implementation** in `voice-ai-agent-ios` — not theoretical
- Can be enhanced to full-screen "call UI" in Mini App

**Cons:**

- Not a real phone call -- user must tap a button to start
- Requires internet (no cellular fallback)
- Slightly worse UX: notification + tap vs. phone just ringing
- User must have Telegram open / respond to notification
- Mini App WebRTC may have browser/platform quirks

**Verdict:** Proven approach with existing reference implementation. Ship this, gather data, upgrade to real calls later.

#### Approach D: Hybrid -- send voice message + call-to-action

**How it would work:**

1. Bot sends a voice message (TTS audio) as a Telegram voice note
2. Includes inline buttons: "Snooze 10 min", "Cancel event", "On my way"
3. If user needs to respond verbally, button opens Mini App with WebRTC

**Pros:**

- Simplest implementation -- no WebRTC needed for basic flow
- Voice message auto-plays on many devices
- Buttons handle 90% of use cases without voice response
- Mini App only needed for the 10% "verbal response" case

**Cons:**

- Not a call at all -- it is a voice message
- Easy to ignore (same problem as text messages)
- No real-time interaction

**Verdict:** Good as a simpler tier alongside Approach C. "Important" events get the Mini App call, regular events get voice messages.

### 3.5 Recommended Strategy

**v1: Approach D (voice message) + Approach C (Mini App call) as two tiers:**

- Regular reminder events -> voice message with action buttons
- "Important" / "critical" events -> push notification + Mini App WebRTC call
- User configures which events get which treatment

**v2 (future): Approach B (Python sidecar) when MarshalX/tgcalls releases private call support**

---

## 4. Detailed Call Flow

### 4.1 Voice Message Reminder (Tier 1 -- Regular Events)

```
Notification System              Worker                    Bot (GramIO)         User
       │                           │                          │                  │
       ├──call-reminder job───────►│                          │                  │
       │                           ├─check quiet hours────────┤                  │
       │                           ├─check user settings──────┤                  │
       │                           │                          │                  │
       │                           ├─synthesize TTS──────────►│                  │
       │                           │  (Edge TTS)              │                  │
       │                           │◄─audio buffer────────────┤                  │
       │                           │                          │                  │
       │                           ├─send voice message───────┤                  │
       │                           │  + inline buttons        ├─voice msg───────►│
       │                           │                          │  [Snooze 10m]    │
       │                           │                          │  [Cancel]        │
       │                           │                          │  [On my way]     │
       │                           │                          │                  │
       │                           │                          │◄─button tap──────┤
       │                           │◄─callback query──────────┤                  │
       │                           ├─execute action───────────┤                  │
       │                           │  (snooze/cancel/ack)     │                  │
```

### 4.2 WebRTC Mini App Call (Tier 2 -- Important Events)

```
Notification     Worker              Bot           Mini App Server    User
System                                              (Bun.serve)
  │                │                  │                  │              │
  ├─call job──────►│                  │                  │              │
  │                ├─pre-warm RunPod──┤                  │              │
  │                ├─synthesize TTS───┤                  │              │
  │                │                  │                  │              │
  │                ├─create call──────┤                  │              │
  │                │  session         ├─push msg────────►│              │
  │                │                  │  "Call from       │              │
  │                │                  │   Calendar"       ├─notification►│
  │                │                  │  [Answer Call]    │              │
  │                │                  │                  │              │
  │                │                  │                  │◄─tap button──┤
  │                │                  │                  │              │
  │                │                  │                  ├─WebRTC────────┤
  │                │                  │                  │  offer/answer │
  │                │                  │                  │  ICE exchange │
  │                │                  │                  │              │
  │                │                  │                  ├─play TTS─────►│
  │                │                  │                  │  audio        │
  │                │                  │                  │              │
  │                │                  │                  │◄─voice resp──┤
  │                │                  │                  │  (audio)      │
  │                │                  │                  │              │
  │                ├─STT (RunPod)─────┤                  │              │
  │                │  Whisper         │                  │              │
  │                │◄─transcription───┤                  │              │
  │                │                  │                  │              │
  │                ├─AI agent─────────┤                  │              │
  │                │  interpret       │                  │              │
  │                │  command         │                  │              │
  │                │                  │                  │              │
  │                ├─execute action───┤                  │              │
  │                │                  ├─confirm msg──────►              │
  │                │                  │                  ├─end call─────►│
```

### 4.3 Call Session Lifecycle States

```
CREATED ──► RINGING ──► CONNECTED ──► PLAYING_REMINDER
                │              │              │
                ▼              ▼              ▼
            NO_ANSWER    CALL_FAILED    LISTENING_RESPONSE
                │              │              │
                ▼              ▼              ▼
             RETRY(?)      FALLBACK      PROCESSING_STT
                              │              │
                              ▼              ▼
                         SEND_MESSAGE   EXECUTING_ACTION
                                            │
                                            ▼
                                         ENDED
```

---

## 5. TTS Pipeline

### 5.1 Engine Comparison

| Engine | Cost | Latency | Quality | Russian | Notes |
|--------|------|---------|---------|---------|-------|
| **Edge TTS** | Free | ~200-500ms | Good | Yes (multiple voices) | Microsoft Edge's online TTS. No API key needed. Best for v1 |
| **OpenAI TTS** | $15/1M chars (tts-1), $30/1M (tts-1-hd) | ~500-1000ms | Excellent | Yes | Higher quality but costs money |
| **Coqui/XTTS** | Free (self-hosted) | Variable | Good | Yes | Requires GPU, adds infrastructure complexity |

**Decision: Edge TTS as primary, OpenAI TTS as fallback for premium users.**

### 5.2 Edge TTS Integration

```typescript
// Using edge-tts-universal (works with Bun)
import { EdgeTTS } from 'edge-tts-universal';

interface TTSOptions {
  text: string;
  language: 'ru' | 'en';
  voice?: string; // override default voice
}

// Recommended voices
const VOICES = {
  ru: 'ru-RU-DmitryNeural',    // Male, natural sounding
  en: 'en-US-GuyNeural',       // Male, natural sounding
} as const;

async function synthesize(options: TTSOptions): Promise<Buffer> {
  const tts = new EdgeTTS();
  await tts.synthesize(options.text, {
    voice: options.voice ?? VOICES[options.language],
    rate: '+0%',     // normal speed
    pitch: '+0Hz',   // normal pitch
  });
  return tts.toBuffer(); // returns MP3/WAV buffer
}
```

### 5.3 Phrase Caching

Common phrases are pre-synthesized and cached to reduce latency:

```typescript
const CACHED_PHRASES = {
  'greeting_ru': 'Привет! У тебя скоро событие.',
  'greeting_en': 'Hi! You have an upcoming event.',
  'ask_action_ru': 'Что хочешь сделать? Отложить, отменить, или уже в пути?',
  'ask_action_en': 'What would you like to do? Snooze, cancel, or are you on your way?',
  'goodbye_ru': 'Хорошо, до связи!',
  'goodbye_en': 'Got it, talk to you later!',
  'no_response_ru': 'Я не услышал ответа. Отправлю напоминание в чат.',
  'no_response_en': 'I didn\'t catch that. I\'ll send a reminder in chat.',
};
```

Cache stored in Redis as `tts:cache:{phraseKey}:{voice}` -> Buffer (base64). TTL: 7 days.

### 5.4 Reminder Text Generation

The reminder text is assembled from event data:

```typescript
function buildReminderText(event: CalendarEvent, lang: 'ru' | 'en'): string {
  // Templates:
  // RU: "Привет! Через {timeUntil} у тебя {title}. {location?}. Что хочешь сделать?"
  // EN: "Hi! In {timeUntil} you have {title}. {location?}. What would you like to do?"
}
```

Full TTS audio is assembled as: `[greeting] + [event details] + [ask_action]`

---

## 6. STT Pipeline (Whisper on RunPod)

### 6.1 RunPod Serverless Setup

**GPU:** A4000 16GB (cheapest option sufficient for Whisper large-v3-turbo)

- Flex cost: $0.00016/sec = $0.576/hour
- Per inference (avg 3 seconds): ~$0.00048

**Endpoint config:**

```json
{
  "name": "whisper-large-v3-turbo",
  "gpu": "NVIDIA A4000",
  "minWorkers": 0,
  "maxWorkers": 3,
  "idleTimeout": 300,
  "template": "runpod/whisper:latest",
  "env": {
    "MODEL_NAME": "openai/whisper-large-v3-turbo"
  }
}
```

### 6.2 Pre-Warming Strategy with Rolling Average

The problem: RunPod Flex workers scale to zero. Cold start = delay. For time-sensitive call reminders, we need the worker ready when we need it.

**Strategy: Predictive pre-warming based on rolling average cold start time.**

```typescript
// Cold start tracking in SQLite
interface ColdStartRecord {
  id: number;
  timestamp: number;
  coldStartMs: number;       // actual cold start time observed
  wasPreWarmed: boolean;     // did we pre-warm for this request?
  inferenceMs: number;       // actual inference time
}

class RunPodPreWarmer {
  private rollingWindow = 50;  // last 50 cold starts

  // Returns the estimated cold start time in ms
  getEstimatedColdStart(): number {
    const records = db.query(`
      SELECT coldStartMs FROM cold_start_analytics
      WHERE wasPreWarmed = 0
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(this.rollingWindow);

    if (records.length === 0) return 15_000; // default 15s assumption

    // Rolling average with exponential decay (recent observations weighted more)
    let weightedSum = 0;
    let weightSum = 0;
    records.forEach((r, i) => {
      const weight = Math.exp(-i * 0.05); // decay factor
      weightedSum += r.coldStartMs * weight;
      weightSum += weight;
    });

    return Math.ceil(weightedSum / weightSum);
  }

  // Pre-warm: send a lightweight health-check request to wake the worker
  async preWarm(): Promise<void> {
    const startTime = Date.now();
    await fetch(`${RUNPOD_ENDPOINT}/health`, { method: 'GET' });
    const elapsed = Date.now() - startTime;

    // If it took >2s, it was likely a cold start
    if (elapsed > 2000) {
      this.recordColdStart(elapsed, false);
    }
  }

  // Called before a call is initiated
  async ensureWarm(): Promise<void> {
    const estimatedColdStart = this.getEstimatedColdStart();

    // If estimated cold start > 5s, pre-warm proactively
    if (estimatedColdStart > 5000) {
      await this.preWarm();
    }
  }
}
```

**Pre-warming timeline:**

1. Call reminder job enters BullMQ
2. Worker immediately fires `ensureWarm()` -- this is the FIRST thing it does, before TTS
3. TTS synthesis happens in parallel (takes 200-500ms)
4. By the time TTS is done, RunPod should be warm
5. After user responds verbally, STT request goes to (now warm) RunPod

**Extra optimization:** Schedule pre-warm based on upcoming events. If a call reminder is scheduled for 14:00, fire a pre-warm request at 13:59:30 (30 seconds before, adjustable based on rolling average).

### 6.3 Fallback: HuggingFace Inference API

If RunPod is down or cold start exceeds timeout:

```typescript
async function whisperFallback(audioBuffer: Buffer): Promise<string> {
  const response = await fetch(
    'https://api-inference.huggingface.co/models/openai/whisper-large-v3-turbo',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HF_API_KEY}`,
        'Content-Type': 'audio/wav',
      },
      body: audioBuffer,
    }
  );
  const result = await response.json();
  return result.text;
}
```

HuggingFace rate limits: ~300 req/min on free tier, ~1000 req/min on Pro ($9/mo).

### 6.4 Analytics

Track in SQLite for operational visibility:

```typescript
interface STTAnalytics {
  id: number;
  timestamp: number;
  provider: 'runpod' | 'huggingface';
  coldStartMs: number | null;
  inferenceMs: number;
  audioLengthMs: number;
  transcriptionLength: number;
  language: string;
  success: boolean;
  error: string | null;
}
```

---

## 7. WebRTC Mini App Implementation (Approach C)

### 7.1 Server Side (Bun.serve)

Based on patterns from `voice-ai-agent-ios/server/src/simple-webrtc.js`:

```typescript
// Worker creates a call session, stores in Redis
interface CallSession {
  id: string;
  userId: number;          // telegram_id
  eventId: number;
  ttsAudio: Buffer;        // pre-synthesized reminder
  state: CallState;
  createdAt: string;       // ISO 8601 UTC
  expiresAt: string;       // session valid for 5 minutes
}

// WebSocket server for WebRTC signaling
// Endpoint: wss://bot-domain/call-ws
//
// Flow:
// 1. Mini App connects via WebSocket with session ID
// 2. Server validates session
// 3. WebRTC offer/answer exchange
// 4. ICE candidate exchange
// 5. Once connected: server plays TTS audio via WebRTC audio track
// 6. Server receives user audio via WebRTC audio track
// 7. Audio chunks sent to Whisper for STT
// 8. AI agent processes transcription
// 9. Server plays response TTS
// 10. Call ends
```

### 7.2 Mini App (Frontend)

A lightweight Telegram Web App that acts as a "call screen":

```
┌─────────────────────────────┐
│     HyperCalendar Call      │
│                             │
│    ┌─────────────────┐      │
│    │                 │      │
│    │   Meeting       │      │
│    │   in 15 min     │      │
│    │                 │      │
│    └─────────────────┘      │
│                             │
│    Playing reminder...      │
│                             │
│    ┌─────┐  ┌─────────┐    │
│    │Mute │  │ End Call │    │
│    └─────┘  └─────────┘    │
│                             │
│    ┌──────────────────┐     │
│    │ Snooze 10 min    │     │
│    │ Cancel event     │     │
│    │ On my way        │     │
│    └──────────────────┘     │
│                             │
└─────────────────────────────┘
```

Tech: plain HTML + JS (Bun.serve HTML imports), Telegram WebApp SDK, browser WebRTC API.

### 7.3 WebRTC Audio Flow

```typescript
// Server-side: play audio into WebRTC connection
// Using @roamhq/wrtc for server-side WebRTC

import { RTCPeerConnection } from '@roamhq/wrtc';
import { RTCAudioSource } from '@roamhq/wrtc/nonstandard';

function playAudioToConnection(pc: RTCPeerConnection, audioBuffer: Buffer) {
  const source = new RTCAudioSource();
  const track = source.createTrack();
  pc.addTrack(track);

  // Feed PCM samples to the audio source
  // audioBuffer must be: 16-bit PCM, 48kHz, mono
  const SAMPLES_PER_FRAME = 480; // 10ms at 48kHz
  let offset = 0;

  const interval = setInterval(() => {
    if (offset >= audioBuffer.length) {
      clearInterval(interval);
      return;
    }

    const frame = {
      samples: new Int16Array(
        audioBuffer.buffer,
        audioBuffer.byteOffset + offset,
        SAMPLES_PER_FRAME
      ),
      sampleRate: 48000,
      bitsPerSample: 16,
      channelCount: 1,
      numberOfFrames: SAMPLES_PER_FRAME,
    };

    source.onData(frame);
    offset += SAMPLES_PER_FRAME * 2; // 2 bytes per sample
  }, 10); // every 10ms
}
```

---

## 8. SQLite Schema Additions

```sql
-- User call preferences
CREATE TABLE IF NOT EXISTS user_call_settings (
  user_id       INTEGER PRIMARY KEY,          -- telegram_id
  calls_enabled INTEGER NOT NULL DEFAULT 0,   -- opt-in required
  call_tier     TEXT NOT NULL DEFAULT 'voice_message',  -- 'voice_message' | 'webrtc_call'
  max_calls_day INTEGER NOT NULL DEFAULT 5,
  quiet_start   TEXT NOT NULL DEFAULT '23:00', -- HH:MM in user timezone
  quiet_end     TEXT NOT NULL DEFAULT '07:00',
  call_language TEXT NOT NULL DEFAULT 'ru',    -- 'ru' | 'en'
  important_only INTEGER NOT NULL DEFAULT 0,  -- only call for "important" events
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

-- Call log (every call attempt)
CREATE TABLE IF NOT EXISTS call_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,               -- telegram_id
  event_id      INTEGER NOT NULL,
  call_type     TEXT NOT NULL,                   -- 'voice_message' | 'webrtc_call'
  state         TEXT NOT NULL,                   -- final state
  tts_engine    TEXT NOT NULL,                   -- 'edge_tts' | 'openai_tts'
  tts_latency_ms INTEGER,
  stt_provider  TEXT,                            -- 'runpod' | 'huggingface' | null
  stt_latency_ms INTEGER,
  cold_start_ms INTEGER,
  call_duration_ms INTEGER,
  user_response TEXT,                            -- transcribed text (ephemeral, cleared after processing)
  action_taken  TEXT,                            -- 'snooze' | 'cancel' | 'acknowledge' | 'no_response'
  snooze_minutes INTEGER,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

-- Daily call counter (enforce max_calls_day)
CREATE TABLE IF NOT EXISTS call_daily_count (
  user_id       INTEGER NOT NULL,               -- telegram_id
  date          TEXT NOT NULL,                   -- YYYY-MM-DD
  call_count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

-- RunPod cold start analytics
CREATE TABLE IF NOT EXISTS cold_start_analytics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
  provider      TEXT NOT NULL DEFAULT 'runpod',
  cold_start_ms INTEGER NOT NULL,
  was_pre_warmed INTEGER NOT NULL DEFAULT 0,
  inference_ms  INTEGER NOT NULL,
  audio_length_ms INTEGER,
  success       INTEGER NOT NULL DEFAULT 1,
  error         TEXT
);

-- TTS cache metadata (actual audio in Redis)
CREATE TABLE IF NOT EXISTS tts_cache (
  cache_key     TEXT PRIMARY KEY,                -- e.g., 'greeting_ru:DmitryNeural'
  voice         TEXT NOT NULL,
  language      TEXT NOT NULL,
  text_hash     TEXT NOT NULL,                   -- SHA256 of source text
  audio_size    INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at  TEXT NOT NULL DEFAULT (datetime('now')),
  use_count     INTEGER NOT NULL DEFAULT 0
);

-- WebRTC call sessions (short-lived, could also be Redis-only)
CREATE TABLE IF NOT EXISTS call_sessions (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL,               -- telegram_id
  event_id      INTEGER NOT NULL,
  state         TEXT NOT NULL DEFAULT 'created',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL,
  connected_at  TEXT,
  ended_at      TEXT,
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);
```

---

## 9. Settings and Privacy

### 9.1 User Settings Flow

Call reminders are **off by default**. User must explicitly opt in:

```
/settings -> Call Reminders -> Enable
  -> Choose tier: Voice Messages / WebRTC Calls
  -> Set quiet hours (default 23:00 - 07:00)
  -> Set max calls per day (default 5)
  -> Set language (Russian / English)
  -> Which events: All / Important only
```

For WebRTC calls, user must also:

- Be contactable by the virtual user (for voice message tier)
- Grant microphone permission in Mini App (for WebRTC tier, if they want to respond verbally)

### 9.2 Privacy Guarantees

| Data | Stored? | Duration | Notes |
|------|---------|----------|-------|
| TTS audio (reminder) | Cached in Redis | 7 days | Common phrases only, not personal content |
| User voice response (raw audio) | No | Discarded after STT | Never written to disk |
| STT transcription | Briefly in memory | Cleared after AI processing | Not stored in call_log after action is taken |
| Call metadata (time, duration, action) | Yes | Indefinitely | For analytics and debugging |
| Event content in calls | No | RAM only during call | Not logged or stored |

**call_log.user_response** field: written temporarily during processing, then nullified:

```typescript
// After AI agent processes the response:
db.run(`UPDATE call_log SET user_response = NULL WHERE id = ?`, [callLogId]);
```

### 9.3 Virtual User Contact Requirement

For voice message tier (Approach D), the virtual user must be able to send messages to the user. Options:

1. User sends `/start` to the virtual user first (simplest)
2. Bot provides a link: "To enable call reminders, start a chat with our call assistant: @HyperCalendarCaller"
3. Virtual user is added to the bot's "call group" with the user (overkill)

---

## 10. Monetization via Telegram Stars

Voice call reminders are a premium feature gated behind **Telegram Stars** payment.

### 10.1 Tiered Access

| Tier | Feature | Stars Required | Notes |
|------|---------|---------------|-------|
| **Free** | Voice message reminders (Approach D) | None | TTS audio sent as Telegram voice note + inline buttons |
| **Paid** | WebRTC Mini App calls (Approach C) | Yes | Full WebRTC call with STT + AI agent response |

### 10.2 Why Stars

- **Naturally limits adoption and prevents abuse.** Only users who actually need voice calls will pay for them.
- **Keeps virtual user account safe from Telegram bans.** Low volume of voice messages = less suspicious activity.
- **Replaces vague "risk of ban" mitigation with a concrete strategy.** Instead of hoping rate limits are enough, the paywall itself is the rate limiter.
- **Revenue.** Voice calls have real server-side cost (RunPod STT, compute). Stars cover it.

### 10.3 Implementation

- Users pay Stars to enable voice call reminders via `/settings -> Call Reminders -> Upgrade to WebRTC Calls`.
- Stars payment handled via Telegram's built-in payment flow (Bot Payments API with Stars currency).
- Pricing TBD — enough to discourage mass use, low enough to be useful for power users.
- `user_call_settings.call_tier` reflects current tier: `'voice_message'` (free) or `'webrtc_call'` (paid).

---

## 11. BullMQ Job Design

### 11.1 Job Types

```typescript
// call-reminder: main job, dispatched by notification system
interface CallReminderJob {
  type: 'call-reminder';
  userId: number;           // telegram_id
  eventId: number;
  eventTitle: string;
  eventTime: string;        // ISO 8601 UTC
  eventLocation?: string;
  reminderType: 'voice_message' | 'webrtc_call';
  language: 'ru' | 'en';
  attempt: number;          // retry count
}

// call-prewarm: proactive RunPod pre-warming
interface CallPreWarmJob {
  type: 'call-prewarm';
  scheduledCallTime: string; // ISO 8601 UTC
  userId: number;            // telegram_id
}
```

### 11.2 Job Scheduling

```typescript
// When notification system creates a call reminder:
await callQueue.add('call-reminder', jobData, {
  delay: calculateDelay(event), // fire N minutes before event
  attempts: 2,
  backoff: { type: 'fixed', delay: 30_000 }, // retry after 30s
  removeOnComplete: true,
  removeOnFail: false, // keep for debugging
});

// Pre-warm job (scheduled 30s before the call, adjusted by rolling avg)
const preWarmLeadTime = preWarmer.getEstimatedColdStart() + 5000; // +5s buffer
await callQueue.add('call-prewarm', {
  type: 'call-prewarm',
  scheduledCallTime: jobData.eventTime,
  userId: jobData.userId,
}, {
  delay: calculateDelay(event) - preWarmLeadTime,
});
```

### 11.3 Worker Processing

```typescript
callWorker.process(async (job) => {
  if (job.name === 'call-prewarm') {
    await preWarmer.preWarm();
    return;
  }

  const { userId, eventId, reminderType, language } = job.data;

  // 1. Validate: quiet hours, daily limit, user still has calls enabled
  const settings = getUserCallSettings(userId);
  if (!settings.calls_enabled) return { skipped: 'calls_disabled' };
  if (isQuietHours(settings)) return { skipped: 'quiet_hours' };
  if (await isDailyLimitReached(userId, settings.max_calls_day)) {
    return { skipped: 'daily_limit' };
  }

  // 2. Pre-warm RunPod (if not already warm)
  if (reminderType === 'webrtc_call') {
    await preWarmer.ensureWarm(); // non-blocking if already warm
  }

  // 3. Synthesize TTS
  const reminderText = buildReminderText(job.data, language);
  const audioBuffer = await synthesize({ text: reminderText, language });

  // 4. Execute based on tier
  if (reminderType === 'voice_message') {
    await sendVoiceMessage(userId, audioBuffer, job.data);
  } else {
    await initiateWebRTCCall(userId, audioBuffer, job.data);
  }

  // 5. Increment daily counter
  await incrementDailyCount(userId);
});
```

---

## 12. Error Handling and Edge Cases

### 12.1 Failure Scenarios

| Scenario | Handling |
|----------|----------|
| User doesn't tap "Answer" (WebRTC) within 60s | Cancel session, fall back to text message |
| WebRTC connection fails | Fall back to voice message |
| TTS synthesis fails (Edge TTS down) | Fall back to OpenAI TTS, then plain text message |
| RunPod STT timeout (>10s) | Fall back to HuggingFace, then ask user to respond via text |
| User's Whisper transcription is gibberish | Bot says "I didn't catch that, I'll send a text reminder" |
| Virtual user banned by Telegram | Alert admin, switch all users to WebRTC tier |
| Daily call limit reached | Skip call, send regular text reminder |
| Event cancelled while call in progress | Gracefully end call, inform user |

### 12.2 Retry Policy

- Voice messages: retry once after 30 seconds, then fall back to text
- WebRTC calls: no automatic retry (annoying to get multiple "call" notifications). Fall back to voice message on first failure
- STT: retry once with fallback provider, then give up on verbal response and offer button actions

### 12.3 Latency Budget

Total target: **< 30 seconds from event trigger to user hearing audio**

| Step | Budget | Notes |
|------|--------|-------|
| BullMQ job pickup | < 1s | Redis is fast |
| Settings validation | < 10ms | SQLite query |
| TTS synthesis | < 500ms | Edge TTS, or cached |
| RunPod pre-warm | 0ms (pre-warmed) / 15s (cold) | Pre-warming handles this |
| Send voice message | < 1s | Telegram API |
| OR: Create session + send Mini App button | < 1s | |
| User taps "Answer" | variable | Out of our control |
| WebRTC connection setup | < 3s | ICE + DTLS |
| Audio playback start | < 100ms | Immediate once connected |
| **Total (voice message path)** | **< 3s** | |
| **Total (WebRTC path, pre-warmed)** | **< 5s + user tap time** | |

---

## 13. Cost Analysis

### 13.1 Per-Call Cost Estimate

#### Voice Message Tier (Approach D)

| Component | Cost | Notes |
|-----------|------|-------|
| Edge TTS | $0.00 | Free |
| Telegram API | $0.00 | Free |
| **Total per voice message** | **$0.00** | Just compute cost |

#### WebRTC Call Tier (Approach C)

| Component | Cost | Notes |
|-----------|------|-------|
| Edge TTS | $0.00 | Free |
| RunPod Whisper (5s audio, A4000) | ~$0.0005 | 3s inference at $0.00016/s |
| RunPod cold start (amortized) | ~$0.002 | 15s cold start, amortized over batch |
| Server compute (WebRTC, 60s call) | negligible | Running on existing server |
| AI agent (LLM call for response) | ~$0.001 | GPT-4o-mini or similar |
| **Total per WebRTC call** | **~$0.004** | |

#### Monthly Estimates (per active user)

| Scenario | Calls/month | Cost/month |
|----------|-------------|------------|
| Light user (2 calls/week, voice msg only) | 8 | $0.00 |
| Active user (1 call/day, mixed tiers) | 30 | ~$0.06 |
| Power user (3 calls/day, all WebRTC) | 90 | ~$0.36 |

#### Infrastructure

| Component | Monthly Cost | Notes |
|-----------|-------------|-------|
| RunPod (Flex, A4000) | ~$5-20 | Depends on usage, scales to zero |
| Redis (call sessions, TTS cache) | Already exists | Part of main bot infra |
| Edge TTS | $0 | Free |
| HuggingFace Pro (fallback STT) | $9 | Optional, for fallback |
| **Total infrastructure** | **$5-30/mo** | Scales with users |

### 13.2 OpenAI TTS Cost (If Used as Fallback)

- tts-1: $15 per 1M characters
- Average reminder: ~200 characters
- 1000 calls = 200K characters = $3.00
- Only used if Edge TTS fails, so actual cost should be near zero

---

## 14. Risks and Unknowns

### 14.1 High Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Telegram bans virtual user for automated voice messages** | Voice message tier broken | Telegram Stars paywall naturally limits volume. Use dedicated phone number, rate limit aggressively, add human-like delays |
| **Edge TTS API changes or gets rate-limited** | TTS pipeline broken | OpenAI TTS fallback already built in |
| **RunPod cold starts exceed 30s regularly** | STT unusable for real-time | Aggressive pre-warming, switch to active worker ($0.40/hr) if usage justifies it |

### 14.2 Medium Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| **@roamhq/wrtc compatibility with Bun** | WebRTC tier may need Node.js sidecar | Tested in `voice-ai-agent-ios` with Node.js. Bun compatibility needs verification but wrtc is a native addon, likely works. Fallback: run WebRTC server in a separate Node.js process |
| **Mini App WebRTC has browser compatibility issues** | Some users can't use WebRTC tier | Test on Android/iOS/Desktop Telegram. Fall back to voice messages |
| **Users find "tap to answer" annoying vs. real call** | Low adoption of WebRTC tier | A/B test with voice message tier, iterate on UX |
| **Whisper accuracy poor for short commands in Russian** | AI agent misinterprets user | Constrain possible responses, add confirmation step, offer button fallback |
| **User timezone detection inaccurate** | Calls during quiet hours | Use Telegram's timezone if available, ask user to confirm |

### 14.3 Unknowns (Need Investigation)

| Unknown | Why It Matters | How to Resolve |
|---------|---------------|----------------|
| **Telegram Mini App audio permissions** | WebRTC needs microphone access | Test on real devices |
| **Edge TTS concurrent request limits** | Might hit rate limits at scale | Load test with 100 concurrent requests |
| **MarshalX/tgcalls private call release timeline** | Determines when Approach B becomes viable | Monitor GitHub releases |
| **Telegram rate limits on voice messages from userbot** | Might limit throughput | Test with increasing volumes |

---

## 15. Implementation Plan

### Phase 1: Foundation (1 week)

- [ ] Set up virtual user (@mtcute) authentication and session persistence
- [ ] Implement Edge TTS integration with caching
- [ ] Build BullMQ call-reminder job queue
- [ ] SQLite schema migrations
- [ ] Quiet hours and daily limit enforcement

### Phase 2: Voice Message Tier (1 week)

- [ ] Voice message synthesis and sending via virtual user
- [ ] Inline button actions (snooze, cancel, acknowledge)
- [ ] End-to-end test: event trigger -> voice message -> user action

### Phase 3: WebRTC Mini App (2 weeks)

- [ ] Port `voice-ai-agent-ios` WebRTC server to Bun (reference implementation exists, adapt `simple-webrtc.js`)
- [ ] Verify @roamhq/wrtc works in Bun (native addon, likely fine; fallback: Node.js sidecar)
- [ ] WebSocket signaling server
- [ ] Mini App frontend (call UI)
- [ ] Server-side audio playback into WebRTC
- [ ] Server-side audio capture from WebRTC

### Phase 4: STT Integration (1 week)

- [ ] RunPod Whisper endpoint deployment
- [ ] Pre-warming system with rolling average
- [ ] HuggingFace fallback
- [ ] AI agent integration for verbal response processing

### Phase 5: Polish and Settings (1 week)

- [ ] User settings UI in bot
- [ ] Call analytics dashboard
- [ ] Error handling and fallback chains
- [ ] Privacy: verify no audio/transcription persists
- [ ] Load testing

**Total estimate: 6 weeks**

---

## 16. Open Questions for Discussion

1. **Should the virtual user be the same as the one used for other bot features, or a dedicated "caller" account?** Dedicated account is safer (if it gets banned, other features survive), but adds management overhead.

2. **Do we need to support video in calls?** The spec says voice-only, but video could show event details, map to location, etc. Would increase complexity significantly.

3. **Should the AI agent be allowed to modify events (reschedule, not just snooze)?** "Reschedule to tomorrow at 10" is powerful but dangerous if STT misinterprets.

4. **How do we handle group events?** Call each participant individually? Call only the event creator?

5. **Do we need call recording for debugging (with user consent)?** Useful for improving STT accuracy, but privacy implications.
