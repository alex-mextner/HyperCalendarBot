# Bidirectional Voice Calls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing one-way voice call system with full bidirectional audio — the bot listens to the user during a live Telegram call via VAD + Deepgram streaming STT, detects when the user wants to respond, classifies interruptions with Haiku (RU) or Flux EOT (EN), and replies with synthesized audio and pre-recorded thinking phrases.

**Architecture:** A Bun WebSocket server on `:3001` manages N concurrent `CallSession` instances, each owning its STT connection, classifier, and agent. The existing Python bridge (`scripts/voice-call-bridge.py`) is rewritten to accept a `sessionId`, connect to the WS server, capture incoming audio via pytgcalls + Silero VAD, and stream PCM frames to Bun. Bun handles all AI logic (Nova-3 for RU, Flux for EN, Haiku classifier, CalendarBotAgent, TTS) and sends `PLAY`/`PAUSE`/`RESUME`/`STOP` commands back to Python.

**Tech Stack:** Bun built-in WebSocket (client + server), Deepgram Nova-3/Flux via raw WS protocol, Anthropic Haiku for RU interruption classification, pytgcalls + Silero VAD in Python, OGG Opus via Silero/Kokoro/Google TTS fallback.

---

## File Structure

### New files

| File | Responsibility |
|------|----------------|
| `src/services/voice/nova-streaming-stt.ts` | Nova-3 Deepgram WebSocket client (RU, 48kHz). Opens per-episode, closes on VAD_END. |
| `src/services/voice/flux-streaming-stt.ts` | Flux Deepgram WebSocket client (EN, 16kHz). One persistent WS per call. Emits StartOfTurn / EndOfTurn. |
| `src/services/voice/interruption-classifier.ts` | Rule-based classifier for RU interim transcripts → `noise \| resume \| respond`. Zero-latency keyword matching, no LLM. |
| `src/services/voice/thinking-phrase-player.ts` | Schedules start_* and mid_* thinking phrase playback with randomized delays; cancels on agent response. |
| `src/services/voice/call-session.ts` | Per-call state machine. Owns STT, classifier, thinking player, agent. Routes WS messages from Python bridge. |
| `src/services/voice/call-session-manager.ts` | Session registry (Map<sessionId, CallSession>). Starts `Bun.serve()` on `:3001`. Routes WS connections by URL path. |
| `scripts/generate-call-phrases.ts` | CLI: uses TtsService (Google TTS) to generate `data/call-phrases/{ru,en}/*.ogg`. Idempotent. |

### Modified files

| File | Change |
|------|--------|
| `src/services/ai/types.ts:74` | Remove `isVoiceMessage?: boolean`, add `inputMode?: 'text' \| 'voice_message' \| 'live_call'` |
| `src/services/ai/system-prompt.ts:100-108` | Replace boolean check with 3-way switch on `inputMode` |
| `src/bot/handlers/message.handler.ts` | Update `isVoiceMessage: true` → `inputMode: 'voice_message'` |
| `src/services/voice/call-manager.ts` | Add primary/fallback TTS pattern; pass `sessionId` to bridge; support bidirectional mode |
| `src/services/voice/types.ts` | Add `sessionId: string` and ensure `language` to `CallReminderJobData` |
| `src/worker/call-queue.ts` | Generate `sessionId` (UUID) in `enqueue()`, include it in job data |
| `scripts/voice-call-bridge.py` | Full rewrite: accept `user_id session_id language`, connect WS, bidirectional VAD + audio |
| `.gitignore` | Add `data/call-phrases/` |

### Test files

| File | What it tests |
|------|---------------|
| `test/services/voice/nova-streaming-stt.test.ts` | Builds correct WS URL, sends frames, parses interim/final events |
| `test/services/voice/flux-streaming-stt.test.ts` | Builds correct URL, handles StartOfTurn/EndOfTurn events |
| `test/services/voice/interruption-classifier.test.ts` | Debounce (word count, in-flight), Haiku response → decision mapping |
| `test/services/voice/thinking-phrase-player.test.ts` | Schedules start phrase immediately, mid phrases at delays, cancel stops timers |
| `test/services/voice/call-session.test.ts` | State machine: VAD_START pauses playback; respond → thinking + agent + TTS; CALL_ENDED cleans up |
| `test/services/voice/call-session-manager.test.ts` | Creates/destroys sessions, 30-min timeout |

---

## Task 1: inputMode type change

**Files:**
- Modify: `src/services/ai/types.ts:74`
- Modify: `src/services/ai/system-prompt.ts:100-108`
- Modify: `src/bot/handlers/message.handler.ts` (the line `isVoiceMessage: true`)

No new tests — this touches existing code paths covered by current tests. Existing tests must stay green.

- [ ] **Step 1.1: Update AgentContext type**

In `src/services/ai/types.ts`, find line 74:
```typescript
// Remove:
isVoiceMessage?: boolean;
// Add:
inputMode?: 'text' | 'voice_message' | 'live_call';
```

- [ ] **Step 1.2: Update system prompt**

In `src/services/ai/system-prompt.ts`, replace the voice message block (lines ~100-108):
```typescript
${
  ctx.inputMode === 'voice_message'
    ? `## Voice Message
This message was transcribed from a voice message using speech recognition.
The transcription may contain errors — words can be replaced with similar-sounding ones (homophones, wrong word boundaries, misheard names).
Use conversation context and common sense to infer what the user actually meant.
Do NOT ask the user to repeat themselves unless the message is completely unintelligible.`
    : ctx.inputMode === 'live_call'
    ? `## Live Phone Call
This is a live voice call via Telegram.
Speech recognition may produce artifacts: homophones, merged words, background noise.
When something seems off, make your best guess and ask for confirmation rather than asking to repeat.
Ask multiple questions in a single response to minimize round-trips — the user is on a call and each exchange takes time.
Keep responses short and spoken-word friendly: no bullet points, no markdown, no lists.`
    : ''
}
```

- [ ] **Step 1.3: Update message handler**

In `src/bot/handlers/message.handler.ts`, find:
```typescript
isVoiceMessage: true,
```
Replace with:
```typescript
inputMode: 'voice_message',
```

- [ ] **Step 1.4: Run tests — must all pass**

```bash
bun test
```
Expected: all tests pass (same count as before this task).

- [ ] **Step 1.5: Commit**

```bash
git add src/services/ai/types.ts src/services/ai/system-prompt.ts src/bot/handlers/message.handler.ts
git commit -m "refactor(voice): replace isVoiceMessage boolean with inputMode enum (text|voice_message|live_call)"
```

---

## Task 2: Generate thinking phrases script + .gitignore

**Files:**
- Create: `scripts/generate-call-phrases.ts`
- Modify: `.gitignore`

- [ ] **Step 2.1: Add to .gitignore**

In `.gitignore`, add:
```
data/call-phrases/
```

- [ ] **Step 2.2: Write generator script**

