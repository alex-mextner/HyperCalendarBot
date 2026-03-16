import { describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  buildAcceptCallPayload,
  buildConfirmCallPayload,
  buildDiscardCallPayload,
  buildGetDhConfigPayload,
  buildRequestCallPayload,
  CallState,
  calleeDeriveKey,
  calleeInitExchange,
  callerDeriveKey,
  callerInitExchange,
  computeEmojiFingerprint,
  type DhConfig,
  DhExchangeError,
  DiscardReason,
  VoiceCallDhExchange,
} from '../../../src/services/voice-call/dh-exchange';

// ---------------------------------------------------------------------------
// Test DH config — a known 2048-bit safe prime (from RFC 3526, group 14).
// Telegram uses its own primes, but for testing any safe prime works.
// ---------------------------------------------------------------------------

// This is the 2048-bit MODP group from RFC 3526
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

function createTestDhConfig(): DhConfig {
  const p = Buffer.from(RFC_3526_PRIME_HEX, 'hex');
  return {
    g: 2,
    p,
    random: randomBytes(256),
  };
}

// ---------------------------------------------------------------------------
// Functional tests
// ---------------------------------------------------------------------------

describe('DH exchange — low-level functions', () => {
  test('callerInitExchange produces valid g_a and g_a_hash', () => {
    const dhConfig = createTestDhConfig();
    const result = callerInitExchange(dhConfig);

    expect(result.gA.length).toBe(256);
    expect(result.gAHash.length).toBe(32);
    expect(result.privateExponent.length).toBe(256);

    // g_a_hash is SHA-256 of g_a
    const expectedHash = createHash('sha256').update(result.gA).digest();
    expect(result.gAHash).toEqual(expectedHash);
  });

  test('calleeInitExchange produces valid g_b', () => {
    const dhConfig = createTestDhConfig();
    const result = calleeInitExchange(dhConfig);

    expect(result.gB.length).toBe(256);
    expect(result.privateExponent.length).toBe(256);
  });

  test('full exchange — both sides derive the same shared key', () => {
    const dhConfig = createTestDhConfig();

    // Step 1: Caller generates g_a
    const caller = callerInitExchange(dhConfig);

    // Step 2: Callee generates g_b
    const callee = calleeInitExchange(dhConfig);

    // Step 3: Caller derives key from g_b
    const callerAuth = callerDeriveKey(callee.gB, caller.privateExponent, dhConfig, caller.gA);
    expect(callerAuth.key.length).toBe(256);
    expect(callerAuth.gAOrB).toEqual(caller.gA);

    // Step 4: Callee derives key from g_a, verifying hash
    const calleeAuth = calleeDeriveKey(
      caller.gA,
      caller.gAHash,
      callee.privateExponent,
      dhConfig,
      callerAuth.keyFingerprint,
    );

    // Both sides must have identical keys
    expect(callerAuth.key).toEqual(calleeAuth.key);
    expect(callerAuth.keyFingerprint).toEqual(calleeAuth.keyFingerprint);
  });

  test('calleeDeriveKey rejects tampered g_a_hash', () => {
    const dhConfig = createTestDhConfig();
    const caller = callerInitExchange(dhConfig);
    const callee = calleeInitExchange(dhConfig);

    const callerAuth = callerDeriveKey(callee.gB, caller.privateExponent, dhConfig, caller.gA);

    // Tamper with the hash
    const badHash = Buffer.from(caller.gAHash);
    badHash[0] ^= 0xff;

    expect(() =>
      calleeDeriveKey(caller.gA, badHash, callee.privateExponent, dhConfig, callerAuth.keyFingerprint),
    ).toThrow(DhExchangeError);
  });

  test('calleeDeriveKey rejects wrong fingerprint', () => {
    const dhConfig = createTestDhConfig();
    const caller = callerInitExchange(dhConfig);
    const callee = calleeInitExchange(dhConfig);

    // Use the correct hash but wrong fingerprint
    expect(() =>
      calleeDeriveKey(
        caller.gA,
        caller.gAHash,
        callee.privateExponent,
        dhConfig,
        12345n, // wrong fingerprint
      ),
    ).toThrow(DhExchangeError);
  });
});

describe('DH exchange — emoji fingerprint', () => {
  test('both sides compute the same emoji fingerprint', () => {
    const dhConfig = createTestDhConfig();
    const caller = callerInitExchange(dhConfig);
    const callee = calleeInitExchange(dhConfig);

    const callerAuth = callerDeriveKey(callee.gB, caller.privateExponent, dhConfig, caller.gA);

    // Both sides use key + g_a (the caller's public value)
    const callerEmoji = computeEmojiFingerprint(callerAuth.key, caller.gA);
    const calleeEmoji = computeEmojiFingerprint(callerAuth.key, caller.gA);

    expect(callerEmoji).toEqual(calleeEmoji);
    expect(callerEmoji.length).toBe(4);
  });

  test('emoji fingerprint is deterministic', () => {
    const key = randomBytes(256);
    const gA = randomBytes(256);

    const first = computeEmojiFingerprint(key, gA);
    const second = computeEmojiFingerprint(key, gA);

    expect(first).toEqual(second);
  });
});

