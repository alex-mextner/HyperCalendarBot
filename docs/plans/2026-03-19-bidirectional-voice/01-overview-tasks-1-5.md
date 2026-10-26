> Part 1 of 3 of [Bidirectional Voice Calls Implementation Plan](../2026-03-19-bidirectional-voice.md) — next: [02-tasks-6-8.md](02-tasks-6-8.md)

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