Create `scripts/generate-call-phrases.ts`:
```typescript
#!/usr/bin/env bun
/**
 * Generates pre-recorded thinking phrase audio files for live calls.
 * Uses SileroTtsService for Russian and KokoroTtsService for English —
 * same engines as normal bot voice replies, so the voice matches.
 * Both produce OGG Opus natively; no ffmpeg needed.
 * Idempotent — skips existing files.
 *
 * Usage: bun run scripts/generate-call-phrases.ts
 * Env vars:
 *   PYTHON_PATH — path to Python binary for Silero TTS (default: venv/bin/python)
 *   HF_TOKEN    — Hugging Face token for Kokoro TTS (required for EN phrases)
 */
import { existsSync, mkdirSync } from 'node:fs';
import { SileroTtsService } from '../src/services/voice/silero-tts-service.ts';
import { KokoroTtsService } from '../src/services/voice/kokoro-tts-service.ts';
import { StressDictionary } from '../src/services/voice/stress-dictionary.ts';
import {
  fixDateOrdinals,
  fixLineBreaks,
  markStress,
  numbersToWords,
  stripMarkdown,
  transliterateEnglish,
} from '../src/services/voice/stress-marker.ts';

const RU_PHRASES: Record<string, string> = {
  'start_hmm.ogg': 'Хмм.',
  'start_sec.ogg': 'Секундочку.',
  'start_look.ogg': 'Сейчас посмотрю.',
  'start_think.ogg': 'Дай подумаю.',
  'mid_checking.ogg': 'Проверяю.',
  'mid_moment.ogg': 'Момент.',
  'mid_almost.ogg': 'Почти готово.',
  'mid_looking.ogg': 'Смотрю в календарь.',
};

const EN_PHRASES: Record<string, string> = {
  'start_hmm.ogg': 'Hmm.',
  'start_sec.ogg': 'One second.',
  'start_look.ogg': 'Let me check.',
  'start_think.ogg': 'Let me think.',
  'mid_checking.ogg': 'Checking.',
  'mid_moment.ogg': 'Just a moment.',
  'mid_almost.ogg': 'Almost there.',
  'mid_looking.ogg': 'Looking at your calendar.',
};

async function generate() {
  const pythonPath = process.env.PYTHON_PATH ?? 'venv/bin/python';
  const hfToken = process.env.HF_TOKEN;

  // Russian — SileroTts
  const stressDict = await StressDictionary.loadFromFile('data/dictionaries/stress-dict.json');
  const sileroTts = new SileroTtsService(pythonPath);

  const ruDir = 'data/call-phrases/ru';
  mkdirSync(ruDir, { recursive: true });

  for (const [file, text] of Object.entries(RU_PHRASES)) {
    const path = `${ruDir}/${file}`;
    if (existsSync(path)) { console.log(`Skip: ${path}`); continue; }
    console.log(`RU: ${path} — "${text}"`);
    try {
      const plain = fixLineBreaks(stripMarkdown(text));
      const stressed = transliterateEnglish(markStress(numbersToWords(fixDateOrdinals(plain)), stressDict));
      const audio = await sileroTts.synthesize(stressed);
      await Bun.write(path, audio);
      console.log(`  OK (${audio.length} bytes)`);
    } catch (err) { console.error(`  FAIL: ${err}`); }
  }

  // English — KokoroTts
  if (!hfToken) {
    console.warn('HF_TOKEN not set — skipping EN phrases');
  } else {
    const kokoroTts = new KokoroTtsService(hfToken);

    const enDir = 'data/call-phrases/en';
    mkdirSync(enDir, { recursive: true });

    for (const [file, text] of Object.entries(EN_PHRASES)) {
      const path = `${enDir}/${file}`;
      if (existsSync(path)) { console.log(`Skip: ${path}`); continue; }
      console.log(`EN: ${path} — "${text}"`);
      try {
        const audio = await kokoroTts.synthesize(text);
        await Bun.write(path, audio);
        console.log(`  OK (${audio.length} bytes)`);
      } catch (err) { console.error(`  FAIL: ${err}`); }
    }
  }

  console.log('Done.');
}

await generate();
```

**Constructor signatures (for reference):**
- `SileroTtsService(pythonPath: string)` — pythonPath defaults to `venv/bin/python`
- `KokoroTtsService(hfToken: string)` — requires Hugging Face token
- `StressDictionary.loadFromFile(path)` — static async method, path `data/dictionaries/stress-dict.json`

Note: This script is a CLI utility — no unit tests needed. It will fail gracefully if the TTS services are unavailable. The output is already OGG Opus — no ffmpeg conversion needed.

- [ ] **Step 2.3: Test-run script**

```bash
bun run scripts/generate-call-phrases.ts
```

Expected: Creates `data/call-phrases/ru/*.ogg` and `data/call-phrases/en/*.ogg`. Each file ~5-20KB.

- [ ] **Step 2.4: Commit**

```bash
git add scripts/generate-call-phrases.ts .gitignore
git commit -m "feat(voice): thinking phrases generator script + gitignore data/call-phrases"
```

---

## Task 3: NovaStreamingSTT

**Files:**
- Create: `src/services/voice/nova-streaming-stt.ts`
- Create: `test/services/voice/nova-streaming-stt.test.ts`

### 3.1 Write failing tests

Create `test/services/voice/nova-streaming-stt.test.ts`:
```typescript
import { describe, expect, mock, test } from 'bun:test';
import { NovaStreamingSTT } from '../../../src/services/voice/nova-streaming-stt.ts';

function makeWsMock() {
  const ws = {
    readyState: 1, // OPEN
    send: mock(() => {}),
    close: mock(() => {}),
    onmessage: null as ((e: { data: string }) => void) | null,
    onerror: null as ((e: unknown) => void) | null,
    onclose: null as (() => void) | null,
    onopen: null as (() => void) | null,
  };
  return ws;
}

test('builds correct Deepgram URL with Nova-3 params', () => {
  let capturedUrl = '';
  const stt = new NovaStreamingSTT('test-api-key', {
    createWs: (url: string) => {
      capturedUrl = url;
      return makeWsMock() as unknown as WebSocket;
    },
  });
  stt.connect({ onInterim: () => {}, onFinal: () => {}, onError: () => {} });
  expect(capturedUrl).toContain('wss://api.deepgram.com/v1/listen');
  expect(capturedUrl).toContain('model=nova-3');
  expect(capturedUrl).toContain('language=ru');
  expect(capturedUrl).toContain('sample_rate=48000');
  expect(capturedUrl).toContain('interim_results=true');
});

test('sends PCM buffer to WebSocket', () => {
  const ws = makeWsMock();
  const stt = new NovaStreamingSTT('key', { createWs: () => ws as unknown as WebSocket });
  stt.connect({ onInterim: () => {}, onFinal: () => {}, onError: () => {} });

  const pcm = Buffer.from([1, 2, 3, 4]);
  stt.sendAudio(pcm);

  expect(ws.send).toHaveBeenCalledWith(pcm);
});

test('emits interim transcript from Deepgram message', () => {
  const ws = makeWsMock();
  const stt = new NovaStreamingSTT('key', { createWs: () => ws as unknown as WebSocket });
  const onInterim = mock(() => {});
  stt.connect({ onInterim, onFinal: () => {}, onError: () => {} });

  ws.onmessage?.({
    data: JSON.stringify({
      is_final: false,
      channel: { alternatives: [{ transcript: 'привет' }] },
    }),
  });

  expect(onInterim).toHaveBeenCalledWith('привет');
});

test('emits final transcript from Deepgram message', () => {
  const ws = makeWsMock();
  const stt = new NovaStreamingSTT('key', { createWs: () => ws as unknown as WebSocket });
  const onFinal = mock(() => {});
  stt.connect({ onInterim: () => {}, onFinal, onError: () => {} });

  ws.onmessage?.({
    data: JSON.stringify({
      is_final: true,
      channel: { alternatives: [{ transcript: 'добрый день' }] },
    }),
  });

  expect(onFinal).toHaveBeenCalledWith('добрый день');
});

test('does not send audio when WS is not open', () => {
  const ws = makeWsMock();
  ws.readyState = 3; // CLOSED
  const stt = new NovaStreamingSTT('key', { createWs: () => ws as unknown as WebSocket });
  stt.connect({ onInterim: () => {}, onFinal: () => {}, onError: () => {} });

  stt.sendAudio(Buffer.from([1, 2, 3]));

  expect(ws.send).not.toHaveBeenCalled();
});

test('close sends CloseStream and nulls ws', () => {
  const ws = makeWsMock();
  const stt = new NovaStreamingSTT('key', { createWs: () => ws as unknown as WebSocket });
  stt.connect({ onInterim: () => {}, onFinal: () => {}, onError: () => {} });
  stt.close();

  expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'CloseStream' }));
});
```

- [ ] **Step 3.2: Run failing tests**

```bash
bun test test/services/voice/nova-streaming-stt.test.ts
```
Expected: FAIL — `NovaStreamingSTT` not found.

- [ ] **Step 3.3: Implement NovaStreamingSTT**

Create `src/services/voice/nova-streaming-stt.ts`:
```typescript
// src/services/voice/nova-streaming-stt.ts

export interface NovaStreamingSTTEvents {
  onInterim: (transcript: string) => void;
  onFinal: (transcript: string) => void;
  onError: (err: Error) => void;
}

export interface NovaStreamingSTTDeps {
  createWs?: (url: string) => WebSocket;
}

export class NovaStreamingSTT {
  private ws: WebSocket | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly deps: NovaStreamingSTTDeps = {},
  ) {}

  connect(events: NovaStreamingSTTEvents): void {
    const params = new URLSearchParams({
      model: 'nova-3',
      language: 'ru',
      punctuate: 'true',
      smart_format: 'true',
      encoding: 'linear16',
      sample_rate: '48000',
      channels: '1',
      interim_results: 'true',
    });
    const url = `wss://api.deepgram.com/v1/listen?${params}`;
    const createWs = this.deps.createWs ?? ((u) => new WebSocket(u, { headers: { Authorization: `Token ${this.apiKey}` } } as never));
    this.ws = createWs(url);

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as {
          is_final: boolean;
          channel?: { alternatives?: { transcript: string }[] };
        };
        const transcript = data.channel?.alternatives?.[0]?.transcript ?? '';
        if (!transcript) return;
        if (data.is_final) events.onFinal(transcript);
        else events.onInterim(transcript);
      } catch {
        // non-JSON keepalive
      }
    };

    this.ws.onerror = () => events.onError(new Error('Nova-3 WebSocket error'));
  }

  sendAudio(pcm: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcm);
    }
  }

  close(): void {
    if (this.ws) {
      try {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch {}
      this.ws = null;
    }
  }
}
```

- [ ] **Step 3.4: Run tests — must pass**

```bash
bun test test/services/voice/nova-streaming-stt.test.ts
```
Expected: all 6 pass.

- [ ] **Step 3.5: Commit**

```bash
git add src/services/voice/nova-streaming-stt.ts test/services/voice/nova-streaming-stt.test.ts
git commit -m "feat(voice): NovaStreamingSTT — Deepgram Nova-3 RU streaming WebSocket client"
```

---

## Task 4: FluxStreamingSTT

**Files:**
- Create: `src/services/voice/flux-streaming-stt.ts`
- Create: `test/services/voice/flux-streaming-stt.test.ts`

### 4.1 Write failing tests

Create `test/services/voice/flux-streaming-stt.test.ts`:
```typescript
import { describe, expect, mock, test } from 'bun:test';
import { FluxStreamingSTT } from '../../../src/services/voice/flux-streaming-stt.ts';