describe('VoiceCallDhExchange — state machine', () => {
  test('full caller flow', () => {
    const dhConfig = createTestDhConfig();

    const callerExchange = new VoiceCallDhExchange(dhConfig);
    expect(callerExchange.callState).toBe(CallState.Idle);

    // Step 1: init as caller
    const { gA } = callerExchange.initAsCaller();
    expect(callerExchange.callState).toBe(CallState.WaitingAccept);

    // Simulate callee side
    const callee = calleeInitExchange(dhConfig);

    // Step 2: caller receives g_b
    const authParams = callerExchange.onCallAccepted(callee.gB);
    expect(callerExchange.callState).toBe(CallState.Established);
    expect(authParams.key.length).toBe(256);
    expect(authParams.gAOrB).toEqual(gA);

    // Emoji verification should work
    const emoji = callerExchange.getEmojiFingerprint();
    expect(emoji.length).toBe(4);
  });

  test('full callee flow', () => {
    const dhConfig = createTestDhConfig();
    const caller = callerInitExchange(dhConfig);

    const calleeExchange = new VoiceCallDhExchange(dhConfig);
    expect(calleeExchange.callState).toBe(CallState.Idle);

    // Step 1: init as callee with g_a_hash from the request
    const { gB } = calleeExchange.initAsCallee(caller.gAHash);
    expect(calleeExchange.callState).toBe(CallState.WaitingConfirm);

    // Compute caller's key to get the fingerprint
    const callerAuth = callerDeriveKey(gB, caller.privateExponent, dhConfig, caller.gA);

    // Step 2: callee receives g_a and fingerprint
    const calleeAuth = calleeExchange.onCallConfirmed(caller.gA, callerAuth.keyFingerprint);
    expect(calleeExchange.callState).toBe(CallState.Established);
    expect(calleeAuth.key).toEqual(callerAuth.key);
  });

  test('rejects double init', () => {
    const dhConfig = createTestDhConfig();
    const exchange = new VoiceCallDhExchange(dhConfig);
    exchange.initAsCaller();

    expect(() => exchange.initAsCaller()).toThrow('Cannot init as caller');
    expect(() => exchange.initAsCallee(randomBytes(32))).toThrow('Cannot init as callee');
  });

  test('rejects wrong state transitions', () => {
    const dhConfig = createTestDhConfig();

    // Caller tries to handle confirmed (wrong role)
    const callerExchange = new VoiceCallDhExchange(dhConfig);
    callerExchange.initAsCaller();
    expect(() => callerExchange.onCallConfirmed(randomBytes(256), 0n)).toThrow('Cannot process confirmed');

    // Callee tries to handle accepted (wrong role)
    const calleeExchange = new VoiceCallDhExchange(dhConfig);
    calleeExchange.initAsCallee(randomBytes(32));
    expect(() => calleeExchange.onCallAccepted(randomBytes(256))).toThrow('Cannot process accepted');
  });

  test('discard clears state', () => {
    const dhConfig = createTestDhConfig();
    const exchange = new VoiceCallDhExchange(dhConfig);
    exchange.initAsCaller();
    exchange.discard();
    expect(exchange.callState).toBe(CallState.Discarded);
  });

  test('fail clears state', () => {
    const dhConfig = createTestDhConfig();
    const exchange = new VoiceCallDhExchange(dhConfig);
    exchange.initAsCaller();
    exchange.fail();
    expect(exchange.callState).toBe(CallState.Failed);
  });
});

describe('DH config validation', () => {
  test('rejects wrong prime length', () => {
    const dhConfig = createTestDhConfig();
    dhConfig.p = randomBytes(128); // Too short

    expect(() => new VoiceCallDhExchange(dhConfig)).toThrow('DH prime must be 256 bytes');
  });

  test('rejects unsupported generator', () => {
    const dhConfig = createTestDhConfig();
    dhConfig.g = 11; // Not valid

    expect(() => new VoiceCallDhExchange(dhConfig)).toThrow('Unsupported generator');
  });

  test('rejects wrong modular condition for g=2', () => {
    const dhConfig = createTestDhConfig();
    // Construct a 256-byte buffer that's NOT ≡ 7 mod 8
    const badPrime = Buffer.from(dhConfig.p);
    // Make last byte even (so p mod 8 != 7)
    badPrime[255] = badPrime[255] & 0xfe;
    dhConfig.p = badPrime;

    expect(() => new VoiceCallDhExchange(dhConfig)).toThrow('p mod 8 must be 7');
  });
});

