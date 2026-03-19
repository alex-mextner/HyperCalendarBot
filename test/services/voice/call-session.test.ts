import { expect, mock, test } from 'bun:test';
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

function makeSession(overrides: Partial<Parameters<(typeof CallSession)['create']>[0]> = {}) {
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
    createFluxStt: () => ({ connect: mock(() => {}), sendAudio: mock(() => {}), close: mock(() => {}) }) as never,
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
  const unlink = mock(async () => {});
  const { session } = makeSession({ unlink });
  // Simulate a temp file having been created
  (session as never as { lastPlayFile: string }).lastPlayFile = '/tmp/call-test-session-1.ogg';
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));
  expect(unlink).toHaveBeenCalledWith('/tmp/call-test-session-1.ogg');
});

test('sends RESUME after normal PLAY_DONE', async () => {
  const { session, ws } = makeSession();
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  ws.send.mockClear();
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));
  const sends = ws.send.mock.calls.map((c) => JSON.parse((c as [string])[0]) as { type: string });
  expect(sends.some((s) => s.type === 'RESUME')).toBe(true);
});

test('CALL_ENDED triggers cleanup', async () => {
  const { session } = makeSession();
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'CALL_ENDED' }));
  expect(session.isEnded()).toBe(true);
});

test('playErrorPhrase sends STOP then PLAY immediately when nothing is playing', async () => {
  const { session, ws } = makeSession();
  (session as never as { playErrorPhrase: () => void }).playErrorPhrase();
  const sends = ws.send.mock.calls.map((c) => JSON.parse((c as [string])[0]) as { type: string; file?: string });
  const stopIdx = sends.findIndex((s) => s.type === 'STOP');
  const play = sends.find((s) => s.type === 'PLAY' && s.file?.includes('stt_error.ogg'));
  expect(stopIdx).toBeGreaterThanOrEqual(0);
  expect(play).toBeDefined();
  expect(sends.indexOf(play!)).toBeGreaterThan(stopIdx);
});

test('playErrorPhrase queues when something is playing, then plays on PLAY_DONE', async () => {
  const unlink = mock(async () => {});
  const { session, ws } = makeSession({ unlink });
  // Simulate something already playing
  (session as never as { lastPlayFile: string }).lastPlayFile = '/tmp/call-test-session-1.ogg';

  (session as never as { playErrorPhrase: () => void }).playErrorPhrase();
  // Nothing should be sent yet (queued)
  expect(ws.send.mock.calls.length).toBe(0);

  // PLAY_DONE fires — error phrase should now play (with STOP before PLAY)
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));
  const sends = ws.send.mock.calls.map((c) => JSON.parse((c as [string])[0]) as { type: string; file?: string });
  const stopIdx = sends.findIndex((s) => s.type === 'STOP');
  const play = sends.find((s) => s.type === 'PLAY' && s.file?.includes('stt_error.ogg'));
  expect(stopIdx).toBeGreaterThanOrEqual(0);
  expect(play).toBeDefined();
  expect(sends.indexOf(play!)).toBeGreaterThan(stopIdx);
});

test('Nova STT onError triggers error phrase', async () => {
  const nova = makeNovaMock();
  let capturedOnError: ((err: Error) => void) | undefined;
  nova.connect = mock((events: { onError: (err: Error) => void }) => {
    capturedOnError = events.onError;
  }) as unknown as typeof nova.connect;
  const { session, ws } = makeSession({ createNovaStt: () => nova as never });

  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'VAD_START' }));
  ws.send.mockClear();

  capturedOnError?.(new Error('Nova-3 WebSocket closed: code=1008 reason=Unauthorized'));
  // Error phrase is queued because opener was playing; PLAY_DONE triggers it
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));

  const sends = ws.send.mock.calls.map((c) => JSON.parse((c as [string])[0]) as { type: string; file?: string });
  expect(sends.some((s) => s.type === 'PLAY' && s.file?.includes('stt_error.ogg'))).toBe(true);
});

test('Flux STT onError triggers error phrase (EN)', async () => {
  let capturedOnError: ((err: Error) => void) | undefined;
  const fluxMock = {
    connect: mock((events: { onError: (err: Error) => void }) => {
      capturedOnError = events.onError;
    }),
    sendAudio: mock(() => {}),
    close: mock(() => {}),
  };
  const { session, ws } = makeSession({
    language: 'en',
    createFluxStt: () => fluxMock as never,
  });

  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  ws.send.mockClear();

  capturedOnError?.(new Error('Flux WebSocket closed: code=1008 reason=Unauthorized'));
  // Opener may still be "playing" — PLAY_DONE triggers the queued error phrase
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));

  const sends = ws.send.mock.calls.map((c) => JSON.parse((c as [string])[0]) as { type: string; file?: string });
  const play = sends.find((s) => s.type === 'PLAY' && s.file?.includes('stt_error.ogg'));
  expect(play?.file).toContain('en/stt_error.ogg');
});

