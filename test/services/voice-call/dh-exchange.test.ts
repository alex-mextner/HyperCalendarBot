// Real local DH exchanges test matching keys, commitment validation and state transitions.
import { expect, mock, test } from 'bun:test';
import { createDiffieHellman, createHash, getDiffieHellman } from 'node:crypto';
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
  DiscardReason,
  handlePhoneCallUpdate,
  VoiceCallDhExchange,
} from '../../../src/services/voice-call/dh-exchange.ts';

function config() {
  return { g: 2, p: getDiffieHellman('modp14').getPrime(), random: Buffer.alloc(256) };
}

test('caller and callee derive the same key and match independent native DH', () => {
  const dh = config();
  const caller = callerInitExchange(dh);
  const callee = calleeInitExchange(dh);
  expect(caller.gAHash).toEqual(createHash('sha256').update(caller.gA).digest());
  const outgoing = callerDeriveKey(callee.gB, caller.privateExponent, dh, caller.gA);
  const incoming = calleeDeriveKey(caller.gA, caller.gAHash, callee.privateExponent, dh, outgoing.keyFingerprint);
  expect(incoming.key).toEqual(outgoing.key);
  expect(incoming.key).toHaveLength(256);
  const native = createDiffieHellman(dh.p, dh.g);
  native.setPrivateKey(caller.privateExponent);
  expect(outgoing.key).toEqual(native.computeSecret(callee.gB));
  expect(outgoing.keyFingerprint).toBe(createHash('sha1').update(outgoing.key).digest().readBigInt64LE(12));
  expect(outgoing.gAOrB).toEqual(caller.gA);
  expect(() =>
    calleeDeriveKey(caller.gA, Buffer.alloc(32), callee.privateExponent, dh, outgoing.keyFingerprint),
  ).toThrow('does not match');
  expect(() =>
    calleeDeriveKey(caller.gA, caller.gAHash, callee.privateExponent, dh, outgoing.keyFingerprint + 1n),
  ).toThrow('Computed fingerprint');
});

test('unsafe remote values and malformed configs fail before establishing keys', () => {
  const dh = config();
  const caller = callerInitExchange(dh);
  for (const remote of [Buffer.alloc(0), Buffer.from([0]), Buffer.from([1]), Buffer.from([2]), dh.p])
    expect(() => callerDeriveKey(remote, caller.privateExponent, dh, caller.gA)).toThrow();
  for (const invalid of [
    { ...dh, p: Buffer.alloc(255) },
    { ...dh, p: Buffer.alloc(256) },
    { ...dh, g: 8 },
  ])
    expect(() => new VoiceCallDhExchange(invalid)).toThrow();
});

test('stateful exchange enforces order, wipes private exponents and agrees on emoji verification', () => {
  const caller = new VoiceCallDhExchange(config());
  const callee = new VoiceCallDhExchange(config());
  expect(caller.callState).toBe(CallState.Idle);
  expect(caller.key).toBeNull();
  expect(caller.keyFingerprint).toBeNull();
  expect(() => caller.getEmojiFingerprint()).toThrow('established');
  expect(() => caller.onCallAccepted(Buffer.alloc(256))).toThrow('state idle');
  expect(() => callee.onCallConfirmed(Buffer.alloc(256), 0n)).toThrow('state idle');
  const a = caller.initAsCaller();
  expect(caller.callState).toBe(CallState.WaitingAccept);
  expect(() => caller.initAsCaller()).toThrow('state waiting_accept');
  const b = callee.initAsCallee(a.gAHash);
  expect(callee.callState).toBe(CallState.WaitingConfirm);
  expect(() => callee.initAsCallee(a.gAHash)).toThrow('state waiting_confirm');
  const auth = caller.onCallAccepted(b.gB);
  callee.onCallConfirmed(auth.gAOrB, auth.keyFingerprint);
  expect(caller.callState).toBe(CallState.Established);
  expect(callee.callState).toBe(CallState.Established);
  expect(caller.key).toEqual(callee.key);
  expect(caller.keyFingerprint).toBe(callee.keyFingerprint);
  expect(caller.getEmojiFingerprint()).toHaveLength(4);
  expect(caller.getEmojiFingerprint()).toEqual(callee.getEmojiFingerprint());
  expect(a.privateExponent).toEqual(Buffer.alloc(256));
  expect(b.privateExponent).toEqual(Buffer.alloc(256));
  expect(() => caller.onCallAccepted(b.gB)).toThrow('state established');
  expect(() => callee.onCallConfirmed(a.gA, auth.keyFingerprint)).toThrow('state established');
});