function makeWsMock() {
  return {
    readyState: 1,
    send: mock(() => {}),
    close: mock(() => {}),
    onmessage: null as ((e: { data: string }) => void) | null,
    onerror: null as ((e: unknown) => void) | null,
    onclose: null as (() => void) | null,
    onopen: null as (() => void) | null,
  };
}

test('builds Flux URL with correct params', () => {
  let capturedUrl = '';
  const stt = new FluxStreamingSTT('test-key', {
    createWs: (url) => { capturedUrl = url; return makeWsMock() as unknown as WebSocket; },
  });
  stt.connect({ onStartOfTurn: () => {}, onEndOfTurn: () => {}, onInterim: () => {}, onError: () => {} });
  expect(capturedUrl).toContain('model=flux-general-en');
  expect(capturedUrl).toContain('sample_rate=16000');
  expect(capturedUrl).toContain('eot_threshold=0.7');
});

test('emits onStartOfTurn when Flux sends StartOfTurn event', () => {
  const ws = makeWsMock();
  const stt = new FluxStreamingSTT('key', { createWs: () => ws as unknown as WebSocket });
  const onStartOfTurn = mock(() => {});
  stt.connect({ onStartOfTurn, onEndOfTurn: () => {}, onInterim: () => {}, onError: () => {} });

  ws.onmessage?.({ data: JSON.stringify({ type: 'StartOfTurn' }) });

  expect(onStartOfTurn).toHaveBeenCalledTimes(1);
});

test('emits onEndOfTurn when Flux sends EndOfTurn event', () => {
  const ws = makeWsMock();
  const stt = new FluxStreamingSTT('key', { createWs: () => ws as unknown as WebSocket });
  const onEndOfTurn = mock(() => {});
  stt.connect({ onStartOfTurn: () => {}, onEndOfTurn, onInterim: () => {}, onError: () => {} });

  ws.onmessage?.({ data: JSON.stringify({ type: 'EndOfTurn', end_of_turn_confidence: 0.85 }) });

  expect(onEndOfTurn).toHaveBeenCalledWith(0.85);
});

test('emits onInterim for regular transcript', () => {
  const ws = makeWsMock();
  const stt = new FluxStreamingSTT('key', { createWs: () => ws as unknown as WebSocket });
  const onInterim = mock(() => {});
  stt.connect({ onStartOfTurn: () => {}, onEndOfTurn: () => {}, onInterim, onError: () => {} });

  ws.onmessage?.({
    data: JSON.stringify({
      is_final: false,
      channel: { alternatives: [{ transcript: 'hello' }] },
    }),
  });

  expect(onInterim).toHaveBeenCalledWith('hello');
});

test('does not send audio when closed', () => {
  const ws = makeWsMock();
  ws.readyState = 3;
  const stt = new FluxStreamingSTT('key', { createWs: () => ws as unknown as WebSocket });
  stt.connect({ onStartOfTurn: () => {}, onEndOfTurn: () => {}, onInterim: () => {}, onError: () => {} });
  stt.sendAudio(Buffer.from([1, 2]));
  expect(ws.send).not.toHaveBeenCalled();
});
```

- [ ] **Step 4.2: Run failing tests**

```bash
bun test test/services/voice/flux-streaming-stt.test.ts
```
Expected: FAIL.

- [ ] **Step 4.3: Implement FluxStreamingSTT**

Create `src/services/voice/flux-streaming-stt.ts`:
```typescript
// src/services/voice/flux-streaming-stt.ts

export interface FluxStreamingSTTEvents {
  onStartOfTurn: () => void;
  onEndOfTurn: (confidence: number) => void;
  onInterim: (transcript: string) => void;
  onError: (err: Error) => void;
}

export interface FluxStreamingSTTDeps {
  createWs?: (url: string) => WebSocket;
}

export class FluxStreamingSTT {
  private ws: WebSocket | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly deps: FluxStreamingSTTDeps = {},
  ) {}

  connect(events: FluxStreamingSTTEvents): void {
    const params = new URLSearchParams({
      model: 'flux-general-en',
      eot_threshold: '0.7',
      eot_timeout_ms: '5000',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
    });
    const url = `wss://api.deepgram.com/v1/listen?${params}`;
    const createWs = this.deps.createWs ?? ((u) => new WebSocket(u, { headers: { Authorization: `Token ${this.apiKey}` } } as never));
    this.ws = createWs(url);

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as {
          type?: string;
          end_of_turn_confidence?: number;
          is_final?: boolean;
          channel?: { alternatives?: { transcript: string }[] };
        };
        if (data.type === 'StartOfTurn') {
          events.onStartOfTurn();
          return;
        }
        if (data.type === 'EndOfTurn') {
          events.onEndOfTurn(data.end_of_turn_confidence ?? 1.0);
          return;
        }
        const transcript = data.channel?.alternatives?.[0]?.transcript ?? '';
        if (transcript) events.onInterim(transcript);
      } catch {
        // non-JSON keepalive
      }
    };

    this.ws.onerror = () => events.onError(new Error('Flux WebSocket error'));
  }

  sendAudio(pcm: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcm);
    }
  }

  close(): void {
    if (this.ws) {
      try {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch {}
      this.ws = null;
    }
  }
}
```

- [ ] **Step 4.4: Run tests — must pass**

```bash
bun test test/services/voice/flux-streaming-stt.test.ts
```
Expected: all 5 pass.

- [ ] **Step 4.5: Commit**

```bash
git add src/services/voice/flux-streaming-stt.ts test/services/voice/flux-streaming-stt.test.ts
git commit -m "feat(voice): FluxStreamingSTT — Deepgram Flux EN WebSocket client with EOT events"
```

---

## Task 5: InterruptionClassifier

**Context:** LLM-based classifier (Haiku) adds 300-800ms latency per interim transcript — too slow for real-time voice. Replaced with zero-latency keyword rules.

**Rules:**
- `noise` — fewer than 2 words
- `resume` — 1-2 words that are known filler/acknowledgements (да, угу, ага, ок, нет, хорошо, понятно, ясно, продолжай, давай, yes, no, ok, okay, yeah, yep, mhm, sure, got it)
- `respond` — everything else (question, command, multiple words not in resume set)

`VAD_END` from Python → always `respond` (primary signal, handled in CallSession, not here).

**Files:**
- Create: `src/services/voice/interruption-classifier.ts`
- Create: `test/services/voice/interruption-classifier.test.ts`

### 5.1 Write failing tests

Create `test/services/voice/interruption-classifier.test.ts`:
```typescript
import { expect, test } from 'bun:test';
import { classifyInterrupt } from '../../../src/services/voice/interruption-classifier.ts';

test('noise: empty string', () => {
  expect(classifyInterrupt('')).toBe('noise');
});

test('noise: single non-filler word', () => {
  expect(classifyInterrupt('хм')).toBe('noise');
});

test('resume: single filler "да"', () => {
  expect(classifyInterrupt('да')).toBe('resume');
});

test('resume: single filler "угу"', () => {
  expect(classifyInterrupt('угу')).toBe('resume');
});

test('resume: two fillers "ага ок"', () => {
  expect(classifyInterrupt('ага ок')).toBe('resume');
});

test('resume: english filler "yeah"', () => {
  expect(classifyInterrupt('yeah')).toBe('resume');
});

test('respond: command with multiple words', () => {
  expect(classifyInterrupt('добавь встречу завтра')).toBe('respond');
});

test('respond: question', () => {
  expect(classifyInterrupt('что у меня сегодня')).toBe('respond');
});

test('respond: mixed filler + real word makes it respond', () => {
  // "да встречу" — not all fillers, has a non-filler second word
  expect(classifyInterrupt('да встречу')).toBe('respond');
});

