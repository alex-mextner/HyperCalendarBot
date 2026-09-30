import { expect, type Mock, mock, test } from 'bun:test';
import { z } from 'zod';
import { CallSession, type CallSessionConfig, type CallTurn } from '../../../src/services/voice/call-session.ts';
import type { FluxStreamingSTTEvents } from '../../../src/services/voice/flux-streaming-stt.ts';
import type { NovaStreamingSTTEvents } from '../../../src/services/voice/nova-streaming-stt.ts';
import type { SendCmd, ThinkingPhrasePlayerOpts } from '../../../src/services/voice/thinking-phrase-player.ts';
import { jsonCodec } from '../../../src/utils/json-codec.ts';
import { flushPromises } from '../../helpers/mock-context.ts';

const SentCommandCodec = jsonCodec(z.object({ type: z.string(), file: z.string().optional() }));

interface WsMock {
  send: Mock<(data: string | Buffer) => void>;
  close: Mock<() => void>;
}

function makeWsMock(): WsMock {
  return {
    send: mock((_data: string | Buffer) => {}),
    close: mock(() => {}),
  };
}

/** Decodes every bridge command the session sent over the WebSocket. */
function sentCommands(ws: WsMock) {
  return ws.send.mock.calls.map(([data]) => SentCommandCodec.parse(data.toString()));
}

interface NovaMock {
  connect: Mock<(events: NovaStreamingSTTEvents) => void>;
  sendAudio: Mock<(buf: Buffer) => void>;
  close: Mock<() => void>;
}

function makeNovaMock(): NovaMock {
  return {
    connect: mock((_events: NovaStreamingSTTEvents) => {}),
    sendAudio: mock((_buf: Buffer) => {}),
    close: mock(() => {}),
  };
}

/** Events the session registered on its most recent Nova-3 connect. */
function novaEvents(nova: NovaMock): NovaStreamingSTTEvents {
  const call = nova.connect.mock.calls.at(-1);
  if (!call) throw new Error('Nova STT was never connected');
  return call[0];
}

function makeFluxMock() {
  return {
    connect: mock((_events: FluxStreamingSTTEvents) => {}),
    sendAudio: mock((_buf: Buffer) => {}),
    close: mock(() => {}),
  };
}

function makeThinkingMock() {
  return {
    start: mock((_sendCmd: SendCmd, _opts?: ThinkingPhrasePlayerOpts) => {}),
    cancel: mock(() => {}),
  };
}

function makeAgentMock(responseText = 'Ответ бота') {
  return {
    run: mock(async (_turn: CallTurn) => ({ responseText })),
  };
}

function makeTtsMock(audio = Buffer.from('audio')) {
  return {
    synthesize: mock(async (_text: string, _lang: string) => audio),
  };
}

function makeSession(overrides: Partial<CallSessionConfig> = {}) {
  const ws = makeWsMock();
  const nova = makeNovaMock();
  const thinking = makeThinkingMock();
  const agent = makeAgentMock();
  const tts = makeTtsMock();

  const session = CallSession.create({
    sessionId: 'test-session',
    userId: 42,
    language: 'ru',
    ws,
    createNovaStt: () => nova,
    createFluxStt: makeFluxMock,
    createThinkingPlayer: () => thinking,
    agent,
    tts,
    openerText: 'Привет! Чем могу помочь?',
    ...overrides,
  });

  return { session, ws, nova, thinking, agent, tts };
}

/** Opens a RU speech episode and fails its Nova-3 stream, which makes the session play the STT error phrase. */
async function failNovaStt(session: CallSession, nova: NovaMock): Promise<void> {
  await session.handleMessage(JSON.stringify({ type: 'VAD_START' }));
  novaEvents(nova).onError(new Error('Nova-3 WebSocket closed: code=1011 reason=internal'));
}

test('sends PLAY opener file on CALL_CONNECTED', async () => {
  const { session, ws, tts } = makeSession();
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  expect(tts.synthesize).toHaveBeenCalledWith('Привет! Чем могу помочь?', 'ru');
  expect(sentCommands(ws).some((s) => s.type === 'PLAY')).toBe(true);
});

