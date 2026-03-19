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
  const { session } = makeSession();
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'CALL_ENDED' }));
  expect(session.isEnded()).toBe(true);
});

test('agent runs only once when VAD_END follows classify respond', async () => {
  const nova = makeNovaMock();
  let interimCallback: ((t: string) => void) | null = null;
  nova.connect = mock((events: { onInterim: (t: string) => void }) => {
    interimCallback = events.onInterim;
  });
  const agent = makeAgentMock();
  const { session } = makeSession({ createNovaStt: () => nova as never, agent: agent as never });

  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'VAD_START' }));

  // Fire an interim that classifies as 'respond' (3+ words, not all fillers)
  interimCallback?.('добавь встречу на завтра');
  // Small delay to let any async work settle
  await new Promise((r) => setTimeout(r, 10));

  // VAD_END arrives — should be ignored since we already responded
  await session.handleMessage(JSON.stringify({ type: 'VAD_END' }));
  await new Promise((r) => setTimeout(r, 10));

  // Agent should have been called exactly once
  expect(agent.run).toHaveBeenCalledTimes(1);
});