test('respond: three single-word fillers → respond (3 words)', () => {
  // Resume rule only applies when ALL words are fillers AND word count <= 2
  expect(classifyInterrupt('да нет ок')).toBe('respond');
});
```

- [ ] **Step 5.2: Run failing tests**

```bash
bun test test/services/voice/interruption-classifier.test.ts
```
Expected: FAIL.

- [ ] **Step 5.3: Implement classifyInterrupt**

Create `src/services/voice/interruption-classifier.ts`:
```typescript
// src/services/voice/interruption-classifier.ts

export type InterruptionDecision = 'noise' | 'resume' | 'respond';

const RESUME_WORDS = new Set([
  // Russian
  'да', 'нет', 'угу', 'ага', 'ок', 'хорошо', 'понятно', 'ясно', 'продолжай', 'давай',
  // English
  'yes', 'no', 'ok', 'okay', 'yeah', 'yep', 'mhm', 'sure', 'got',
]);

/**
 * Classifies an interim STT transcript as noise, resume, or respond.
 * Called when the user speaks during active bot audio playback.
 * VAD_END → always 'respond' (handled in CallSession, not here).
 */
export function classifyInterrupt(transcript: string): InterruptionDecision {
  const words = transcript.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'noise';
  if (words.length === 1 && !RESUME_WORDS.has(words[0])) return 'noise';
  if (words.length <= 2 && words.every((w) => RESUME_WORDS.has(w))) return 'resume';
  return 'respond';
}
```

- [ ] **Step 5.4: Run tests — must pass**

```bash
bun test test/services/voice/interruption-classifier.test.ts
```
Expected: all 10 pass.

- [ ] **Step 5.5: Commit**

```bash
git add src/services/voice/interruption-classifier.ts test/services/voice/interruption-classifier.test.ts
git commit -m "feat(voice): InterruptionClassifier — rule-based zero-latency interruption detection"
```

---

## Task 6: ThinkingPhrasePlayer

**Files:**
- Create: `src/services/voice/thinking-phrase-player.ts`
- Create: `test/services/voice/thinking-phrase-player.test.ts`

### 6.1 Write failing tests

Create `test/services/voice/thinking-phrase-player.test.ts`:
```typescript
import { describe, expect, mock, test } from 'bun:test';
import { ThinkingPhrasePlayer } from '../../../src/services/voice/thinking-phrase-player.ts';

function makePlayer(lang: 'ru' | 'en' = 'ru') {
  const sendCmd = mock((_cmd: { type: string; file?: string }) => {});
  const player = new ThinkingPhrasePlayer(lang);
  return { player, sendCmd };
}

test('sends PLAY start phrase immediately on start()', () => {
  const { player, sendCmd } = makePlayer();
  player.start(sendCmd);
  expect(sendCmd).toHaveBeenCalledTimes(1);
  const call = (sendCmd.mock.calls[0] as [{ type: string; file?: string }])[0];
  expect(call.type).toBe('PLAY');
  expect(call.file).toMatch(/data\/call-phrases\/ru\/start_/);
  player.cancel();
});

test('cancel() prevents mid phrase timers from firing', async () => {
  const { player, sendCmd } = makePlayer();
  player.start(sendCmd, { midDelay1Ms: 10, midDelay2Ms: 20 });
  player.cancel();
  // Wait longer than the timers
  await new Promise((r) => setTimeout(r, 50));
  // Only the initial start phrase
  expect(sendCmd).toHaveBeenCalledTimes(1);
});

test('fires mid phrase after midDelay1Ms', async () => {
  const { player, sendCmd } = makePlayer();
  player.start(sendCmd, { midDelay1Ms: 30, midDelay2Ms: 10000 });
  await new Promise((r) => setTimeout(r, 50));
  player.cancel();
  expect(sendCmd).toHaveBeenCalledTimes(2);
  const secondCall = (sendCmd.mock.calls[1] as [{ type: string; file?: string }])[0];
  expect(secondCall.file).toMatch(/mid_/);
});

test('uses EN phrases for lang=en', () => {
  const { player, sendCmd } = makePlayer('en');
  player.start(sendCmd);
  const call = (sendCmd.mock.calls[0] as [{ type: string; file?: string }])[0];
  expect(call.file).toMatch(/data\/call-phrases\/en\/start_/);
  player.cancel();
});
```

- [ ] **Step 6.2: Run failing tests**

```bash
bun test test/services/voice/thinking-phrase-player.test.ts
```
Expected: FAIL.

- [ ] **Step 6.3: Implement ThinkingPhrasePlayer**

Create `src/services/voice/thinking-phrase-player.ts`:
```typescript
// src/services/voice/thinking-phrase-player.ts

const START_PHRASES: Record<string, string[]> = {
  ru: ['start_hmm', 'start_sec', 'start_look', 'start_think'],
  en: ['start_hmm', 'start_sec', 'start_look', 'start_think'],
};

const MID_PHRASES: Record<string, string[]> = {
  ru: ['mid_checking', 'mid_moment', 'mid_almost', 'mid_looking'],
  en: ['mid_checking', 'mid_moment', 'mid_almost', 'mid_looking'],
};

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function phrasePath(lang: string, name: string): string {
  return `data/call-phrases/${lang}/${name}.ogg`;
}

export interface ThinkingPhrasePlayerOpts {
  midDelay1Ms?: number;
  midDelay2Ms?: number;
}

export type SendCmd = (cmd: { type: string; file?: string }) => void;

export class ThinkingPhrasePlayer {
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(private readonly lang: 'ru' | 'en') {}

  start(sendCmd: SendCmd, opts: ThinkingPhrasePlayerOpts = {}): void {
    const midDelay1 = opts.midDelay1Ms ?? (3000 + Math.random() * 2000);
    const midDelay2 = opts.midDelay2Ms ?? (7000 + Math.random() * 3000);

    // t=0: play start phrase
    sendCmd({ type: 'PLAY', file: phrasePath(this.lang, randomFrom(START_PHRASES[this.lang])) });

    const t1 = setTimeout(() => {
      sendCmd({ type: 'PLAY', file: phrasePath(this.lang, randomFrom(MID_PHRASES[this.lang])) });
    }, midDelay1);

    const t2 = setTimeout(() => {
      sendCmd({ type: 'PLAY', file: phrasePath(this.lang, randomFrom(MID_PHRASES[this.lang])) });
    }, midDelay2);

    this.timers = [t1, t2];
  }

  cancel(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
```

- [ ] **Step 6.4: Run tests — must pass**

```bash
bun test test/services/voice/thinking-phrase-player.test.ts
```
Expected: all 4 pass.

- [ ] **Step 6.5: Commit**

```bash
git add src/services/voice/thinking-phrase-player.ts test/services/voice/thinking-phrase-player.test.ts
git commit -m "feat(voice): ThinkingPhrasePlayer — randomized thinking phrase scheduling during agent processing"
```

---

## Task 7: CallSession state machine

**Files:**
- Create: `src/services/voice/call-session.ts`
- Create: `test/services/voice/call-session.test.ts`

`CallSession` is the per-call state machine. It:
1. Receives WS messages from Python bridge
2. Routes binary frames to the active STT
3. On VAD_START: pauses playback, opens STT
4. On VAD_END: closes STT episode
5. On STT result triggering `respond`: plays thinking phrase, runs agent, plays response
6. On CALL_ENDED: cleans up all resources

### 7.1 Write failing tests

Create `test/services/voice/call-session.test.ts`:
```typescript
import { describe, expect, mock, test, beforeEach } from 'bun:test';
import { CallSession } from '../../../src/services/voice/call-session.ts';

function makeWsMock() {
  return {
    send: mock((_data: string | Buffer) => {}),
    close: mock(() => {}),
  };
}

function makeNovaMock() {
  return {
    connect: mock((_events: unknown) => {}),
    sendAudio: mock((_buf: Buffer) => {}),
    close: mock(() => {}),
  };
}

function makeThinkingMock() {
  return {
    start: mock((_sendCmd: unknown, _opts?: unknown) => {}),
    cancel: mock(() => {}),
  };
}

function makeAgentMock(responseText = 'Ответ бота') {
  return {
    run: mock(async () => ({ responseText })),
  };
}

function makeTtsMock(audio = Buffer.from('audio')) {
  return {
    synthesize: mock(async (_text: string, _lang: string) => audio),
  };
}

function makeSession(overrides: Partial<Parameters<typeof CallSession['create']>[0]> = {}) {
  const ws = makeWsMock();
  const nova = makeNovaMock();
  const thinking = makeThinkingMock();
  const agent = makeAgentMock();
  const tts = makeTtsMock();

  const session = CallSession.create({
    sessionId: 'test-session',
    userId: 42,
    language: 'ru',
    ws: ws as never,
    createNovaStt: () => nova as never,
    createFluxStt: () => ({ connect: mock(() => {}), sendAudio: mock(() => {}), close: mock(() => {}) } as never),
    createThinkingPlayer: () => thinking as never,
    agent: agent as never,
    tts,
    openerText: 'Привет! Чем могу помочь?',
    ...overrides,
  });

  return { session, ws, nova, thinking, agent, tts };
}

test('sends PLAY opener file on CALL_CONNECTED', async () => {
  const { session, ws, tts } = makeSession();
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  expect(tts.synthesize).toHaveBeenCalledWith('Привет! Чем могу помочь?', 'ru');
  const sends = ws.send.mock.calls.map((c) => (c as [string])[0]).map((s) => JSON.parse(s));
  expect(sends.some((s: { type: string }) => s.type === 'PLAY')).toBe(true);
});

test('sends PAUSE on VAD_START', async () => {
  const { session, ws } = makeSession();
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'VAD_START' }));
  const sends = ws.send.mock.calls.map((c) => JSON.parse((c as [string])[0]) as { type: string });
  expect(sends.some((s) => s.type === 'PAUSE')).toBe(true);
});

