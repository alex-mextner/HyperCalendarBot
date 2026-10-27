> Part 2 of 3 of [Bidirectional Voice Calls Implementation Plan](../2026-03-19-bidirectional-voice.md) — previous: [01-overview-tasks-1-5.md](01-overview-tasks-1-5.md) · next: [03-tasks-9-12.md](03-tasks-9-12.md)

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

