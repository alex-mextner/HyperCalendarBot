import { expect, mock, test } from 'bun:test';
import { CallManager, type CallManagerDeps } from '../../../src/services/voice/call-manager';

function makeSpawn(exitCode = 0) {
  return mock(() => ({
    stdout: new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    }),
    exited: Promise.resolve(exitCode),
  }));
}

function makeJob(
  overrides: Partial<{ userId: number; callLogId: number; ttsText: string; language: string; sessionId: string }> = {},
) {
  return {
    userId: 100,
    callLogId: 1,
    ttsText: 'Meeting in 10 minutes',
    language: 'en',
    sessionId: 'test-session-uuid',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<CallManagerDeps> = {}): CallManagerDeps {
  return {
    fallbackTts: { synthesize: mock(() => Promise.resolve(Buffer.from('fake-audio'))) },
    callLogRepo: {
      updateStatus: mock(() => {}),
      complete: mock(() => {}),
    },
    pyBridgePath: 'scripts/voice-call-bridge.py',
    spawnProcess: makeSpawn(),
    ...overrides,
  };
}

test('executeCall synthesizes with fallbackTts when no primaryTts', async () => {
  const deps = makeDeps();
  const manager = new CallManager(deps);
  await manager.executeCall(makeJob());
  expect(deps.fallbackTts.synthesize).toHaveBeenCalledWith('Meeting in 10 minutes', 'en');
});

test('executeCall calls translateText before synthesis when provided', async () => {
  const translateText = mock(() => Promise.resolve('Translated text'));
  const deps = makeDeps({ translateText });
  const manager = new CallManager(deps);
  await manager.executeCall(makeJob({ language: 'ru' }));
  expect(translateText).toHaveBeenCalledWith('Meeting in 10 minutes', 'ru');
  expect(deps.fallbackTts.synthesize).toHaveBeenCalledWith('Translated text', 'ru');
});

test('executeCall uses original text when translateText is not provided', async () => {
  const deps = makeDeps();
  const manager = new CallManager(deps);
  await manager.executeCall(makeJob({ ttsText: 'Hello' }));
  expect(deps.fallbackTts.synthesize).toHaveBeenCalledWith('Hello', 'en');
});

test('executeCall logs failure on TTS error', async () => {
  const deps = makeDeps({
    fallbackTts: { synthesize: mock(() => Promise.reject(new Error('TTS failed'))) },
  });
  const manager = new CallManager(deps);
  await manager.executeCall(makeJob());
  expect(deps.callLogRepo.complete).toHaveBeenCalled();
  const call = (deps.callLogRepo.complete as ReturnType<typeof mock>).mock.calls[0]!;
  expect(call[1]).toBe('failed');
});

test('executeCall completes successfully when bridge exits with 0', async () => {
  const deps = makeDeps({ spawnProcess: makeSpawn(0) });
  const manager = new CallManager(deps);
  await manager.executeCall(makeJob());
  expect(deps.callLogRepo.complete).toHaveBeenCalled();
  const call = (deps.callLogRepo.complete as ReturnType<typeof mock>).mock.calls[0]!;
  expect(call[1]).toBe('completed');
});

test('executeCall marks failed when bridge exits non-zero', async () => {
  const deps = makeDeps({ spawnProcess: makeSpawn(1) });
  const manager = new CallManager(deps);
  await manager.executeCall(makeJob());
  const call = (deps.callLogRepo.complete as ReturnType<typeof mock>).mock.calls[0]!;
  expect(call[1]).toBe('failed');
});

test('notifyUser called with EN message when bridge exits non-zero', async () => {
  const notifyUser = mock(() => {});
  const deps = makeDeps({ spawnProcess: makeSpawn(1), notifyUser });
  const manager = new CallManager(deps);
  await manager.executeCall(makeJob({ userId: 42, language: 'en' }));
  expect(notifyUser).toHaveBeenCalledTimes(1);
  expect(notifyUser).toHaveBeenCalledWith(42, expect.stringContaining("Couldn't reach you by call"));
});

test('notifyUser called with RU message when bridge exits non-zero', async () => {
  const notifyUser = mock(() => {});
  const deps = makeDeps({ spawnProcess: makeSpawn(1), notifyUser });
  const manager = new CallManager(deps);
  await manager.executeCall(makeJob({ userId: 7, language: 'ru' }));
  expect(notifyUser).toHaveBeenCalledWith(7, expect.stringContaining('Не удалось дозвониться'));
});

test('notifyUser called when TTS throws', async () => {
  const notifyUser = mock(() => {});
  const deps = makeDeps({
    fallbackTts: { synthesize: mock(() => Promise.reject(new Error('TTS down'))) },
    notifyUser,
  });
  const manager = new CallManager(deps);
  await manager.executeCall(makeJob({ userId: 42, language: 'en' }));
  expect(notifyUser).toHaveBeenCalledTimes(1);
  expect(notifyUser).toHaveBeenCalledWith(42, expect.stringContaining("Couldn't reach you by call"));
});

test('notifyUser not called on successful call', async () => {
  const notifyUser = mock(() => {});
  const deps = makeDeps({ spawnProcess: makeSpawn(0), notifyUser });
  const manager = new CallManager(deps);
  await manager.executeCall(makeJob());
  expect(notifyUser).not.toHaveBeenCalled();
});

test('uses primaryTts when available', async () => {
  const primaryTts = { synthesize: mock(async () => Buffer.from('audio')) };
  const fallbackTts = { synthesize: mock(async () => Buffer.from('fallback')) };
  const deps = makeDeps({ primaryTts, fallbackTts });
  const manager = new CallManager(deps);
  await manager.executeCall(makeJob());
  expect(primaryTts.synthesize).toHaveBeenCalledTimes(1);
  expect(fallbackTts.synthesize).toHaveBeenCalledTimes(0);
});

test('falls back to fallbackTts when primaryTts throws', async () => {
  const primaryTts = {
    synthesize: mock(async () => {
      throw new Error('silero down');
    }),
  };
  const fallbackTts = { synthesize: mock(async () => Buffer.from('fallback')) };
  const deps = makeDeps({ primaryTts, fallbackTts });
  const manager = new CallManager(deps);
  await manager.executeCall(makeJob());
  expect(fallbackTts.synthesize).toHaveBeenCalledTimes(1);
});

test('calls registerSession before spawning bridge', async () => {
  const registerSession = mock(() => {});
  const deps = makeDeps({ registerSession });
  const manager = new CallManager(deps);
  await manager.executeCall(makeJob({ sessionId: 'sess-abc' }));
  expect(registerSession).toHaveBeenCalledWith('sess-abc', 100, 'en');
});

test('spawns bridge with userId, sessionId, language args', async () => {
  const spawnProcess = makeSpawn();
  const deps = makeDeps({ spawnProcess });
  const manager = new CallManager(deps);
  await manager.executeCall(makeJob({ userId: 42, sessionId: 'my-session', language: 'ru' }));
  const args = (spawnProcess as ReturnType<typeof mock>).mock.calls[0]![0] as string[];
  expect(args).toContain('42');
  expect(args).toContain('my-session');
  expect(args).toContain('ru');
});