test('opens Nova-3 STT on VAD_START (RU)', async () => {
  const { session, nova } = makeSession();
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'VAD_START' }));
  expect(nova.connect).toHaveBeenCalledTimes(1);
});

test('forwards binary frames to Nova STT during speech', async () => {
  const { session, nova } = makeSession();
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'VAD_START' }));
  const pcm = Buffer.from([1, 2, 3, 4, 5]);
  session.handleBinaryMessage(pcm);
  expect(nova.sendAudio).toHaveBeenCalledWith(pcm);
});

test('deletes temp file on PLAY_DONE', async () => {
  const unlink = mock(async () => {});
  const { session } = makeSession({ unlink });
  // Simulate a temp file having been created
  (session as never as { lastPlayFile: string }).lastPlayFile = '/tmp/call-test-session-1.ogg';
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));
  expect(unlink).toHaveBeenCalledWith('/tmp/call-test-session-1.ogg');
});

test('CALL_ENDED triggers cleanup', async () => {
  const { session, nova } = makeSession();
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'CALL_ENDED' }));
  // Session should be in ended state — subsequent messages are ignored
  expect(session.isEnded()).toBe(true);
});
```

- [ ] **Step 7.2: Run failing tests**

```bash
bun test test/services/voice/call-session.test.ts
```
Expected: FAIL.

- [ ] **Step 7.3: Implement CallSession**

Create `src/services/voice/call-session.ts`:
```typescript
// src/services/voice/call-session.ts
import { unlink as fsUnlink } from 'node:fs/promises';
import type { CalendarBotAgent } from '../ai/agent.ts';
import type { AgentContext } from '../ai/types.ts';
import { voiceLogger } from './types.ts';
import type { FluxStreamingSTT } from './flux-streaming-stt.ts';
import type { InterruptionClassifier } from './interruption-classifier.ts';
import type { NovaStreamingSTT } from './nova-streaming-stt.ts';
import type { ThinkingPhrasePlayer } from './thinking-phrase-player.ts';

export interface CallSessionConfig {
  sessionId: string;
  userId: number;
  language: 'ru' | 'en';
  ws: { send: (data: string | Buffer) => void; close: () => void };
  createNovaStt: () => NovaStreamingSTT;
  createFluxStt: () => FluxStreamingSTT;
  createThinkingPlayer: () => ThinkingPhrasePlayer;
  createClassifier?: () => InterruptionClassifier;
  agent: { run: (ctx: AgentContext) => Promise<{ responseText?: string }> };
  tts: { synthesize: (text: string, lang: string) => Promise<Buffer> };
  openerText: string;
  agentContextBase?: Partial<AgentContext>;
  unlink?: (path: string) => Promise<void>;
}

export class CallSession {
  private ended = false;
  private speaking = false;
  private novaStt: NovaStreamingSTT | null = null;
  private fluxStt: FluxStreamingSTT | null = null;
  private thinking: ThinkingPhrasePlayer | null = null;
  private classifier: InterruptionClassifier | null = null;
  private fileSeq = 0;
  lastPlayFile: string | null = null;
  private rollingTranscript = '';

  private constructor(private readonly cfg: CallSessionConfig) {}

  static create(cfg: CallSessionConfig): CallSession {
    return new CallSession(cfg);
  }

  async handleMessage(data: string): Promise<void> {
    if (this.ended) return;
    let msg: { type: string };
    try {
      msg = JSON.parse(data) as { type: string };
    } catch {
      return;
    }

    switch (msg.type) {
      case 'CALL_CONNECTED':
        await this.onCallConnected();
        break;
      case 'VAD_START':
        this.onVadStart();
        break;
      case 'VAD_END':
        this.onVadEnd();
        break;
      case 'PLAY_DONE':
        await this.onPlayDone();
        break;
      case 'CALL_ENDED':
        this.onCallEnded();
        break;
    }
  }

  handleBinaryMessage(data: Buffer): void {
    if (!this.speaking) return;
    const pcm = data.slice(2); // strip 2-byte sequence number
    if (this.cfg.language === 'ru') {
      this.novaStt?.sendAudio(pcm);
    } else {
      this.fluxStt?.sendAudio(pcm);
    }
  }

  isEnded(): boolean {
    return this.ended;
  }

  forceEnd(): void {
    this.onCallEnded();
  }

  private async onCallConnected(): Promise<void> {
    voiceLogger.info({ sessionId: this.cfg.sessionId }, 'Call connected');
    // Set up Flux for EN (persistent WS for whole call)
    if (this.cfg.language === 'en') {
      this.fluxStt = this.cfg.createFluxStt();
      this.fluxStt.connect({
        onStartOfTurn: () => {},
        onEndOfTurn: (_confidence: number) => this.onEnoughToRespond(),
        onInterim: (t: string) => { this.rollingTranscript = t; },
        onError: (err: Error) => voiceLogger.warn({ err }, 'Flux STT error'),
      });
    }
    await this.playOpener();
  }

  private async playOpener(): Promise<void> {
    try {
      const audio = await this.cfg.tts.synthesize(this.cfg.openerText, this.cfg.language);
      const file = this.tempFile();
      await Bun.write(file, audio);
      this.sendPlay(file);
    } catch (err) {
      voiceLogger.error({ err, sessionId: this.cfg.sessionId }, 'Failed to synthesize opener');
    }
  }

  private onVadStart(): void {
    this.speaking = true;
    this.rollingTranscript = '';
    this.send(JSON.stringify({ type: 'PAUSE' }));

    if (this.cfg.language === 'ru') {
      this.novaStt = this.cfg.createNovaStt();
      this.novaStt.connect({
        onInterim: (t: string) => this.onNovaInterim(t),
        onFinal: (t: string) => { this.rollingTranscript = t; },
        onError: (err: Error) => voiceLogger.warn({ err }, 'Nova-3 STT error'),
      });
    }
  }

  private async onNovaInterim(transcript: string): Promise<void> {
    this.rollingTranscript = transcript;
    if (!this.classifier && this.cfg.createClassifier) {
      this.classifier = this.cfg.createClassifier();
    }
    if (!this.classifier) return;
    const decision = await this.classifier.classify(transcript, '');
    if (decision === 'respond') {
      this.onEnoughToRespond();
    } else if (decision === 'noise' || decision === 'resume') {
      this.send(JSON.stringify({ type: 'RESUME' }));
      this.closeSttEpisode();
    }
  }

  private onVadEnd(): void {
    this.speaking = false;
    if (this.cfg.language === 'ru') {
      this.novaStt?.close();
      this.novaStt = null;
    }
  }

  private onEnoughToRespond(): void {
    this.speaking = false;
    this.novaStt?.close();
    this.novaStt = null;

    const lang = this.cfg.language;
    this.thinking = this.cfg.createThinkingPlayer();
    this.thinking.start((cmd) => this.send(JSON.stringify(cmd)));

    const transcript = this.rollingTranscript;
    this.rollingTranscript = '';

    // Run agent and respond
    this.runAgent(transcript).catch((err) => {
      voiceLogger.error({ err, sessionId: this.cfg.sessionId }, 'Agent error during call');
    });
  }

  private async runAgent(transcript: string): Promise<void> {
    const ctx: AgentContext = {
      ...(this.cfg.agentContextBase ?? {}),
      user: { telegram_id: this.cfg.userId } as never,
      chatId: this.cfg.userId,
      messageText: transcript,
      inputMode: 'live_call',
      isGroup: false,
    } as AgentContext;

    const { responseText } = await this.cfg.agent.run(ctx);
    this.thinking?.cancel();
    this.thinking = null;

    if (!responseText) return;

    try {
      const audio = await this.cfg.tts.synthesize(responseText, this.cfg.language);
      const file = this.tempFile();
      await Bun.write(file, audio);
      this.sendPlay(file);
    } catch (err) {
      voiceLogger.error({ err }, 'TTS synthesis failed during call');
    }
  }

