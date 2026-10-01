import { expect, type Mock, mock, spyOn, test } from 'bun:test';
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

/** Resolves once the session sends `ws` a command matching `expected`. */
function commandSent(ws: WsMock, expected: { type: string; file?: string }): Promise<void> {
  const sent = Promise.withResolvers<void>();
  ws.send.mockImplementation((data) => {
    const cmd = SentCommandCodec.parse(data.toString());
    if (cmd.type === expected.type && (expected.file === undefined || cmd.file === expected.file)) sent.resolve();
  });
  return sent.promise;
}

/** Plays the opener to completion, then has the RU caller say `transcript`, which starts one agent turn. */
async function sayAfterOpener(session: CallSession, nova: NovaMock, transcript: string): Promise<void> {
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));
  await session.handleMessage(JSON.stringify({ type: 'VAD_START' }));
  novaEvents(nova).onFinal(transcript);
  await session.handleMessage(JSON.stringify({ type: 'VAD_END' }));
}

test('a silent caller hears a spoken check-in and the agent never answers it', async () => {
  const agent = makeAgentMock();
  const { session, ws, tts } = makeSession({ agent, inactivityMs: 1 });
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  const checkInPlayed = commandSent(ws, { type: 'PLAY' });
  ws.send.mockClear();
  // The opener finishes: the idle timer starts and fires with nobody speaking.
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));
  await checkInPlayed;

  expect(tts.synthesize.mock.calls.at(-1)).toEqual(['Ты ещё здесь? Могу ещё чем-то помочь?', 'ru']);
  expect(sentCommands(ws)).toContainEqual({ type: 'PLAY', file: '/tmp/call-test-session-2.ogg' });
  expect(agent.run).not.toHaveBeenCalled();
  await session.handleMessage(JSON.stringify({ type: 'CALL_ENDED' }));
});

test('the session resumes listening after its check-in finishes playing', async () => {
  const { session, ws } = makeSession({ inactivityMs: 1 });
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  const checkInPlayed = commandSent(ws, { type: 'PLAY', file: '/tmp/call-test-session-2.ogg' });
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));
  await checkInPlayed;

  ws.send.mockClear();
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));
  expect(sentCommands(ws)).toContainEqual({ type: 'RESUME' });
  await session.handleMessage(JSON.stringify({ type: 'CALL_ENDED' }));
});

test('end_call with nothing to say hangs up without waiting for a PLAY_DONE', async () => {
  const nova = makeNovaMock();
  const agent = { run: mock(async (_turn: CallTurn) => ({ endCall: true })) };
  const { session, ws } = makeSession({ agent, createNovaStt: () => nova });

  await sayAfterOpener(session, nova, 'всё, спасибо, пока');
  await flushPromises();

  expect(agent.run).toHaveBeenCalledTimes(1);
  expect(ws.close).toHaveBeenCalledTimes(1);
  expect(session.isEnded()).toBe(true);
});

test('end_call whose goodbye fails to synthesize hangs up at once', async () => {
  const nova = makeNovaMock();
  const agent = { run: mock(async (_turn: CallTurn) => ({ responseText: 'Пока!', endCall: true })) };
  const tts = {
    synthesize: mock(async (text: string, _lang: string) => {
      if (text === 'Пока!') throw new Error('TTS down');
      return Buffer.from('audio');
    }),
  };
  const { session, ws } = makeSession({ agent, tts, createNovaStt: () => nova });

  await sayAfterOpener(session, nova, 'всё, спасибо, пока');
  await flushPromises();

  expect(tts.synthesize).toHaveBeenCalledWith('Пока!', 'ru');
  expect(ws.close).toHaveBeenCalledTimes(1);
  expect(session.isEnded()).toBe(true);
});

test('end_call with a spoken goodbye hangs up only after the goodbye finishes playing', async () => {
  const nova = makeNovaMock();
  const agent = { run: mock(async (_turn: CallTurn) => ({ responseText: 'Пока!', endCall: true })) };
  const { session, ws } = makeSession({ agent, createNovaStt: () => nova });
  const goodbyePlayed = commandSent(ws, { type: 'PLAY', file: '/tmp/call-test-session-2.ogg' });

  await sayAfterOpener(session, nova, 'всё, спасибо, пока');
  await goodbyePlayed;
  expect(ws.close).not.toHaveBeenCalled();

  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));
  expect(ws.close).toHaveBeenCalledTimes(1);
});

const CHECK_IN_TEXT = 'Ты ещё здесь? Могу ещё чем-то помочь?';

test('a check-in that fails to synthesize is tried again at the next idle timeout', async () => {
  const tts = {
    synthesize: mock(async (text: string, _lang: string) => {
      if (text === CHECK_IN_TEXT) throw new Error('TTS down');
      return Buffer.from('audio');
    }),
  };
  const { session } = makeSession({ tts, inactivityMs: 1 });
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));

  await Bun.sleep(40);

  expect(tts.synthesize.mock.calls.filter(([text]) => text === CHECK_IN_TEXT).length).toBeGreaterThanOrEqual(2);
  await session.handleMessage(JSON.stringify({ type: 'CALL_ENDED' }));
});