test('greets generically on CALL_CONNECTED when the call has no opener text', async () => {
  const { session, tts } = makeSession({ language: 'en', openerText: '  ' });
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  expect(tts.synthesize.mock.calls[0]).toEqual(['Hello! How can I help you?', 'en']);
});

test('sends PAUSE on VAD_START', async () => {
  const { session, ws } = makeSession();
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'VAD_START' }));
  expect(sentCommands(ws).some((s) => s.type === 'PAUSE')).toBe(true);
});

test('opens Nova-3 STT on VAD_START (RU)', async () => {
  const { session, nova } = makeSession();
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'VAD_START' }));
  expect(nova.connect).toHaveBeenCalledTimes(1);
});

test('forwards binary frames to Nova STT during speech, stripping 2-byte seq_num header', async () => {
  const { session, nova } = makeSession();
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'VAD_START' }));
  // Bridge prepends a 2-byte big-endian seq_num header before PCM payload
  const pcm = Buffer.from([0x00, 0x01, 3, 4, 5]);
  session.handleBinaryMessage(pcm);
  expect(nova.sendAudio).toHaveBeenCalledWith(pcm.subarray(2));
});

test('deletes temp file on PLAY_DONE', async () => {
  const unlink = mock(async (_path: string) => {});
  const { session } = makeSession({ unlink });
  // The opener is written to the session's first temp file and played
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));
  expect(unlink).toHaveBeenCalledWith('/tmp/call-test-session-1.ogg');
});

test('sends RESUME after normal PLAY_DONE', async () => {
  const { session, ws } = makeSession();
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  ws.send.mockClear();
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));
  expect(sentCommands(ws).some((s) => s.type === 'RESUME')).toBe(true);
});

test('CALL_ENDED triggers cleanup', async () => {
  const { session } = makeSession();
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'CALL_ENDED' }));
  expect(session.isEnded()).toBe(true);
});

test('STT error phrase sends STOP then PLAY immediately when nothing is playing', async () => {
  const { session, ws, nova } = makeSession();
  await failNovaStt(session, nova);
  const sends = sentCommands(ws);
  const stopIdx = sends.findIndex((s) => s.type === 'STOP');
  const play = sends.find((s) => s.type === 'PLAY' && s.file?.includes('stt_error.ogg'));
  expect(stopIdx).toBeGreaterThanOrEqual(0);
  expect(play).toBeDefined();
  expect(sends.indexOf(play!)).toBeGreaterThan(stopIdx);
});

test('STT error phrase queues when something is playing, then plays on PLAY_DONE', async () => {
  const unlink = mock(async (_path: string) => {});
  const { session, ws, nova } = makeSession({ unlink });
  // The opener is still playing
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'VAD_START' }));
  ws.send.mockClear();

  novaEvents(nova).onError(new Error('Nova-3 WebSocket closed: code=1011 reason=internal'));
  // Nothing should be sent yet (queued)
  expect(ws.send.mock.calls.length).toBe(0);

  // PLAY_DONE fires — error phrase should now play (with STOP before PLAY)
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));
  const sends = sentCommands(ws);
  const stopIdx = sends.findIndex((s) => s.type === 'STOP');
  const play = sends.find((s) => s.type === 'PLAY' && s.file?.includes('stt_error.ogg'));
  expect(stopIdx).toBeGreaterThanOrEqual(0);
  expect(play).toBeDefined();
  expect(sends.indexOf(play!)).toBeGreaterThan(stopIdx);
});

test('Nova STT onError triggers error phrase', async () => {
  const { session, ws, nova } = makeSession();

  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'VAD_START' }));
  ws.send.mockClear();

  novaEvents(nova).onError(new Error('Nova-3 WebSocket closed: code=1008 reason=Unauthorized'));
  // Error phrase is queued because opener was playing; PLAY_DONE triggers it
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));

  expect(sentCommands(ws).some((s) => s.type === 'PLAY' && s.file?.includes('stt_error.ogg'))).toBe(true);
});