describe('MTProto payload builders', () => {
  test('buildRequestCallPayload', () => {
    const gAHash = randomBytes(32);
    const payload = buildRequestCallPayload(12345n, 67890n, gAHash, true);

    expect(payload._).toBe('phone.requestCall');
    expect(payload.video).toBe(true);
    expect(payload.userId._).toBe('inputUser');
    expect(payload.userId.userId).toBe(12345n);
    expect(payload.userId.accessHash).toBe(67890n);
    expect(payload.gAHash).toEqual(gAHash);
    expect(payload.protocol._).toBe('phoneCallProtocol');
    expect(payload.protocol.udpP2p).toBe(true);
    expect(payload.protocol.udpReflector).toBe(true);
    expect(payload.randomId).toBeGreaterThan(0);
  });

  test('buildAcceptCallPayload', () => {
    const gB = randomBytes(256);
    const peer = { id: 111n, accessHash: 222n };
    const payload = buildAcceptCallPayload(peer, gB);

    expect(payload._).toBe('phone.acceptCall');
    expect(payload.peer.id).toBe(111n);
    expect(payload.gB).toEqual(gB);
  });

  test('buildConfirmCallPayload', () => {
    const gA = randomBytes(256);
    const peer = { id: 111n, accessHash: 222n };
    const payload = buildConfirmCallPayload(peer, gA, -12345n);

    expect(payload._).toBe('phone.confirmCall');
    expect(payload.gA).toEqual(gA);
    expect(payload.keyFingerprint).toBe(-12345n);
  });

  test('buildDiscardCallPayload', () => {
    const peer = { id: 111n, accessHash: 222n };
    const payload = buildDiscardCallPayload(peer, DiscardReason.Hangup, 30);

    expect(payload._).toBe('phone.discardCall');
    expect(payload.duration).toBe(30);
    expect(payload.reason._).toBe('phoneCallDiscardReasonHangup');
  });

  test('buildGetDhConfigPayload', () => {
    const payload = buildGetDhConfigPayload();

    expect(payload._).toBe('messages.getDhConfig');
    expect(payload.version).toBe(0);
    expect(payload.randomLength).toBe(256);
  });
});

describe('end-to-end integration (simulated)', () => {
  test('full caller ↔ callee exchange with state machines', () => {
    const dhConfig = createTestDhConfig();

    // === CALLER SIDE ===
    const callerExchange = new VoiceCallDhExchange(dhConfig);
    const callerInit = callerExchange.initAsCaller();

    // Build the requestCall payload
    const requestPayload = buildRequestCallPayload(100n, 200n, callerInit.gAHash, false);
    expect(requestPayload.gAHash).toEqual(callerInit.gAHash);

    // === CALLEE SIDE ===
    // Callee receives PhoneCallRequested with g_a_hash
    const calleeExchange = new VoiceCallDhExchange(dhConfig);
    const calleeInit = calleeExchange.initAsCallee(callerInit.gAHash);

    // Build the acceptCall payload
    const acceptPayload = buildAcceptCallPayload({ id: 999n, accessHash: 888n }, calleeInit.gB);
    expect(acceptPayload.gB).toEqual(calleeInit.gB);

    // === CALLER SIDE (receives PhoneCallAccepted) ===
    const callerAuth = callerExchange.onCallAccepted(calleeInit.gB);
    expect(callerExchange.callState).toBe(CallState.Established);

    // Build the confirmCall payload
    const confirmPayload = buildConfirmCallPayload(
      { id: 999n, accessHash: 888n },
      callerAuth.gAOrB,
      callerAuth.keyFingerprint,
    );
    expect(confirmPayload.gA).toEqual(callerInit.gA);

    // === CALLEE SIDE (receives PhoneCall with g_a and fingerprint) ===
    const calleeAuth = calleeExchange.onCallConfirmed(callerAuth.gAOrB, callerAuth.keyFingerprint);
    expect(calleeExchange.callState).toBe(CallState.Established);

    // === VERIFY ===
    // Same shared key
    expect(callerAuth.key).toEqual(calleeAuth.key);
    expect(callerAuth.keyFingerprint).toEqual(calleeAuth.keyFingerprint);

    // Same emoji fingerprint
    const callerEmoji = callerExchange.getEmojiFingerprint();
    const calleeEmoji = calleeExchange.getEmojiFingerprint();
    expect(callerEmoji).toEqual(calleeEmoji);
  });
});
