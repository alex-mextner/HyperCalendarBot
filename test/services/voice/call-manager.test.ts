import { expect, mock, test } from 'bun:test';
import { CallManager, type CallManagerDeps } from '../../../src/services/voice/call-manager';
import { CallSession } from '../../../src/services/voice/call-session.ts';
import { CallSessionManager } from '../../../src/services/voice/call-session-manager.ts';

type SpawnProcess = NonNullable<CallManagerDeps['spawnProcess']>;
type CallLogRepo = CallManagerDeps['callLogRepo'];

function closedStream() {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.close();
    },
  });
}

function makeSpawn(exitCode = 0) {
  return mock((..._args: Parameters<SpawnProcess>) => ({
    stdout: closedStream(),
    stderr: closedStream(),
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

function makeCallLogRepo() {
  return {
    updateStatus: mock((..._args: Parameters<CallLogRepo['updateStatus']>) => {}),
    complete: mock((..._args: Parameters<CallLogRepo['complete']>) => {}),
  };
}

function makeDeps(overrides: Partial<CallManagerDeps> = {}): CallManagerDeps {
  return {
    callLogRepo: makeCallLogRepo(),
    pyBridgePath: 'scripts/voice-call-bridge.py',
    registerSession: mock((..._args: Parameters<CallManagerDeps['registerSession']>) => {}),
    spawnProcess: makeSpawn(),
    ...overrides,
  };
}

test('the live call opens by speaking the queued reminder text, translated to the call language', async () => {
  const SESSION_ID = 'reminder-session-5000000001';
  const spoken: string[] = [];
  const sessions = new CallSessionManager({
    createSession: (sessionId, userId, language, ws, openerText) =>
      CallSession.create({
        sessionId,
        userId,
        language,
        ws,
        createNovaStt: () => ({ connect: () => {}, sendAudio: () => {}, close: () => {} }),
        createFluxStt: () => ({ connect: () => {}, sendAudio: () => {}, close: () => {} }),
        createThinkingPlayer: () => ({ start: () => {}, cancel: () => {} }),
        agent: { run: async () => ({ responseText: 'unused' }) },
        tts: {
          synthesize: async (text: string) => {
            spoken.push(text);
            return Buffer.from('audio');
          },
        },
        openerText,
        unlink: async () => {},
      }),
  });
  const bridgeCommands: string[] = [];
  // The bridge dials the user, connects to the session WebSocket and reports the call as answered.
  const bridge = (..._args: Parameters<SpawnProcess>) => {
    sessions.onWebSocketOpen(SESSION_ID, {
      send: (data) => {
        bridgeCommands.push(data.toString());
      },
      close: () => {},
    });
    const answered = sessions
      .onWebSocketMessage(SESSION_ID, JSON.stringify({ type: 'CALL_CONNECTED' }), false)
      .then(() => sessions.onWebSocketMessage(SESSION_ID, JSON.stringify({ type: 'CALL_ENDED' }), false));
    return { stdout: closedStream(), stderr: closedStream(), exited: answered.then(() => 0) };
  };
  const manager = new CallManager(
    makeDeps({
      translateText: async (text, lang) =>
        lang === 'ru' && text === 'Standup in 10 minutes' ? 'Стендап через 10 минут' : text,
      registerSession: (sessionId, userId, language, openerText) =>
        sessions.registerSession(sessionId, userId, language, openerText),
      spawnProcess: bridge,
    }),
  );

  await manager.executeCall(
    makeJob({ userId: 5000000001, ttsText: 'Standup in 10 minutes', language: 'ru', sessionId: SESSION_ID }),
  );

  expect(spoken[0]).toBe('Стендап через 10 минут');
  expect(bridgeCommands.some((cmd) => cmd.includes('"PLAY"'))).toBe(true);
});

test('registers the original reminder text when no translator is configured', async () => {
  const deps = makeDeps();
  const manager = new CallManager(deps);
  await manager.executeCall(makeJob({ userId: 5000000001, ttsText: 'Hello', sessionId: 'sess-abc' }));
  expect(deps.registerSession).toHaveBeenCalledWith('sess-abc', 5000000001, 'en', 'Hello');
});

test('a failed translation fails the call and tells the user', async () => {
  const callLogRepo = makeCallLogRepo();
  const notifyUser = mock((_userId: number, _msg: string) => {});
  const spawnProcess = makeSpawn(0);
  const deps = makeDeps({
    translateText: () => Promise.reject(new Error('translator down')),
    callLogRepo,
    notifyUser,
    spawnProcess,
  });
  const manager = new CallManager(deps);
  await manager.executeCall(makeJob({ userId: 5000000001, language: 'en' }));
  expect(spawnProcess).not.toHaveBeenCalled();
  expect(callLogRepo.complete.mock.calls[0]?.[1]).toBe('failed');
  expect(notifyUser).toHaveBeenCalledWith(5000000001, expect.stringContaining("Couldn't reach you by call"));
});

test('executeCall completes successfully when bridge exits with 0', async () => {
  const callLogRepo = makeCallLogRepo();
  const deps = makeDeps({ spawnProcess: makeSpawn(0), callLogRepo });
  const manager = new CallManager(deps);
  await manager.executeCall(makeJob());
  expect(callLogRepo.complete).toHaveBeenCalled();
  const call = callLogRepo.complete.mock.calls[0]!;
  expect(call[1]).toBe('completed');
});

test('executeCall marks failed when bridge exits non-zero', async () => {
  const callLogRepo = makeCallLogRepo();
  const deps = makeDeps({ spawnProcess: makeSpawn(1), callLogRepo });
  const manager = new CallManager(deps);
  await manager.executeCall(makeJob());
  const call = callLogRepo.complete.mock.calls[0]!;
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

test('notifyUser not called on successful call', async () => {
  const notifyUser = mock(() => {});
  const deps = makeDeps({ spawnProcess: makeSpawn(0), notifyUser });
  const manager = new CallManager(deps);
  await manager.executeCall(makeJob());
  expect(notifyUser).not.toHaveBeenCalled();
});

test('spawns bridge with userId, sessionId, language args', async () => {
  const spawnProcess = makeSpawn();
  const deps = makeDeps({ spawnProcess });
  const manager = new CallManager(deps);
  await manager.executeCall(makeJob({ userId: 42, sessionId: 'my-session', language: 'ru' }));
  const args = spawnProcess.mock.calls[0]![0];
  expect(args).toContain('42');
  expect(args).toContain('my-session');
  expect(args).toContain('ru');
});
