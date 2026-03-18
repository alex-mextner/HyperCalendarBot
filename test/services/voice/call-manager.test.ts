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
    sendPostCallButtons: mock(() => Promise.resolve()),
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
      eventId: 1,
      callLogId: 1,
      ttsText: 'Meeting in 10 minutes',
      language: 'en',
    });
    expect(deps.ttsService.synthesize).toHaveBeenCalledWith('Meeting in 10 minutes', 'en');
  });

  test('executeCall logs failure on TTS error', async () => {
    const deps = makeDeps({
      ttsService: { synthesize: mock(() => Promise.reject(new Error('TTS failed'))) },
    });
    const manager = new CallManager(deps);
    await manager.executeCall({
      userId: 100,
      eventId: 1,
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
      eventId: 1,
      callLogId: 1,
      ttsText: 'Hello',
      language: 'en',
    });
    expect(deps.callLogRepo.complete).toHaveBeenCalled();
    expect(deps.sendPostCallButtons).toHaveBeenCalledWith(100, 1);
  });
});