test('a check-in whose synthesis finishes after the caller started speaking is not played over them', async () => {
  let finishCheckIn: (audio: Buffer) => void = () => {};
  const checkInAudio = new Promise<Buffer>((resolve) => {
    finishCheckIn = resolve;
  });
  const tts = {
    synthesize: mock(async (text: string, _lang: string) => (text === CHECK_IN_TEXT ? checkInAudio : Buffer.from('a'))),
  };
  const { session, ws } = makeSession({ tts, inactivityMs: 1 });
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));
  await Bun.sleep(20);
  expect(tts.synthesize).toHaveBeenCalledWith(CHECK_IN_TEXT, 'ru');

  await session.handleMessage(JSON.stringify({ type: 'VAD_START' }));
  finishCheckIn(Buffer.from('check-in'));
  await flushPromises();

  expect(sentCommands(ws).filter((cmd) => cmd.type === 'PLAY')).toEqual([
    { type: 'PLAY', file: '/tmp/call-test-session-1.ogg' },
  ]);
  await session.handleMessage(JSON.stringify({ type: 'CALL_ENDED' }));
});

test('an English check-in is not played over a caller whose Flux turn has started', async () => {
  const flux = makeFluxMock();
  let finishCheckIn: (audio: Buffer) => void = () => {};
  const checkInAudio = new Promise<Buffer>((resolve) => {
    finishCheckIn = resolve;
  });
  const tts = {
    synthesize: mock(async (text: string, _lang: string) =>
      text.startsWith('Are you still there') ? checkInAudio : Buffer.from('a'),
    ),
  };
  const { session, ws } = makeSession({ language: 'en', tts, createFluxStt: () => flux, inactivityMs: 1 });
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));
  await Bun.sleep(20);
  expect(tts.synthesize.mock.calls.some(([text]) => text.startsWith('Are you still there'))).toBe(true);

  const events = flux.connect.mock.calls.at(-1)?.[0];
  if (!events) throw new Error('Flux STT was never connected');
  events.onStartOfTurn();
  finishCheckIn(Buffer.from('check-in'));
  await flushPromises();

  expect(sentCommands(ws).filter((cmd) => cmd.type === 'PLAY')).toEqual([
    { type: 'PLAY', file: '/tmp/call-test-session-1.ogg' },
  ]);
  await session.handleMessage(JSON.stringify({ type: 'CALL_ENDED' }));
});

test('a check-in whose synthesis finishes while the agent reply is playing is dropped', async () => {
  const nova = makeNovaMock();
  let finishCheckIn: (audio: Buffer) => void = () => {};
  const checkInAudio = new Promise<Buffer>((resolve) => {
    finishCheckIn = resolve;
  });
  const tts = {
    synthesize: mock(async (text: string, _lang: string) => (text === CHECK_IN_TEXT ? checkInAudio : Buffer.from('a'))),
  };
  const { session, ws } = makeSession({ tts, createNovaStt: () => nova, inactivityMs: 1 });
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));
  await Bun.sleep(20);
  expect(tts.synthesize).toHaveBeenCalledWith(CHECK_IN_TEXT, 'ru');

  // The caller takes a whole turn and the agent's reply starts playing; its PLAY_DONE has not come yet.
  await session.handleMessage(JSON.stringify({ type: 'VAD_START' }));
  novaEvents(nova).onFinal('расскажи что-нибудь');
  await session.handleMessage(JSON.stringify({ type: 'VAD_END' }));
  await flushPromises();
  finishCheckIn(Buffer.from('check-in'));
  await flushPromises();

  expect(sentCommands(ws).filter((cmd) => cmd.type === 'PLAY')).toEqual([
    { type: 'PLAY', file: '/tmp/call-test-session-1.ogg' },
    { type: 'PLAY', file: '/tmp/call-test-session-2.ogg' },
  ]);
  await session.handleMessage(JSON.stringify({ type: 'CALL_ENDED' }));
});

test('a reply whose synthesis finishes after the call ended is not played', async () => {
  const nova = makeNovaMock();
  let finishReply: (audio: Buffer) => void = () => {};
  const replyAudio = new Promise<Buffer>((resolve) => {
    finishReply = resolve;
  });
  const tts = {
    synthesize: mock(async (text: string, _lang: string) => (text === 'Ответ бота' ? replyAudio : Buffer.from('a'))),
  };
  const { session, ws } = makeSession({ tts, createNovaStt: () => nova });

  await sayAfterOpener(session, nova, 'расскажи что-нибудь');
  await session.handleMessage(JSON.stringify({ type: 'CALL_ENDED' }));
  ws.send.mockClear();
  finishReply(Buffer.from('late'));
  await flushPromises();

  expect(sentCommands(ws)).toEqual([]);
});

test('a check-in is dropped and its file removed when the caller starts speaking while it is being written', async () => {
  const nova = makeNovaMock();
  const unlink = mock(async (_path: string) => {});
  const { session, ws } = makeSession({ createNovaStt: () => nova, unlink, inactivityMs: 1 });
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));
  // The opener's file is gone; only the check-in's file is written from here on.
  unlink.mockClear();

  let finishWrite: () => void = () => {};
  const written = new Promise<void>((resolve) => {
    finishWrite = resolve;
  });
  const write = spyOn(Bun, 'write').mockImplementation(async () => {
    await written;
    return 0;
  });
  try {
    await Bun.sleep(20);
    expect(write).toHaveBeenCalledTimes(1);
    await session.handleMessage(JSON.stringify({ type: 'VAD_START' }));
    finishWrite();
    await flushPromises();

    expect(sentCommands(ws).filter((cmd) => cmd.type === 'PLAY')).toEqual([
      { type: 'PLAY', file: '/tmp/call-test-session-1.ogg' },
    ]);
    expect(unlink).toHaveBeenCalledWith('/tmp/call-test-session-2.ogg');
  } finally {
    write.mockRestore();
    await session.handleMessage(JSON.stringify({ type: 'CALL_ENDED' }));
  }
});