  private async onPlayDone(): Promise<void> {
    if (this.lastPlayFile) {
      const del = this.cfg.unlink ?? fsUnlink;
      await del(this.lastPlayFile).catch(() => {});
      this.lastPlayFile = null;
    }
  }

  private onCallEnded(): void {
    this.ended = true;
    this.speaking = false;
    this.thinking?.cancel();
    this.novaStt?.close();
    this.fluxStt?.close();
    voiceLogger.info({ sessionId: this.cfg.sessionId }, 'Call ended, session cleaned up');
  }

  private closeSttEpisode(): void {
    this.novaStt?.close();
    this.novaStt = null;
    this.speaking = false;
  }

  private sendPlay(file: string): void {
    this.lastPlayFile = file;
    this.send(JSON.stringify({ type: 'PLAY', file }));
  }

  private send(data: string): void {
    try {
      this.cfg.ws.send(data);
    } catch (err) {
      voiceLogger.warn({ err }, 'Failed to send WS message');
    }
  }

  private tempFile(): string {
    return `/tmp/call-${this.cfg.sessionId}-${++this.fileSeq}.ogg`;
  }
}
```

- [ ] **Step 7.4: Run tests — must pass**

```bash
bun test test/services/voice/call-session.test.ts
```
Expected: all 6 pass.

- [ ] **Step 7.5: Lint fix**

```bash
bun run lint:fix
```

- [ ] **Step 7.6: Commit**

```bash
git add src/services/voice/call-session.ts test/services/voice/call-session.test.ts
git commit -m "feat(voice): CallSession — per-call state machine: VAD routing, STT, classifier, thinking phrases, agent"
```

---

## Task 8: CallSessionManager + WebSocket server

**Files:**
- Create: `src/services/voice/call-session-manager.ts`
- Create: `test/services/voice/call-session-manager.test.ts`

`CallSessionManager` starts a `Bun.serve()` on `:3001`, accepts WS connections at `/call/:sessionId`, routes messages to the correct `CallSession`. Also enforces the 30-minute session timeout.

- [ ] **Step 8.1: Write failing tests**

Create `test/services/voice/call-session-manager.test.ts`:
```typescript
import { describe, expect, mock, test } from 'bun:test';
import { CallSessionManager } from '../../../src/services/voice/call-session-manager.ts';

function makeFakeSession() {
  return {
    handleMessage: mock(async (_data: string) => {}),
    handleBinaryMessage: mock((_data: Buffer) => {}),
    isEnded: mock(() => false),
  };
}

test('creates a session and retrieves it by sessionId', () => {
  const manager = new CallSessionManager({ createSession: (_id, _ws) => makeFakeSession() as never });
  const ws = { send: mock(() => {}), close: mock(() => {}) };
  manager.onWebSocketOpen('abc123', ws as never);
  expect(manager.getSession('abc123')).toBeDefined();
});

test('routes text message to session.handleMessage', async () => {
  const session = makeFakeSession();
  const manager = new CallSessionManager({ createSession: () => session as never });
  const ws = { send: mock(() => {}), close: mock(() => {}) };
  manager.onWebSocketOpen('sess1', ws as never);
  await manager.onWebSocketMessage('sess1', '{"type":"VAD_START"}', false);
  expect(session.handleMessage).toHaveBeenCalledWith('{"type":"VAD_START"}');
});

test('routes binary message to session.handleBinaryMessage', async () => {
  const session = makeFakeSession();
  const manager = new CallSessionManager({ createSession: () => session as never });
  const ws = { send: mock(() => {}), close: mock(() => {}) };
  manager.onWebSocketOpen('sess2', ws as never);
  const buf = Buffer.from([0, 1, 2, 3]);
  await manager.onWebSocketMessage('sess2', buf, true);
  expect(session.handleBinaryMessage).toHaveBeenCalledWith(buf);
});

test('removes session on close', () => {
  const manager = new CallSessionManager({ createSession: () => makeFakeSession() as never });
  const ws = { send: mock(() => {}), close: mock(() => {}) };
  manager.onWebSocketOpen('s3', ws as never);
  manager.onWebSocketClose('s3');
  expect(manager.getSession('s3')).toBeUndefined();
});

test('enforces 30-minute timeout', async () => {
  const ended = { value: false };
  const session = {
    handleMessage: mock(async () => {}),
    handleBinaryMessage: mock(() => {}),
    isEnded: () => ended.value,
    forceEnd: mock(() => { ended.value = true; }),
  };
  const manager = new CallSessionManager({
    createSession: () => session as never,
    timeoutMs: 50,
  });
  const ws = { send: mock(() => {}), close: mock(() => {}) };
  manager.onWebSocketOpen('s4', ws as never);
  await new Promise((r) => setTimeout(r, 80));
  expect(session.forceEnd).toHaveBeenCalled();
});
```

- [ ] **Step 8.2: Run failing tests**

```bash
bun test test/services/voice/call-session-manager.test.ts
```
Expected: FAIL.

- [ ] **Step 8.3: Implement CallSessionManager**

Create `src/services/voice/call-session-manager.ts`:
```typescript
// src/services/voice/call-session-manager.ts
import { voiceLogger } from './types.ts';

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export interface ManagedSession {
  handleMessage: (data: string) => Promise<void>;
  handleBinaryMessage: (data: Buffer) => void;
  isEnded: () => boolean;
  forceEnd?: () => void;
}

export interface CallSessionManagerDeps {
  createSession: (sessionId: string, ws: { send: (data: string) => void; close: () => void }) => ManagedSession;
  timeoutMs?: number;
}

export class CallSessionManager {
  private sessions = new Map<string, { session: ManagedSession; timer: ReturnType<typeof setTimeout> }>();
  private readonly timeoutMs: number;

  constructor(private readonly deps: CallSessionManagerDeps) {
    this.timeoutMs = deps.timeoutMs ?? SESSION_TIMEOUT_MS;
  }

  onWebSocketOpen(sessionId: string, ws: { send: (data: string) => void; close: () => void }): void {
    const session = this.deps.createSession(sessionId, ws);
    const timer = setTimeout(() => {
      voiceLogger.warn({ sessionId }, 'Session timeout — forcing end');
      session.forceEnd?.();
      ws.close();
      this.sessions.delete(sessionId);
    }, this.timeoutMs);

    this.sessions.set(sessionId, { session, timer });
    voiceLogger.info({ sessionId }, 'Call session opened');
  }