test('discard and failure wipe pending secrets and prohibit restart', () => {
  for (const operation of ['discard', 'fail'] as const) {
    const exchange = new VoiceCallDhExchange(config());
    const { privateExponent } = exchange.initAsCaller();
    exchange[operation]();
    expect(privateExponent).toEqual(Buffer.alloc(256));
    expect(exchange.callState).toBe(operation === 'discard' ? CallState.Discarded : CallState.Failed);
    expect(() => exchange.initAsCaller()).toThrow('Cannot init');
    exchange[operation]();
  }
});

test('MTProto payload builders preserve peers, buffers, flags and protocol overrides', () => {
  const peer = { id: 123n, accessHash: 456n };
  const data = Buffer.from([1, 2, 3]);
  const protocol = { udpP2p: false, udpReflector: false, minLayer: 1, maxLayer: 2, libraryVersions: ['fixture'] };
  const request = buildRequestCallPayload(42n, 43n, data, true, protocol);
  expect(request).toMatchObject({
    _: 'phone.requestCall',
    flags: 1,
    video: true,
    userId: { _: 'inputUser', userId: 42n, accessHash: 43n },
    gAHash: data,
    protocol: { _: 'phoneCallProtocol', flags: 0, minLayer: 1, maxLayer: 2, libraryVersions: ['fixture'] },
  });
  expect(request.randomId).toBeGreaterThan(0);
  expect(request.randomId).toBeLessThan(0x7fffffff);
  expect(buildRequestCallPayload(42n, 43n, data)).toMatchObject({
    flags: 0,
    video: undefined,
    protocol: { flags: 3, udpP2p: true, udpReflector: true },
  });
  expect(buildAcceptCallPayload(peer, data, protocol)).toMatchObject({
    _: 'phone.acceptCall',
    peer: { _: 'inputPhoneCall', ...peer },
    gB: data,
    protocol: { flags: 0 },
  });
  expect(buildConfirmCallPayload(peer, data, -7n)).toMatchObject({
    _: 'phone.confirmCall',
    peer: { _: 'inputPhoneCall', ...peer },
    gA: data,
    keyFingerprint: -7n,
  });
  expect(buildDiscardCallPayload(peer, DiscardReason.Busy, 12, true)).toEqual({
    _: 'phone.discardCall',
    peer: { _: 'inputPhoneCall', ...peer },
    flags: 1,
    video: true,
    duration: 12,
    reason: { _: 'phoneCallDiscardReasonBusy' },
    connectionId: 0n,
  });
  expect(buildDiscardCallPayload(peer, DiscardReason.Hangup)).toMatchObject({
    duration: 0,
    flags: 0,
    video: undefined,
  });
  expect(buildGetDhConfigPayload()).toEqual({ _: 'messages.getDhConfig', version: 0, randomLength: 256 });
  expect(buildGetDhConfigPayload(9).version).toBe(9);
});

test('discard update dispatch forwards the exact update and tolerates absent handlers', () => {
  const call = { _: 'phoneCallDiscarded', id: 3n } as const;
  const onCallDiscarded = mock(() => {});
  const onCallRequested = mock(() => {});
  handlePhoneCallUpdate(call, { onCallDiscarded, onCallRequested });
  expect(onCallDiscarded).toHaveBeenCalledWith(call);
  expect(onCallRequested).not.toHaveBeenCalled();
  handlePhoneCallUpdate(call, {});
});