test('Flux STT onError triggers error phrase (EN)', async () => {
  const flux = makeFluxMock();
  const { session, ws } = makeSession({
    language: 'en',
    createFluxStt: () => flux,
  });

  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  ws.send.mockClear();

  flux.connect.mock.calls[0]![0].onError(new Error('Flux WebSocket closed: code=1008 reason=Unauthorized'));
  // Opener may still be "playing" — PLAY_DONE triggers the queued error phrase
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));

  const play = sentCommands(ws).find((s) => s.type === 'PLAY' && s.file?.includes('stt_error.ogg'));
  expect(play?.file).toContain('en/stt_error.ogg');
});

test('STT error phrase closes WS on PLAY_DONE (immediate play case)', async () => {
  const { session, ws, nova } = makeSession();
  await failNovaStt(session, nova);
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));
  expect(ws.close).toHaveBeenCalledTimes(1);
});

test('STT error phrase closes WS on second PLAY_DONE (queued case)', async () => {
  const unlink = mock(async (_path: string) => {});
  const { session, ws, nova } = makeSession({ unlink });
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));

  await failNovaStt(session, nova);
  // First PLAY_DONE: opener finishes → error phrase starts playing
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));
  expect(ws.close).not.toHaveBeenCalled();
  // Second PLAY_DONE: error phrase finishes → WS closes
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));
  expect(ws.close).toHaveBeenCalledTimes(1);
});

test('onCallEnded prevents WS close from error phrase PLAY_DONE', async () => {
  const { session, ws, nova } = makeSession();
  await failNovaStt(session, nova);
  await session.handleMessage(JSON.stringify({ type: 'CALL_ENDED' }));
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));
  expect(ws.close).not.toHaveBeenCalled();
});

test('force-ends call via timeout if PLAY_DONE never arrives after STT error', async () => {
  const { session, ws, nova } = makeSession({ sttErrorTimeoutMs: 10 });
  await failNovaStt(session, nova);
  await new Promise((r) => setTimeout(r, 30));
  expect(ws.close).toHaveBeenCalledTimes(1);
});

test('timeout is cancelled when call ends normally via CALL_ENDED', async () => {
  const { session, ws, nova } = makeSession({ sttErrorTimeoutMs: 10 });
  await failNovaStt(session, nova);
  await session.handleMessage(JSON.stringify({ type: 'CALL_ENDED' }));
  await new Promise((r) => setTimeout(r, 30));
  // ws.close not called by timeout (CALL_ENDED already cleaned up)
  expect(ws.close).not.toHaveBeenCalled();
});

test('agent does not run when transcript is empty (false VAD trigger)', async () => {
  const agent = makeAgentMock();
  const { session } = makeSession({ agent });

  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'VAD_START' }));
  // VAD_END fires immediately with no transcript (noise burst)
  await session.handleMessage(JSON.stringify({ type: 'VAD_END' }));
  await new Promise((r) => setTimeout(r, 20));

  expect(agent.run).not.toHaveBeenCalled();
});

test('TTS receives markdown-stripped text', async () => {
  const tts = makeTtsMock();
  const agent = makeAgentMock('**Готово!** Событие *встреча* добавлено на `завтра`.');
  const nova = makeNovaMock();
  const { session } = makeSession({ agent, tts, createNovaStt: () => nova });

  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'VAD_START' }));
  // Simulate Nova providing a final transcript before VAD_END
  novaEvents(nova).onFinal('добавь встречу на завтра');
  await session.handleMessage(JSON.stringify({ type: 'VAD_END' }));
  await new Promise((r) => setTimeout(r, 20));

  const agentCall = tts.synthesize.mock.calls.find(([text]) => text.includes('Готово'));
  expect(agentCall?.[0]).toBe('Готово! Событие встреча добавлено на завтра.');
});

test('agent runs only once when VAD_END follows classify respond', async () => {
  const nova = makeNovaMock();
  const agent = makeAgentMock();
  const { session } = makeSession({ createNovaStt: () => nova, agent });

  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'VAD_START' }));

  // Fire an interim that classifies as 'respond' (3+ words, not all fillers)
  novaEvents(nova).onInterim('добавь встречу на завтра');
  // Flush microtasks to let any async work settle
  await flushPromises();

  // VAD_END arrives — should be ignored since we already responded
  await session.handleMessage(JSON.stringify({ type: 'VAD_END' }));
  await flushPromises();

  // Agent should have been called exactly once
  expect(agent.run).toHaveBeenCalledTimes(1);
});
