import { describe, expect, mock, test } from 'bun:test';
import { CallSignaling, type CallSignalingDeps } from '../../../src/services/voice/call-signaling';

describe('CallSignaling', () => {
  test('initiateCall validates user_id', async () => {
    const deps: CallSignalingDeps = {
      callRaw: mock(() => Promise.reject(new Error('should not be called'))),
    };
    const signaling = new CallSignaling(deps);
    await expect(signaling.initiateCall(0)).rejects.toThrow('Invalid user_id');
  });

  test('initiateCall calls phone.requestCall', async () => {
    const deps: CallSignalingDeps = {
      callRaw: mock(() =>
        Promise.resolve({
          _: 'phone.phoneCall',
          phone_call: {
            _: 'phoneCallWaiting',
            id: 12345n,
            access_hash: 67890n,
          },
        }),
      ),
    };
    const signaling = new CallSignaling(deps);
    const result = await signaling.initiateCall(100);
    expect(result.callId).toBeDefined();
    expect(deps.callRaw).toHaveBeenCalled();
  });

  test('discardCall sends phone.discardCall', async () => {
    const deps: CallSignalingDeps = {
      callRaw: mock(() => Promise.resolve({ _: 'updates' })),
    };
    const signaling = new CallSignaling(deps);
    await signaling.discardCall(12345n, 67890n);
    expect(deps.callRaw).toHaveBeenCalled();
  });
});
