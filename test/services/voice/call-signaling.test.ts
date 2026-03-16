import { describe, expect, mock, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { CallSignaling, type CallSignalingDeps } from '../../../src/services/voice/call-signaling';

// RFC 3526 2048-bit MODP group — valid safe prime for DH exchange tests
const RFC_3526_PRIME_HEX =
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1' +
  '29024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
  'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245' +
  'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D' +
  'C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F' +
  '83655D23DCA3AD961C62F356208552BB9ED529077096966D' +
  '670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
  'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9' +
  'DE2BCBF6955817183995497CEA956AE515D2261898FA0510' +
  '15728E5A8AACAA68FFFFFFFFFFFFFFFF';

function validDhConfig() {
  return {
    g: 2,
    p: Buffer.from(RFC_3526_PRIME_HEX, 'hex'),
    random: randomBytes(256),
  };
}

function makeDeps(): CallSignalingDeps {
  let callCount = 0;
  return {
    callRaw: mock(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve(validDhConfig());
      if (callCount === 2) return Promise.resolve({ phone_call: { id: 12345n, access_hash: 67890n } });
      return Promise.resolve({ _: 'updates' });
    }),
  };
}

describe('CallSignaling', () => {
  test('initiateCall validates user_id', async () => {
    const deps: CallSignalingDeps = {
      callRaw: mock(() => Promise.reject(new Error('should not be called'))),
    };
    const signaling = new CallSignaling(deps);
    await expect(signaling.initiateCall(0)).rejects.toThrow('Invalid user_id');
  });

  test('initiateCall fetches DH config and calls phone.requestCall', async () => {
    const deps = makeDeps();
    const signaling = new CallSignaling(deps);
    const result = await signaling.initiateCall(100);
    expect(result.callId).toBe(12345n);
    expect(result.accessHash).toBe(67890n);
    // Two calls: getDhConfig + requestCall
    expect(deps.callRaw).toHaveBeenCalledTimes(2);
  });

  test('initiateCall sends proper g_a_hash (32 bytes SHA-256)', async () => {
    const deps = makeDeps();
    const signaling = new CallSignaling(deps);
    await signaling.initiateCall(100);
    const requestCallPayload = (deps.callRaw as ReturnType<typeof mock>).mock.calls[1]![0] as Record<string, unknown>;
    expect(requestCallPayload._).toBe('phone.requestCall');
    const gAHash = requestCallPayload.gAHash as Buffer;
    expect(gAHash).toBeInstanceOf(Buffer);
    expect(gAHash.length).toBe(32);
    // Should NOT be all zeros (unlike the old placeholder)
    expect(gAHash.every((b: number) => b === 0)).toBe(false);
  });

  test('discardCall sends phone.discardCall', async () => {
    const deps: CallSignalingDeps = {
      callRaw: mock(() => Promise.resolve({ _: 'updates' })),
    };
    const signaling = new CallSignaling(deps);
    await signaling.discardCall(12345n, 67890n);
    expect(deps.callRaw).toHaveBeenCalled();
    const payload = (deps.callRaw as ReturnType<typeof mock>).mock.calls[0]![0] as Record<string, unknown>;
    expect(payload._).toBe('phone.discardCall');
  });

  test('confirmCall fails without prior initiateCall', async () => {
    const deps: CallSignalingDeps = {
      callRaw: mock(() => Promise.resolve({})),
    };
    const signaling = new CallSignaling(deps);
    await expect(signaling.confirmCall(1n, 2n, randomBytes(256))).rejects.toThrow('No pending exchange');
  });

  test('discardCall clears pending exchange', async () => {
    const deps = makeDeps();
    const signaling = new CallSignaling(deps);
    await signaling.initiateCall(100);
    await signaling.discardCall(12345n, 67890n);
    // After discard, confirmCall should fail
    await expect(signaling.confirmCall(12345n, 67890n, randomBytes(256))).rejects.toThrow('No pending exchange');
  });

  test('reuses cached DH config for second call', async () => {
    let callCount = 0;
    const deps: CallSignalingDeps = {
      callRaw: mock(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(validDhConfig());
        // All subsequent: phone.requestCall responses
        return Promise.resolve({ phone_call: { id: BigInt(callCount), access_hash: 1n } });
      }),
    };
    const signaling = new CallSignaling(deps);
    await signaling.initiateCall(100); // getDhConfig + requestCall = 2 calls
    await signaling.initiateCall(200); // only requestCall = 1 call (cached config)
    expect(deps.callRaw).toHaveBeenCalledTimes(3); // 1 getDhConfig + 2 requestCall
  });
});