  async onWebSocketMessage(sessionId: string, data: string | Buffer, isBinary: boolean): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    if (isBinary) {
      entry.session.handleBinaryMessage(Buffer.isBuffer(data) ? data : Buffer.from(data as never));
    } else {
      await entry.session.handleMessage(data as string);
    }
  }

  onWebSocketClose(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.sessions.delete(sessionId);
    voiceLogger.info({ sessionId }, 'Call session closed');
  }

  getSession(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  /** Start the internal WebSocket server on :3001 */
  startServer(): void {
    Bun.serve({
      port: 3001,
      hostname: '127.0.0.1',
      fetch(req, server) {
        const url = new URL(req.url);
        const match = url.pathname.match(/^\/call\/([^/]+)$/);
        if (!match) return new Response('Not found', { status: 404 });
        const sessionId = match[1];
        const upgraded = server.upgrade(req, { data: { sessionId } });
        if (!upgraded) return new Response('Upgrade failed', { status: 426 });
        return undefined as unknown as Response;
      },
      websocket: {
        open: (ws) => {
          const { sessionId } = ws.data as { sessionId: string };
          this.onWebSocketOpen(sessionId, {
            send: (data) => ws.send(data),
            close: () => ws.close(),
          });
        },
        message: async (ws, message) => {
          const { sessionId } = ws.data as { sessionId: string };
          const isBinary = typeof message !== 'string';
          await this.onWebSocketMessage(sessionId, message as string | Buffer, isBinary);
        },
        close: (ws) => {
          const { sessionId } = ws.data as { sessionId: string };
          this.onWebSocketClose(sessionId);
        },
      },
    });
    voiceLogger.info({ port: 3001 }, 'Call WebSocket server started');
  }
}
```

- [ ] **Step 8.4: Run tests — must pass**

```bash
bun test test/services/voice/call-session-manager.test.ts
```
Expected: all 5 pass.

- [ ] **Step 8.5: Commit**

```bash
git add src/services/voice/call-session-manager.ts test/services/voice/call-session-manager.test.ts
git commit -m "feat(voice): CallSessionManager — WS server :3001, session registry, 30-min timeout"
```

---

## Task 9: CallManager — primary/fallback TTS + bidirectional support

**Files:**
- Modify: `src/services/voice/call-manager.ts`
- Modify: `src/services/voice/types.ts`
- Modify: `src/worker/call-queue.ts`
- Modify: `test/services/voice/call-manager.test.ts` (existing tests)

The existing `CallManager` uses `TtsService` directly. Per spec, for calls it should use Silero (RU) or Kokoro (EN) as primary, with `TtsService` as fallback.

Also, the call flow changes: instead of spawning Python, waiting for done, and returning — `CallManager` now spawns Python with `sessionId` and `language`, then lets `CallSessionManager` handle the rest. The Python bridge manages its own lifecycle.

- [ ] **Step 9.1: Update types**

In `src/services/voice/types.ts`, update `CallReminderJobData`:
```typescript
export interface CallReminderJobData {
  userId: number;
  eventId?: number;
  callLogId: number;
  ttsText: string;
  language: string;
  sessionId: string; // UUID generated by BullMQ enqueue
}
```

- [ ] **Step 9.2: Update call-queue.ts to generate sessionId**

In `src/worker/call-queue.ts`, in `enqueue()`:
```typescript
import { randomUUID } from 'node:crypto';
// ...
async enqueue(data: Omit<CallReminderJobData, 'sessionId'>): Promise<void> {
  await queue.add('call-reminder', { ...data, sessionId: randomUUID() }, { ... });
}
```

- [ ] **Step 9.3: Update CallManager**

In `src/services/voice/call-manager.ts`, update `CallManagerDeps`:
```typescript
export interface CallManagerDeps {
  primaryTts?: { synthesize: (text: string, lang: string) => Promise<Buffer> };  // Silero or Kokoro
  fallbackTts: { synthesize: (text: string, lang: string) => Promise<Buffer> };  // TtsService
  callLogRepo: {
    updateStatus: (id: number, status: CallStatus) => void;
    complete: (id: number, status: CallStatus, duration: number, error?: string) => void;
  };
  translateText?: (text: string, lang: string) => Promise<string>;
  sendVoiceMessage?: (userId: number, audio: Buffer) => Promise<void>;
  pyBridgePath: string;
  registerSession?: (sessionId: string, userId: number, language: string) => void;
  spawnProcess?: (cmd: string[], opts: { env: NodeJS.ProcessEnv; stdout: 'pipe'; stderr: 'pipe' }) => SpawnResult;
}
```

Update `executeCall()` to use `primaryTts` first, fall back to `fallbackTts`:
```typescript
let audioBuffer: Buffer;
try {
  if (this.deps.primaryTts) {
    audioBuffer = await this.deps.primaryTts.synthesize(textToSpeak, job.language);
  } else {
    throw new Error('no primary');
  }
} catch (primaryErr) {
  voiceLogger.warn({ err: primaryErr }, 'Primary TTS failed, using fallback');
  audioBuffer = await this.deps.fallbackTts.synthesize(textToSpeak, job.language);
}
```

Change the temp file to OGG (not MP3) and add ffmpeg conversion after TTS synthesis. The existing code writes to `/tmp/call-<callLogId>.mp3` — change to `/tmp/call-<callLogId>.ogg` and convert:

```typescript
// After getting audioBuffer from primaryTts or fallbackTts:
const mp3File = `/tmp/call-${job.callLogId}-raw.mp3`;
const oggFile = `/tmp/call-${job.callLogId}.ogg`;
await Bun.write(mp3File, audioBuffer);

const ffmpeg = Bun.spawn(['ffmpeg', '-y', '-i', mp3File, '-c:a', 'libopus', '-ar', '48000', '-ac', '1', oggFile]);
await ffmpeg.exited;
try { await (await import('node:fs/promises')).unlink(mp3File); } catch {}

