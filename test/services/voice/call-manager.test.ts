// test/services/voice/call-manager.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { CallManager, type CallManagerDeps } from '../../../src/services/voice/call-manager';

function makeDeps(overrides: Partial<CallManagerDeps> = {}): CallManagerDeps {
  return {
    ttsService: { synthesize: mock(() => Promise.resolve(Buffer.from('fake-audio'))) },
    callSignaling: {
      initiateCall: mock(() => Promise.resolve({ callId: 1n, accessHash: 2n })),
      discardCall: mock(() => Promise.resolve()),
    },
    callLogRepo: {
      updateStatus: mock(() => {}),
      complete: mock(() => {}),
    },
    sendPostCallButtons: mock(() => Promise.resolve()),
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

  test('executeCall initiates call after TTS', async () => {
    const deps = makeDeps();
    const manager = new CallManager(deps);
    await manager.executeCall({
      userId: 100,
      eventId: 1,
      callLogId: 1,
      ttsText: 'Test',
      language: 'en',
    });
    expect(deps.callSignaling.initiateCall).toHaveBeenCalledWith(100);
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
    const args = (deps.callLogRepo.complete as ReturnType<typeof mock>).mock.calls[0] as unknown[];
    expect(args[1]).toBe('failed');
  });

  test('executeCall sends post-call buttons', async () => {
    const deps = makeDeps();
    const manager = new CallManager(deps);
    await manager.executeCall({
      userId: 100,
      eventId: 1,
      callLogId: 1,
      ttsText: 'Test',
      language: 'en',
    });
    expect(deps.sendPostCallButtons).toHaveBeenCalledWith(100, 1);
  });

  test('executeCall discards call on error', async () => {
    const deps = makeDeps({
      callSignaling: {
        initiateCall: mock(() => Promise.reject(new Error('User offline'))),
        discardCall: mock(() => Promise.resolve()),
      },
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
  });
});
