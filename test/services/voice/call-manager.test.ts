import { describe, expect, mock, test } from 'bun:test';
import { CallManager, type CallManagerDeps } from '../../../src/services/voice/call-manager';

function makeSpawn(output = 'PLAYING\nCALL_DONE\n') {
  return mock(() => ({
    stdout: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(output));
        c.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    }),
    exited: Promise.resolve(0),
  }));
}

function makeDeps(overrides: Partial<CallManagerDeps> = {}): CallManagerDeps {
  return {
    ttsService: { synthesize: mock(() => Promise.resolve(Buffer.from('fake-audio'))) },
    callLogRepo: {
      updateStatus: mock(() => {}),
      complete: mock(() => {}),
    },
    pyBridgePath: 'scripts/voice-call-bridge.py',
    spawnProcess: makeSpawn(),
    ...overrides,
  };
}

describe('CallManager', () => {
  test('executeCall synthesizes TTS first', async () => {
    const deps = makeDeps();
    const manager = new CallManager(deps);
    await manager.executeCall({
      userId: 100,
      callLogId: 1,
      ttsText: 'Meeting in 10 minutes',
      language: 'en',
    });
    expect(deps.ttsService.synthesize).toHaveBeenCalledWith('Meeting in 10 minutes', 'en');
  });

  test('executeCall calls translateText before synthesis when provided', async () => {
    const translateText = mock(() => Promise.resolve('Translated text'));
    const deps = makeDeps({ translateText });
    const manager = new CallManager(deps);
    await manager.executeCall({
      userId: 100,
      callLogId: 1,
      ttsText: 'Meeting in 10 minutes',
      language: 'ru',
    });
    expect(translateText).toHaveBeenCalledWith('Meeting in 10 minutes', 'ru');
    expect(deps.ttsService.synthesize).toHaveBeenCalledWith('Translated text', 'ru');
  });

  test('executeCall uses original text when translateText is not provided', async () => {
    const deps = makeDeps();
    const manager = new CallManager(deps);
    await manager.executeCall({
      userId: 100,
      callLogId: 1,
      ttsText: 'Hello',
      language: 'en',
    });
    expect(deps.ttsService.synthesize).toHaveBeenCalledWith('Hello', 'en');
  });

  test('executeCall logs failure on TTS error', async () => {
    const deps = makeDeps({
      ttsService: { synthesize: mock(() => Promise.reject(new Error('TTS failed'))) },
    });
    const manager = new CallManager(deps);
    await manager.executeCall({
      userId: 100,
      callLogId: 1,
      ttsText: 'Test',
      language: 'en',
    });
    expect(deps.callLogRepo.complete).toHaveBeenCalled();
    const call = (deps.callLogRepo.complete as ReturnType<typeof mock>).mock.calls[0]!;
    expect(call[1]).toBe('failed');
  });

  test('executeCall completes successfully with bridge', async () => {
    const deps = makeDeps();
    const manager = new CallManager(deps);
    await manager.executeCall({
      userId: 100,
      callLogId: 1,
      ttsText: 'Hello',
      language: 'en',
    });
    expect(deps.callLogRepo.complete).toHaveBeenCalled();
    const call = (deps.callLogRepo.complete as ReturnType<typeof mock>).mock.calls[0]!;
    expect(call[1]).toBe('completed');
  });

  test('executeCall does not call sendPostCallButtons', async () => {
    const postCallButtons = mock(() => Promise.resolve());
    const deps = makeDeps();
    const manager = new CallManager(deps);
    await manager.executeCall({
      userId: 100,
      callLogId: 1,
      ttsText: 'Hello',
      language: 'en',
    });
    expect(postCallButtons).not.toHaveBeenCalled();
  });
});