const tmpFile = oggFile;
```

Important: `SileroTtsService` and `KokoroTtsService` already return OGG Opus — do NOT run ffmpeg on their output (ffmpeg would misinterpret an OGG file named `.mp3`). Only run the MP3→OGG conversion for `TtsService` (Google Translate) output. Use a flag to track which TTS was used:

```typescript
let usedFallback = false;
let audioBuffer: Buffer;
try {
  audioBuffer = await this.deps.primaryTts!.synthesize(textToSpeak, job.language);
} catch {
  audioBuffer = await this.deps.fallbackTts.synthesize(textToSpeak, job.language);
  usedFallback = true;
}
const oggFile = `/tmp/call-${job.callLogId}.ogg`;
if (usedFallback || !this.deps.primaryTts) {
  // TtsService returns MP3 — convert to OGG Opus for pytgcalls
  const mp3File = `/tmp/call-${job.callLogId}-raw.mp3`;
  await Bun.write(mp3File, audioBuffer);
  const ffmpeg = Bun.spawn(['ffmpeg', '-y', '-i', mp3File, '-c:a', 'libopus', '-ar', '48000', '-ac', '1', oggFile]);
  await ffmpeg.exited;
  try { await (await import('node:fs/promises')).unlink(mp3File); } catch {}
} else {
  // Silero/Kokoro already output OGG Opus
  await Bun.write(oggFile, audioBuffer);
}
const tmpFile = oggFile;
```

Update Python bridge spawn to include `sessionId` and `language`:
```typescript
const proc = spawn(
  ['venv/bin/python', this.deps.pyBridgePath, String(job.userId), job.sessionId, job.language],
  { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' },
);
```

Note: The bridge no longer takes a file argument (Bun sends PLAY via WebSocket), and duration is managed by CallSession's 30-min timeout. Remove the `audioDurationSec` argument.

- [ ] **Step 9.4: Add primary/fallback TTS regression tests**

In `test/services/voice/call-manager.test.ts`, add:
```typescript
test('uses primaryTts when available', async () => {
  const primaryTts = { synthesize: mock(async () => Buffer.from('audio')) };
  const fallbackTts = { synthesize: mock(async () => Buffer.from('fallback')) };
  const manager = makeCallManager({ primaryTts, fallbackTts });
  await manager.executeCall(makeJob());
  expect(primaryTts.synthesize).toHaveBeenCalledTimes(1);
  expect(fallbackTts.synthesize).toHaveBeenCalledTimes(0);
});

test('falls back to fallbackTts when primaryTts throws', async () => {
  const primaryTts = { synthesize: mock(async () => { throw new Error('silero down'); }) };
  const fallbackTts = { synthesize: mock(async () => Buffer.from('fallback')) };
  const manager = makeCallManager({ primaryTts, fallbackTts });
  await manager.executeCall(makeJob());
  expect(fallbackTts.synthesize).toHaveBeenCalledTimes(1);
});

test('uses fallbackTts when no primaryTts configured', async () => {
  const fallbackTts = { synthesize: mock(async () => Buffer.from('fallback')) };
  const manager = makeCallManager({ fallbackTts });
  await manager.executeCall(makeJob());
  expect(fallbackTts.synthesize).toHaveBeenCalledTimes(1);
});
```

(`makeCallManager` and `makeJob` are helpers to set up CallManager with mocked spawn and callLogRepo — add them following the existing test pattern in the file.)

- [ ] **Step 9.5: Run call-manager tests — must pass**

```bash
bun test test/services/voice/call-manager.test.ts
```
Fix any failures due to the interface changes.

- [ ] **Step 9.6: Run all tests**

```bash
bun test
```
Expected: all pass.

- [ ] **Step 9.7: Commit**

```bash
git add src/services/voice/call-manager.ts src/services/voice/types.ts src/worker/call-queue.ts test/services/voice/call-manager.test.ts
git commit -m "feat(voice): CallManager — primary/fallback TTS pattern; registerSession dep; sessionId+language to bridge"
```

---

## Task 10: Python bridge — bidirectional rewrite

**Files:**
- Rewrite: `scripts/voice-call-bridge.py`

This is the full rewrite. The existing bridge is a simple one-way player. The new bridge:
1. Accepts `user_id session_id language [opener_file]` args (opener_file no longer needed — Bun sends PLAY)
2. Connects to `ws://localhost:3001/call/<session_id>`
3. Initiates pytgcalls call, enters muted state
4. Sends `CALL_CONNECTED`
5. Runs Silero VAD on incoming 48kHz PCM
6. On speech: sends VAD_START + binary frames (48kHz for RU, 16kHz for EN) + VAD_END
7. Handles PLAY/PAUSE/RESUME/STOP from Bun
8. Sends PLAY_DONE when audio finishes
9. Sends CALL_ENDED when call ends

- [ ] **Step 10.1: Check existing VAD/pytgcalls dependencies**

```bash
venv/bin/pip list | grep -i silero
venv/bin/pip list | grep -i websockets
```

Install if missing:
```bash
venv/bin/pip install websockets torch silero-vad
```

`silero-vad` package (pip: `silero-vad`) provides `load_silero_vad()` function.
`websockets` provides async WS client.
`torch` needed for Silero.

- [ ] **Step 10.2: Write new voice-call-bridge.py**

```python
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
    playback_event = asyncio.Event()
    current_file: str | None = None
    paused = False
    call_ended = asyncio.Event()
    speaking = False
    seq_num = 0

    # ------- Connect to Bun WebSocket -------
    async with websockets.connect(WS_URL) as ws:

        async def recv_commands():
            """Receive PLAY/PAUSE/RESUME/STOP from Bun."""
            nonlocal current_file, paused, play_task

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
                    await calls.play(USER_ID, MediaStream(file_path, video_flags=MediaStream.Flags.IGNORE))

                    async def wait_done(f):
                        done_event = asyncio.Event()

                        @calls.on_update()
                        async def on_update(update):
                            if "StreamEnded" in type(update).__name__ or "StreamAudioEnded" in type(update).__name__:
                                done_event.set()

                        await done_event.wait()
                        await ws.send(json.dumps({"type": "PLAY_DONE"}))

                    play_task = asyncio.create_task(wait_done(file_path))

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
                        # pytgcalls ≥3.0: skip_stream cancels current audio without hanging up
                        await calls.skip_stream(USER_ID)
                    except Exception:
                        pass  # older pytgcalls may not have skip_stream; cancel of play_task is enough

        async def capture_audio():
            """Capture audio from pytgcalls and run VAD."""
            nonlocal speaking, seq_num

            audio_buffer = b""
            is_speaking = False

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
            if "Closed" in type(update).__name__ or "HungUp" in type(update).__name__:
                call_ended.set()

        # Connect to user (muted — no audio yet)
        try:
            await calls.play(
                USER_ID,
                MediaStream(None, video_flags=MediaStream.Flags.IGNORE,  # muted
                            audio_parameters=AudioQuality.HIGH),
            )
        except Exception as e:
            # play() with no file — just ring
            pass

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
```

Note: The exact pytgcalls API for audio capture (`on_stream_audio`, `AudioReceiver`) varies by version. Adjust to match the version installed in `venv/`. The pattern above is for pytgcalls ≥ 3.0. If audio capture is unavailable, check `venv/bin/pip show pytgcalls` for installed version and API docs.

- [ ] **Step 10.3: Manual smoke test**

With a real Telegram account in `data/voice_caller.session`, run:
```bash
# First start Bun bot (which starts CallSessionManager on :3001)
bun run src/index.ts &

# Trigger a call via the bot's BullMQ queue
# (or test manually by sending a session_id)
```

Expected: Python bridge connects to WS, initiates call, sends CALL_CONNECTED, receives PLAY with opener file, plays it.

- [ ] **Step 10.4: Commit**

```bash
git add scripts/voice-call-bridge.py
git commit -m "feat(voice): rewrite voice-call-bridge.py — bidirectional VAD+audio streaming via WebSocket"
```

---

## Task 11: Wire CallSessionManager into main index

**Files:**
- Modify: `src/index.ts`
- Modify: `src/services/voice/call-manager.ts` (spawn args update)

- [ ] **Step 11.1: Read src/index.ts**

Check where `CallManager` and `createCallWorker` are initialized to understand the injection point.

- [ ] **Step 11.2: Initialize CallSessionManager**

The session context (userId, language) must be available when `CallSessionManager.createSession()` fires (on WebSocket connect). The cleanest testable approach: `CallManager` receives a `registerSession` dep that is called before spawning Python. `CallSessionManager` stores the registered context in its own Map and looks it up in `createSession`.

In `src/services/voice/call-session-manager.ts`, add a `pendingSessions` Map and `registerSession()` method:
```typescript
private pendingSessions = new Map<string, { userId: number; language: string }>();

registerSession(sessionId: string, userId: number, language: string): void {
  this.pendingSessions.set(sessionId, { userId, language });
}
```

Update `createSession` in `CallSessionManager` to look up from `pendingSessions` and delete after use:
```typescript
onWebSocketOpen(sessionId: string, ws: ...): void {
  const ctx = this.pendingSessions.get(sessionId) ?? { userId: 0, language: 'ru' };
  this.pendingSessions.delete(sessionId);
  const session = this.deps.createSession(sessionId, ctx.userId, ctx.language as 'ru' | 'en', ws);
  // ...
}
```

Update `CallSessionManagerDeps.createSession` signature:
```typescript
createSession: (sessionId: string, userId: number, language: 'ru' | 'en', ws: ...) => ManagedSession;
```

In `src/index.ts`, add:
```typescript
import { CallSessionManager } from './services/voice/call-session-manager.ts';
import { CallSession } from './services/voice/call-session.ts';
import { NovaStreamingSTT } from './services/voice/nova-streaming-stt.ts';
import { FluxStreamingSTT } from './services/voice/flux-streaming-stt.ts';
import { ThinkingPhrasePlayer } from './services/voice/thinking-phrase-player.ts';
import { InterruptionClassifier } from './services/voice/interruption-classifier.ts';

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY ?? '';

const callSessionManager = new CallSessionManager({
  createSession: (sessionId, userId, language, ws) =>
    CallSession.create({
      sessionId,
      userId,
      language,
      ws,
      createNovaStt: () => new NovaStreamingSTT(DEEPGRAM_API_KEY),
      createFluxStt: () => new FluxStreamingSTT(DEEPGRAM_API_KEY),
      createThinkingPlayer: () => new ThinkingPhrasePlayer(language),
      createClassifier: () => new InterruptionClassifier(anthropic),
      agent: calendarBotAgent,
      tts: fallbackTts,
      openerText: language === 'ru' ? 'Привет! Чем могу помочь?' : 'Hello! How can I help you?',
      agentContextBase: {
        // Populate with the same repository deps used for message handler AgentContext.
        // Required fields: eventService, chatHistory, userRepo, reminderRepo, holidayService.
        // Optional but useful: contactRepo, invitationService, sharingService, etc.
        // Copy the pattern from buildAgentContextFactory(deps) in message.handler.ts.
        eventService,
        chatHistory,
        userRepo,
        reminderRepo,
        holidayService,
      },
    }),
});

callSessionManager.startServer();
```

Pass `registerSession` to `CallManager`:
```typescript
const callManager = new CallManager({
  primaryTts: sileroTts ?? kokoroTts,
  fallbackTts,
  callLogRepo,
  pyBridgePath: 'scripts/voice-call-bridge.py',
  registerSession: (sessionId, userId, language) =>
    callSessionManager.registerSession(sessionId, userId, language),
});
```

`CallManager.executeCall()` calls `this.deps.registerSession?.(job.sessionId, job.userId, job.language)` immediately before the `spawn()` call.

- [ ] **Step 11.3: Run all tests**

```bash
bun test
```
Expected: all pass.

- [ ] **Step 11.4: Lint**

```bash
bun run lint
```
Fix any warnings.

- [ ] **Step 11.5: Commit**

```bash
git add src/index.ts src/services/voice/call-manager.ts
git commit -m "feat(voice): wire CallSessionManager into main process — starts WS server :3001, wires agents"
```

---

## Task 12: End-to-end integration test (manual)

This task verifies the full bidirectional flow works with a real Telegram account.

- [ ] **Step 12.1: Generate thinking phrases**

```bash
bun run scripts/generate-call-phrases.ts
ls data/call-phrases/ru/
ls data/call-phrases/en/
```

Expected: 8 files per language directory.

- [ ] **Step 12.2: Start bot**

```bash
bun run src/index.ts
```

Verify in logs:
- `Call WebSocket server started` on port 3001

- [ ] **Step 12.3: Trigger test call**

Using the Telegram bot, use the `/call` command or schedule a call reminder for a user with `data/voice_caller.session`.

Expected call flow in logs:
1. `Call session opened` (sessionId)
2. `Call connected`
3. `Synthesizing TTS` (opener)
4. `PLAY` command sent to Python
5. User speaks → `VAD_START` logged
6. `PAUSE` sent to Python
7. Nova-3 or Flux transcription logged
8. `respond` decision
9. `Thinking phrase player started`
10. Agent runs, response logged
11. TTS synthesized
12. `PLAY` response file sent
13. `CALL_ENDED` → cleanup

- [ ] **Step 12.4: Final lint + test run**

```bash
bun run lint
bun test
```
Expected: 0 warnings, all tests pass.

- [ ] **Step 12.5: Commit**

```bash
git add -A
git commit -m "feat(voice): bidirectional voice calls — full integration (spec #09)"
```

---

## Deploy Notes

1. **Generate thinking phrases** on each server after deploy:
   ```bash
   bun run scripts/generate-call-phrases.ts
   ```

2. **Python dependencies** (in addition to existing pytgcalls deps):
   ```bash
   venv/bin/pip install websockets torch silero-vad
   ```

3. **DEEPGRAM_API_KEY** must be set in `.env`.

4. **Port 3001** must be internal-only (not exposed externally). The WS server binds to `127.0.0.1`.

5. **ntgcalls patch** still required for audio — see CLAUDE.md ntgcalls section.