test('playErrorPhrase closes WS on PLAY_DONE (immediate play case)', async () => {
  const { session, ws } = makeSession();
  (session as never as { playErrorPhrase: () => void }).playErrorPhrase();
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));
  expect(ws.close).toHaveBeenCalledTimes(1);
});

test('playErrorPhrase closes WS on second PLAY_DONE (queued case)', async () => {
  const unlink = mock(async () => {});
  const { session, ws } = makeSession({ unlink });
  (session as never as { lastPlayFile: string }).lastPlayFile = '/tmp/call-test-session-1.ogg';

  (session as never as { playErrorPhrase: () => void }).playErrorPhrase();
  // First PLAY_DONE: opener finishes → error phrase starts playing
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));
  expect(ws.close).not.toHaveBeenCalled();
  // Second PLAY_DONE: error phrase finishes → WS closes
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));
  expect(ws.close).toHaveBeenCalledTimes(1);
});

test('onCallEnded prevents WS close from error phrase PLAY_DONE', async () => {
  const { session, ws } = makeSession();
  (session as never as { playErrorPhrase: () => void }).playErrorPhrase();
  await session.handleMessage(JSON.stringify({ type: 'CALL_ENDED' }));
  await session.handleMessage(JSON.stringify({ type: 'PLAY_DONE' }));
  expect(ws.close).not.toHaveBeenCalled();
});

test('force-ends call via timeout if PLAY_DONE never arrives after STT error', async () => {
  const { session, ws } = makeSession({ sttErrorTimeoutMs: 10 });
  (session as never as { playErrorPhrase: () => void }).playErrorPhrase();
  await new Promise((r) => setTimeout(r, 30));
  expect(ws.close).toHaveBeenCalledTimes(1);
});

test('timeout is cancelled when call ends normally via CALL_ENDED', async () => {
  const { session, ws } = makeSession({ sttErrorTimeoutMs: 10 });
  (session as never as { playErrorPhrase: () => void }).playErrorPhrase();
  await session.handleMessage(JSON.stringify({ type: 'CALL_ENDED' }));
  await new Promise((r) => setTimeout(r, 30));
  // ws.close not called by timeout (CALL_ENDED already cleaned up)
  expect(ws.close).not.toHaveBeenCalled();
});

test('agent does not run when transcript is empty (false VAD trigger)', async () => {
  const agent = makeAgentMock();
  const { session } = makeSession({ agent: agent as never });

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
  let onFinalCb: ((t: string) => void) | undefined;
  nova.connect = mock((events: { onFinal: (t: string) => void }) => {
    onFinalCb = events.onFinal;
  }) as unknown as typeof nova.connect;
  const { session } = makeSession({ agent: agent as never, tts, createNovaStt: () => nova as never });

  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'VAD_START' }));
  // Simulate Nova providing a final transcript before VAD_END
  onFinalCb?.('добавь встречу на завтра');
  await session.handleMessage(JSON.stringify({ type: 'VAD_END' }));
  await new Promise((r) => setTimeout(r, 20));

  const calls = tts.synthesize.mock.calls as [string, string][];
  const agentCall = calls.find(([text]) => text.includes('Готово'));
  expect(agentCall?.[0]).toBe('Готово! Событие встреча добавлено на завтра.');
});

test('agent runs only once when VAD_END follows classify respond', async () => {
  const nova = makeNovaMock();
  let interimCallback: ((t: string) => void) | null = null;
  nova.connect = mock((events: { onInterim: (t: string) => void }) => {
    interimCallback = events.onInterim;
  }) as unknown as typeof nova.connect;
  const agent = makeAgentMock();
  const { session } = makeSession({ createNovaStt: () => nova as never, agent: agent as never });

  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'VAD_START' }));

  // Fire an interim that classifies as 'respond' (3+ words, not all fillers)
  (interimCallback as ((t: string) => void) | null)?.('добавь встречу на завтра');
  // Small delay to let any async work settle
  await new Promise((r) => setTimeout(r, 10));

  // VAD_END arrives — should be ignored since we already responded
  await session.handleMessage(JSON.stringify({ type: 'VAD_END' }));
  await new Promise((r) => setTimeout(r, 10));

  // Agent should have been called exactly once
  expect(agent.run).toHaveBeenCalledTimes(1);
});
