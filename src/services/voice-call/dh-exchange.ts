/**
 * Diffie-Hellman key exchange for Telegram voice calls (E2E encryption).
 *
 * Implements the full protocol described at:
 *   https://core.telegram.org/api/end-to-end/voice-calls
 *
 * Flow:
 *   1. Caller → phone.requestCall  (sends g_a_hash = SHA-256(g_a))
 *   2. Callee → phone.acceptCall   (sends g_b)
 *   3. Server → updatePhoneCall    (PhoneCallAccepted with g_b → to Caller)
 *   4. Caller → phone.confirmCall  (sends g_a + key_fingerprint)
 *   5. Server → updatePhoneCall    (PhoneCall with g_a_or_b → to Callee)
 *   6. Both sides derive the same 256-byte shared key
 *
 * Uses Node.js `crypto` for big-number modular exponentiation (no external deps).
 */

import { createHash, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** DH key size in bytes (2048 bits). */
const DH_KEY_SIZE = 256;

/** Minimum bit length for security checks on g_a, g_b, (p - g_a), (p - g_b). */
const MIN_SAFE_BITS = 2048 - 64;

/** Supported tgvoip / tgcalls library versions for PhoneCallProtocol. */
const DEFAULT_LIBRARY_VERSIONS = ['5.0.0', '4.0.0', '3.0.0', '2.7.7', '2.4.4'];

/** Default tgvoip protocol layer range. */
const MIN_LAYER = 92;
const MAX_LAYER = 92;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw DH config returned by messages.getDhConfig. */
export interface DhConfig {
  /** Generator (small integer, typically 2, 3, 4, 5, 6, 7). */
  g: number;
  /** 2048-bit safe prime, big-endian 256 bytes. */
  p: Buffer;
  /** Server-supplied random bytes (256 bytes) to XOR with local randomness. */
  random: Buffer;
}

/** PhoneCallProtocol constructor payload. */
export interface PhoneCallProtocol {
  udpP2p: boolean;
  udpReflector: boolean;
  minLayer: number;
  maxLayer: number;
  libraryVersions: string[];
}

/** InputPhoneCall — references an active call by id + access_hash. */
export interface InputPhoneCall {
  id: bigint;
  accessHash: bigint;
}

/** Result of the caller's initExchange (step 1). */
export interface CallerExchangeInit {
  /** g_a = g^a mod p — 256 bytes, big-endian. DO NOT send this directly in requestCall. */
  gA: Buffer;
  /** SHA-256(g_a) — 32 bytes, sent in phone.requestCall as g_a_hash. */
  gAHash: Buffer;
  /** Private exponent a — kept in memory until confirmCall. */
  privateExponent: Buffer;
}

/** Result of the callee's acceptExchange (step 2). */
export interface CalleeExchangeInit {
  /** g_b = g^b mod p — 256 bytes, big-endian. Sent in phone.acceptCall. */
  gB: Buffer;
  /** Private exponent b — kept in memory until key derivation. */
  privateExponent: Buffer;
}

/** Derived shared encryption key + fingerprint. */
export interface SharedKeyResult {
  /** 256-byte shared key. */
  key: Buffer;
  /** Lower 64 bits of SHA-1(key), as a signed 64-bit integer (Long). */
  keyFingerprint: bigint;
}

/** Auth params returned after exchangeKeys (mirrors ntgcalls AuthParams). */
export interface AuthParams {
  /** g_a or g_b bytes to send in confirmCall / acceptCall. */
  gAOrB: Buffer;
  /** Key fingerprint (lower 8 bytes of SHA-1(key)). */
  keyFingerprint: bigint;
  /** The 256-byte shared encryption key. */
  key: Buffer;
}

/** State machine for a single voice call DH exchange. */
export enum CallState {
  Idle = 'idle',
  WaitingAccept = 'waiting_accept',
  WaitingConfirm = 'waiting_confirm',
  Established = 'established',
  Discarded = 'discarded',
  Failed = 'failed',
}

/** Discard reasons (phoneCallDiscardReason constructors). */
export enum DiscardReason {
  Missed = 'phoneCallDiscardReasonMissed',
  Disconnect = 'phoneCallDiscardReasonDisconnect',
  Hangup = 'phoneCallDiscardReasonHangup',
  Busy = 'phoneCallDiscardReasonBusy',
}

/** Errors that can occur during the DH exchange. */
export class DhExchangeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DhExchangeError';
  }
}

// ---------------------------------------------------------------------------
// MTProto method payloads (TL schema, serialized as plain objects)
// ---------------------------------------------------------------------------

/**
 * phone.requestCall#42ff96ed
 *
 * ```tl
 * phone.requestCall flags:# video:flags.0?true
 *   user_id:InputUser random_id:int g_a_hash:bytes
 *   protocol:PhoneCallProtocol = phone.PhoneCall;
 * ```
 */
export interface RequestCallPayload {
  _: 'phone.requestCall';
  flags: number;
  video?: true;
  userId: { _: 'inputUser'; userId: bigint; accessHash: bigint };
  randomId: number;
  gAHash: Buffer;
  protocol: PhoneCallProtocolPayload;
}

/**
 * phone.acceptCall#3bd2b4a0
 *
 * ```tl
 * phone.acceptCall peer:InputPhoneCall g_b:bytes
 *   protocol:PhoneCallProtocol = phone.PhoneCall;
 * ```
 */
export interface AcceptCallPayload {
  _: 'phone.acceptCall';
  peer: InputPhoneCallPayload;
  gB: Buffer;
  protocol: PhoneCallProtocolPayload;
}

/**
 * phone.confirmCall#2efe1722
 *
 * ```tl
 * phone.confirmCall peer:InputPhoneCall g_a:bytes
 *   key_fingerprint:long protocol:PhoneCallProtocol = phone.PhoneCall;
 * ```
 */
export interface ConfirmCallPayload {
  _: 'phone.confirmCall';
  peer: InputPhoneCallPayload;
  gA: Buffer;
  keyFingerprint: bigint;
  protocol: PhoneCallProtocolPayload;
}

/**
 * phone.discardCall#b2cbc1c0
 *
 * ```tl
 * phone.discardCall flags:# video:flags.0?true peer:InputPhoneCall
 *   duration:int reason:PhoneCallDiscardReason connection_id:long = Updates;
 * ```
 */
export interface DiscardCallPayload {
  _: 'phone.discardCall';
  flags: number;
  video?: true;
  peer: InputPhoneCallPayload;
  duration: number;
  reason: { _: string };
  connectionId: bigint;
}

interface InputPhoneCallPayload {
  _: 'inputPhoneCall';
  id: bigint;
  accessHash: bigint;
}

interface PhoneCallProtocolPayload {
  _: 'phoneCallProtocol';
  flags: number;
  udpP2p?: true;
  udpReflector?: true;
  minLayer: number;
  maxLayer: number;
  libraryVersions: string[];
}

// ---------------------------------------------------------------------------
// updatePhoneCall event types (incoming from MTProto)
// ---------------------------------------------------------------------------

export interface PhoneCallRequested {
  _: 'phoneCallRequested';
  id: bigint;
  accessHash: bigint;
  date: number;
  adminId: bigint;
  participantId: bigint;
  gAHash: Buffer;
  protocol: PhoneCallProtocol;
  video?: boolean;
}

export interface PhoneCallAccepted {
  _: 'phoneCallAccepted';
  id: bigint;
  accessHash: bigint;
  date: number;
  adminId: bigint;
  participantId: bigint;
  gB: Buffer;
  protocol: PhoneCallProtocol;
  video?: boolean;
}

export interface PhoneCallConfirmed {
  _: 'phoneCall';
  id: bigint;
  accessHash: bigint;
  date: number;
  adminId: bigint;
  participantId: bigint;
  gAOrB: Buffer;
  keyFingerprint: bigint;
  protocol: PhoneCallProtocol;
  p2pAllowed?: boolean;
  video?: boolean;
  connections: PhoneConnection[];
  startDate: number;
}

export interface PhoneCallDiscarded {
  _: 'phoneCallDiscarded';
  id: bigint;
  reason?: { _: string };
  duration?: number;
}

export interface PhoneConnection {
  id: bigint;
  ip: string;
  ipv6: string;
  port: number;
  peerTag?: Buffer;
  // WebRTC-specific
  username?: string;
  password?: string;
  turn?: boolean;
  stun?: boolean;
}

export type PhoneCallUpdate = PhoneCallRequested | PhoneCallAccepted | PhoneCallConfirmed | PhoneCallDiscarded;

// ---------------------------------------------------------------------------
// Big-number helpers (using Node.js crypto only — no external deps)
// ---------------------------------------------------------------------------

/** Convert a Buffer to a positive BigInt (big-endian unsigned). */
function bufToBigInt(buf: Buffer): bigint {
  if (buf.length === 0) return 0n;
  return BigInt(`0x${buf.toString('hex')}`);
}

/** Convert a BigInt to a big-endian Buffer, zero-padded to `size` bytes. */
function bigIntToBuf(n: bigint, size: number): Buffer {
  let hex = n.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  const raw = Buffer.from(hex, 'hex');
  if (raw.length >= size) return raw.subarray(raw.length - size);
  const padded = Buffer.alloc(size);
  raw.copy(padded, size - raw.length);
  return padded;
}

/** Count significant bits in a BigInt. */
function bitLength(n: bigint): number {
  if (n <= 0n) return 0;
  return n.toString(2).length;
}

/**
 * Modular exponentiation: base^exp mod mod.
 *
 * Uses the built-in square-and-multiply algorithm. For 2048-bit numbers
 * this is fast enough (< 50ms on modern hardware).
 */
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  if (mod === 1n) return 0n;
  let result = 1n;
  base = ((base % mod) + mod) % mod;
  while (exp > 0n) {
    if (exp & 1n) {
      result = (result * base) % mod;
    }
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Cryptographic helpers
// ---------------------------------------------------------------------------

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

function sha1(data: Buffer): Buffer {
  return createHash('sha1').update(data).digest();
}

/**
 * Compute the key fingerprint: lower 64 bits of SHA-1(key).
 * Returned as a signed bigint matching Telegram's `long` type.
 *
 * From ntgcalls auth_key.cpp — bytes [12..19] of the SHA-1 hash,
 * read as little-endian uint64, then reinterpreted as signed.
 */
function computeKeyFingerprint(key: Buffer): bigint {
  const hash = sha1(key);
  // Bytes 12..19, little-endian → uint64
  let fp = 0n;
  for (let i = 19; i >= 12; i--) {
    fp = (fp << 8n) | BigInt(hash[i]);
  }
  // Reinterpret as signed 64-bit
  if (fp >= 1n << 63n) {
    fp -= 1n << 64n;
  }
  return fp;
}

/**
 * Generate 4 emoji for visual key verification.
 *
 * SHA-256(key ‖ g_a) → split into 4 × 8-byte chunks → each mod 333 → emoji index.
 */
export function computeEmojiFingerprint(key: Buffer, gA: Buffer): string[] {
  const data = Buffer.concat([key, gA]);
  const hash = sha256(data);

  // https://core.telegram.org/api/end-to-end/voice-calls#emoji-visualization
  // 333 possible emoji, 4 slots, each from 8 bytes of the hash
  const EMOJI_COUNT = 333n;
  const emojis: string[] = [];
  for (let i = 0; i < 4; i++) {
    const offset = i * 8;
    let value = 0n;
    for (let j = 7; j >= 0; j--) {
      value = (value << 8n) | BigInt(hash[offset + j]);
    }
    const index = Number(value % EMOJI_COUNT);
    emojis.push(EMOJI_LIST[index] ?? `[${index}]`);
  }
  return emojis;
}

// ---------------------------------------------------------------------------
// DH parameter validation (mirrors Telegram security requirements)
// ---------------------------------------------------------------------------

/**
 * Validate that g_a or g_b is safe:
 *   - 1 < value < p - 1
 *   - value > 2^1984
 *   - p - value > 2^1984
 *   - bit length of value >= MIN_SAFE_BITS
 *   - bit length of (p - value) >= MIN_SAFE_BITS
 */
function validateDhValue(value: bigint, p: bigint): void {
  if (value <= 1n) {
    throw new DhExchangeError('DH_G_A_INVALID', 'DH value must be > 1');
  }
  if (value >= p - 1n) {
    throw new DhExchangeError('DH_G_A_INVALID', 'DH value must be < p - 1');
  }

  const diff = p - value;
  if (bitLength(value) < MIN_SAFE_BITS) {
    throw new DhExchangeError('DH_G_A_INVALID', `DH value bit length ${bitLength(value)} < ${MIN_SAFE_BITS}`);
  }
  if (bitLength(diff) < MIN_SAFE_BITS) {
    throw new DhExchangeError('DH_G_A_INVALID', `p - value bit length ${bitLength(diff)} < ${MIN_SAFE_BITS}`);
  }
}

/**
 * Validate the DH prime `p` from messages.getDhConfig.
 *
 * Checks:
 *   - p is exactly 2048 bits (256 bytes)
 *   - g is one of the valid generators (2, 3, 4, 5, 6, 7)
 *   - Matching modular conditions for g
 *
 * NOTE: Full primality testing (p is safe prime, (p-1)/2 is prime) is
 * computationally expensive. Telegram clients typically trust the server
 * and cache verified primes. In production you should verify once and cache.
 */
function validateDhConfig(config: DhConfig): void {
  if (config.p.length !== DH_KEY_SIZE) {
    throw new DhExchangeError('DH_PRIME_INVALID', `DH prime must be ${DH_KEY_SIZE} bytes, got ${config.p.length}`);
  }

  const p = bufToBigInt(config.p);
  const g = config.g;

  if (bitLength(p) !== 2048) {
    throw new DhExchangeError('DH_PRIME_INVALID', `DH prime must be exactly 2048 bits, got ${bitLength(p)}`);
  }

  // Validate g and corresponding modular conditions
  switch (g) {
    case 2:
      if (p % 8n !== 7n) {
        throw new DhExchangeError('DH_PRIME_INVALID', 'For g=2, p mod 8 must be 7');
      }
      break;
    case 3:
      if (p % 3n !== 2n) {
        throw new DhExchangeError('DH_PRIME_INVALID', 'For g=3, p mod 3 must be 2');
      }
      break;
    case 4:
      // No additional condition beyond safe prime
      break;
    case 5:
      if (p % 5n !== 1n && p % 5n !== 4n) {
        throw new DhExchangeError('DH_PRIME_INVALID', 'For g=5, p mod 5 must be 1 or 4');
      }
      break;
    case 6:
      if (p % 24n !== 19n && p % 24n !== 23n) {
        throw new DhExchangeError('DH_PRIME_INVALID', 'For g=6, p mod 24 must be 19 or 23');
      }
      break;
    case 7:
      if (p % 7n !== 3n && p % 7n !== 4n && p % 7n !== 5n && p % 7n !== 6n) {
        throw new DhExchangeError('DH_PRIME_INVALID', 'For g=7, p mod 7 must be 3, 4, 5, or 6');
      }
      break;
    default:
      throw new DhExchangeError('DH_PRIME_INVALID', `Unsupported generator g=${g}`);
  }
}

// ---------------------------------------------------------------------------
// Core DH exchange operations
// ---------------------------------------------------------------------------

/**
 * Generate a 256-byte random private exponent, XOR'd with server random.
 * Returns the exponent as a BigInt validated to be in range (1, p-1).
 */
function generatePrivateExponent(serverRandom: Buffer, p: bigint): { exponent: bigint; raw: Buffer } {
  // Keep trying until we get a valid exponent (almost always first try)
  for (let attempt = 0; attempt < 64; attempt++) {
    const localRandom = randomBytes(DH_KEY_SIZE);
    const raw = Buffer.alloc(DH_KEY_SIZE);
    for (let i = 0; i < DH_KEY_SIZE; i++) {
      raw[i] = localRandom[i] ^ (serverRandom[i] ?? 0);
    }

    const exponent = bufToBigInt(raw);
    if (exponent > 1n && exponent < p - 1n) {
      return { exponent, raw };
    }
  }
  throw new DhExchangeError('DH_RANDOM_FAILED', 'Failed to generate valid random exponent after 64 attempts');
}

/**
 * Step 1 (Caller): Initialize the exchange.
 *
 * - Fetches DH config (caller must call messages.getDhConfig first)
 * - Generates random exponent `a`
 * - Computes g_a = g^a mod p
 * - Returns g_a, SHA-256(g_a), and the private exponent
 */
export function callerInitExchange(dhConfig: DhConfig): CallerExchangeInit {
  validateDhConfig(dhConfig);

  const p = bufToBigInt(dhConfig.p);
  const g = BigInt(dhConfig.g);

  const { exponent: a, raw: privateExponent } = generatePrivateExponent(dhConfig.random, p);

  const gAInt = modPow(g, a, p);

  // Validate g_a
  validateDhValue(gAInt, p);

  const gA = bigIntToBuf(gAInt, DH_KEY_SIZE);
  const gAHash = sha256(gA);

  return { gA, gAHash, privateExponent };
}

/**
 * Step 2 (Callee): Accept the call.
 *
 * - Generates random exponent `b`
 * - Computes g_b = g^b mod p
 * - Returns g_b and the private exponent
 */
export function calleeInitExchange(dhConfig: DhConfig): CalleeExchangeInit {
  validateDhConfig(dhConfig);

  const p = bufToBigInt(dhConfig.p);
  const g = BigInt(dhConfig.g);

  const { exponent: b, raw: privateExponent } = generatePrivateExponent(dhConfig.random, p);

  const gBInt = modPow(g, b, p);

  // Validate g_b
  validateDhValue(gBInt, p);

  const gB = bigIntToBuf(gBInt, DH_KEY_SIZE);

  return { gB, privateExponent };
}

/**
 * Step 3 (Caller): After receiving PhoneCallAccepted with g_b.
 *
 * Computes: key = g_b^a mod p
 *
 * Returns the shared key, fingerprint, and the original g_a to send in confirmCall.
 */
export function callerDeriveKey(gB: Buffer, privateExponent: Buffer, dhConfig: DhConfig, gA: Buffer): AuthParams {
  const p = bufToBigInt(dhConfig.p);
  const gBInt = bufToBigInt(gB);
  const a = bufToBigInt(privateExponent);

  // Validate g_b received from callee
  validateDhValue(gBInt, p);

  const keyInt = modPow(gBInt, a, p);
  const key = bigIntToBuf(keyInt, DH_KEY_SIZE);
  const keyFingerprint = computeKeyFingerprint(key);

  return { gAOrB: gA, keyFingerprint, key };
}

/**
 * Step 4 (Callee): After receiving PhoneCall update with g_a_or_b and key_fingerprint.
 *
 * - Verifies SHA-256(g_a) matches the g_a_hash from the original request
 * - Computes: key = g_a^b mod p
 * - Verifies the fingerprint matches
 */
export function calleeDeriveKey(
  gA: Buffer,
  gAHash: Buffer,
  privateExponent: Buffer,
  dhConfig: DhConfig,
  expectedFingerprint: bigint,
): AuthParams {
  // Verify g_a_hash commitment
  const computedHash = sha256(gA);
  if (!computedHash.equals(gAHash)) {
    throw new DhExchangeError('DH_G_A_HASH_MISMATCH', 'SHA-256(g_a) does not match the previously received g_a_hash');
  }

  const p = bufToBigInt(dhConfig.p);
  const gAInt = bufToBigInt(gA);
  const b = bufToBigInt(privateExponent);

  // Validate g_a received from caller
  validateDhValue(gAInt, p);

  const keyInt = modPow(gAInt, b, p);
  const key = bigIntToBuf(keyInt, DH_KEY_SIZE);
  const keyFingerprint = computeKeyFingerprint(key);

  // Verify fingerprint (sanity check — both sides should get the same key)
  if (keyFingerprint !== expectedFingerprint) {
    throw new DhExchangeError(
      'KEY_FINGERPRINT_MISMATCH',
      `Computed fingerprint ${keyFingerprint} !== expected ${expectedFingerprint}`,
    );
  }

  return { gAOrB: gA, keyFingerprint, key };
}

// ---------------------------------------------------------------------------
// MTProto payload builders
// ---------------------------------------------------------------------------

function buildProtocolPayload(opts?: Partial<PhoneCallProtocol>): PhoneCallProtocolPayload {
  const o = {
    udpP2p: true,
    udpReflector: true,
    minLayer: MIN_LAYER,
    maxLayer: MAX_LAYER,
    libraryVersions: DEFAULT_LIBRARY_VERSIONS,
    ...opts,
  };
  let flags = 0;
  if (o.udpP2p) flags |= 1;
  if (o.udpReflector) flags |= 2;
  return {
    _: 'phoneCallProtocol',
    flags,
    udpP2p: o.udpP2p ? true : undefined,
    udpReflector: o.udpReflector ? true : undefined,
    minLayer: o.minLayer,
    maxLayer: o.maxLayer,
    libraryVersions: o.libraryVersions,
  };
}

/**
 * Build the phone.requestCall payload (step 1 — Caller).
 */
export function buildRequestCallPayload(
  userId: bigint,
  userAccessHash: bigint,
  gAHash: Buffer,
  video = false,
  protocol?: Partial<PhoneCallProtocol>,
): RequestCallPayload {
  let flags = 0;
  if (video) flags |= 1;
  return {
    _: 'phone.requestCall',
    flags,
    video: video ? true : undefined,
    userId: { _: 'inputUser', userId, accessHash: userAccessHash },
    randomId: Math.floor(Math.random() * 0x7ffffffe) + 1,
    gAHash,
    protocol: buildProtocolPayload(protocol),
  };
}

/**
 * Build the phone.acceptCall payload (step 2 — Callee).
 */
export function buildAcceptCallPayload(
  peer: InputPhoneCall,
  gB: Buffer,
  protocol?: Partial<PhoneCallProtocol>,
): AcceptCallPayload {
  return {
    _: 'phone.acceptCall',
    peer: { _: 'inputPhoneCall', id: peer.id, accessHash: peer.accessHash },
    gB,
    protocol: buildProtocolPayload(protocol),
  };
}

/**
 * Build the phone.confirmCall payload (step 3 — Caller).
 */
export function buildConfirmCallPayload(
  peer: InputPhoneCall,
  gA: Buffer,
  keyFingerprint: bigint,
  protocol?: Partial<PhoneCallProtocol>,
): ConfirmCallPayload {
  return {
    _: 'phone.confirmCall',
    peer: { _: 'inputPhoneCall', id: peer.id, accessHash: peer.accessHash },
    gA,
    keyFingerprint,
    protocol: buildProtocolPayload(protocol),
  };
}

/**
 * Build the phone.discardCall payload.
 */
export function buildDiscardCallPayload(
  peer: InputPhoneCall,
  reason: DiscardReason,
  duration = 0,
  video = false,
): DiscardCallPayload {
  let flags = 0;
  if (video) flags |= 1;
  return {
    _: 'phone.discardCall',
    flags,
    video: video ? true : undefined,
    peer: { _: 'inputPhoneCall', id: peer.id, accessHash: peer.accessHash },
    duration,
    reason: { _: reason },
    connectionId: 0n,
  };
}

/**
 * Build the messages.getDhConfig payload.
 */
export function buildGetDhConfigPayload(version = 0) {
  return {
    _: 'messages.getDhConfig' as const,
    version,
    randomLength: DH_KEY_SIZE,
  };
}

// ---------------------------------------------------------------------------
// VoiceCallDhExchange — Stateful exchange manager
// ---------------------------------------------------------------------------

/**
 * Manages the full DH key exchange state machine for one voice call.
 *
 * Usage (Caller):
 * ```ts
 * const exchange = new VoiceCallDhExchange(dhConfig);
 * const { gAHash } = exchange.initAsCaller();
 * // → send phone.requestCall with gAHash
 * // ← receive PhoneCallAccepted with g_b
 * const authParams = exchange.onCallAccepted(gB);
 * // → send phone.confirmCall with authParams.gAOrB, authParams.keyFingerprint
 * // Call is now established
 * ```
 *
 * Usage (Callee):
 * ```ts
 * // ← receive PhoneCallRequested with g_a_hash
 * const exchange = new VoiceCallDhExchange(dhConfig);
 * const { gB } = exchange.initAsCallee(gAHash);
 * // → send phone.acceptCall with gB
 * // ← receive PhoneCall update with g_a_or_b and key_fingerprint
 * const authParams = exchange.onCallConfirmed(gAOrB, keyFingerprint);
 * // Call is now established
 * ```
 */
export class VoiceCallDhExchange {
  private dhConfig: DhConfig;
  private state: CallState = CallState.Idle;
  private isOutgoing = false;
  private privateExponent: Buffer | null = null;
  private gA: Buffer | null = null;
  private gAHash: Buffer | null = null;
  private sharedKey: Buffer | null = null;
  private fingerprint: bigint | null = null;

  constructor(dhConfig: DhConfig) {
    validateDhConfig(dhConfig);
    this.dhConfig = dhConfig;
  }

  get callState(): CallState {
    return this.state;
  }

  get key(): Buffer | null {
    return this.sharedKey;
  }

  get keyFingerprint(): bigint | null {
    return this.fingerprint;
  }

  /**
   * Initialize as Caller (outgoing call).
   *
   * Returns g_a_hash to include in phone.requestCall.
   */
  initAsCaller(): CallerExchangeInit {
    if (this.state !== CallState.Idle) {
      throw new DhExchangeError('INVALID_STATE', `Cannot init as caller in state ${this.state}`);
    }
    this.isOutgoing = true;

    const result = callerInitExchange(this.dhConfig);
    this.privateExponent = result.privateExponent;
    this.gA = result.gA;
    this.gAHash = result.gAHash;
    this.state = CallState.WaitingAccept;

    return result;
  }

  /**
   * Initialize as Callee (incoming call).
   *
   * Stores the g_a_hash from the incoming PhoneCallRequested update.
   * Returns g_b to include in phone.acceptCall.
   */
  initAsCallee(gAHash: Buffer): CalleeExchangeInit {
    if (this.state !== CallState.Idle) {
      throw new DhExchangeError('INVALID_STATE', `Cannot init as callee in state ${this.state}`);
    }
    this.isOutgoing = false;
    this.gAHash = gAHash;

    const result = calleeInitExchange(this.dhConfig);
    this.privateExponent = result.privateExponent;
    this.state = CallState.WaitingConfirm;

    return result;
  }

  /**
   * Caller: handle PhoneCallAccepted update (received g_b from callee).
   *
   * Derives the shared key and returns auth params for phone.confirmCall.
   */
  onCallAccepted(gB: Buffer): AuthParams {
    if (this.state !== CallState.WaitingAccept) {
      throw new DhExchangeError('INVALID_STATE', `Cannot process accepted in state ${this.state}`);
    }
    if (!this.isOutgoing) {
      throw new DhExchangeError('INVALID_STATE', 'Only the caller handles PhoneCallAccepted');
    }
    if (!this.privateExponent || !this.gA) {
      throw new DhExchangeError('INVALID_STATE', 'Missing private exponent or g_a');
    }

    const authParams = callerDeriveKey(gB, this.privateExponent, this.dhConfig, this.gA);
    this.sharedKey = authParams.key;
    this.fingerprint = authParams.keyFingerprint;
    this.state = CallState.Established;

    // Wipe private exponent from memory
    this.privateExponent.fill(0);
    this.privateExponent = null;

    return authParams;
  }

  /**
   * Callee: handle PhoneCall update (received g_a_or_b and key_fingerprint).
   *
   * Verifies the g_a_hash commitment, derives shared key, validates fingerprint.
   */
  onCallConfirmed(gAOrB: Buffer, expectedFingerprint: bigint): AuthParams {
    if (this.state !== CallState.WaitingConfirm) {
      throw new DhExchangeError('INVALID_STATE', `Cannot process confirmed in state ${this.state}`);
    }
    if (this.isOutgoing) {
      throw new DhExchangeError('INVALID_STATE', 'Only the callee handles PhoneCall confirmed');
    }
    if (!this.privateExponent || !this.gAHash) {
      throw new DhExchangeError('INVALID_STATE', 'Missing private exponent or g_a_hash');
    }

    const authParams = calleeDeriveKey(gAOrB, this.gAHash, this.privateExponent, this.dhConfig, expectedFingerprint);
    this.sharedKey = authParams.key;
    this.fingerprint = authParams.keyFingerprint;
    this.gA = gAOrB; // Store for emoji verification
    this.state = CallState.Established;

    // Wipe private exponent from memory
    this.privateExponent.fill(0);
    this.privateExponent = null;

    return authParams;
  }

  /**
   * Get the emoji fingerprint for visual verification.
   * Both sides must call this after the exchange is established.
   */
  getEmojiFingerprint(): string[] {
    if (this.state !== CallState.Established || !this.sharedKey || !this.gA) {
      throw new DhExchangeError('INVALID_STATE', 'Key exchange must be established first');
    }
    return computeEmojiFingerprint(this.sharedKey, this.gA);
  }

  /**
   * Mark the call as discarded.
   */
  discard(): void {
    if (this.privateExponent) {
      this.privateExponent.fill(0);
      this.privateExponent = null;
    }
    this.state = CallState.Discarded;
  }

  /**
   * Mark the call as failed with an error.
   */
  fail(): void {
    if (this.privateExponent) {
      this.privateExponent.fill(0);
      this.privateExponent = null;
    }
    this.state = CallState.Failed;
  }
}

// ---------------------------------------------------------------------------
// updatePhoneCall dispatcher
// ---------------------------------------------------------------------------

export interface VoiceCallEventHandlers {
  /** Incoming call — you should present UI and call acceptCall or discardCall. */
  onCallRequested?: (call: PhoneCallRequested) => void;
  /** Callee accepted — caller should confirmCall with the derived key. */
  onCallAccepted?: (call: PhoneCallAccepted) => void;
  /** Call confirmed with encryption — both sides have the key. */
  onCallConfirmed?: (call: PhoneCallConfirmed) => void;
  /** Call was discarded (missed, declined, hung up). */
  onCallDiscarded?: (call: PhoneCallDiscarded) => void;
}

/**
 * Route an incoming updatePhoneCall to the appropriate handler.
 *
 * Call this from your MTProto update loop:
 * ```ts
 * mtproto.on('updatePhoneCall', (update) => {
 *   handlePhoneCallUpdate(update.phone_call, handlers);
 * });
 * ```
 */
export function handlePhoneCallUpdate(phoneCall: PhoneCallUpdate, handlers: VoiceCallEventHandlers): void {
  switch (phoneCall._) {
    case 'phoneCallRequested':
      handlers.onCallRequested?.(phoneCall);
      break;
    case 'phoneCallAccepted':
      handlers.onCallAccepted?.(phoneCall);
      break;
    case 'phoneCall':
      handlers.onCallConfirmed?.(phoneCall);
      break;
    case 'phoneCallDiscarded':
      handlers.onCallDiscarded?.(phoneCall);
      break;
  }
}

// ---------------------------------------------------------------------------
// Complete call orchestrator (full flow example)
// ---------------------------------------------------------------------------

/**
 * Abstracts the MTProto transport layer.
 * Implement this interface to connect to an actual MTProto client.
 */
export interface MtprotoTransport {
  invoke<T>(method: string, params: Record<string, unknown>): Promise<T>;
  onUpdate(handler: (update: { _: string; phoneCall?: PhoneCallUpdate }) => void): void;
}

/**
 * Full voice call orchestrator that manages the complete lifecycle.
 *
 * This is a reference implementation showing how all the pieces connect.
 * In production, adapt this to your specific MTProto client (GramJS, Telethon, etc.).
 */
export class VoiceCallOrchestrator {
  private exchanges = new Map<string, VoiceCallDhExchange>();
  private peers = new Map<string, InputPhoneCall>();
  private dhConfig: DhConfig | null = null;

  constructor(private transport: MtprotoTransport) {}

  /**
   * Fetch DH config from the server (messages.getDhConfig).
   * Should be called once before initiating or accepting calls.
   */
  async fetchDhConfig(): Promise<DhConfig> {
    const result = await this.transport.invoke<{
      _: string;
      g: number;
      p: Buffer;
      random: Buffer;
    }>('messages.getDhConfig', buildGetDhConfigPayload());
    this.dhConfig = { g: result.g, p: result.p, random: result.random };
    return this.dhConfig;
  }

  /**
   * Initiate an outgoing voice call.
   *
   * @returns The call ID and initial exchange data.
   */
  async requestCall(
    userId: bigint,
    userAccessHash: bigint,
    video = false,
  ): Promise<{ callId: string; exchange: VoiceCallDhExchange }> {
    if (!this.dhConfig) {
      await this.fetchDhConfig();
    }

    const exchange = new VoiceCallDhExchange(this.dhConfig!);
    const { gAHash } = exchange.initAsCaller();

    const payload = buildRequestCallPayload(userId, userAccessHash, gAHash, video);
    const result = await this.transport.invoke<{
      phoneCall: { id: bigint; accessHash: bigint };
    }>('phone.requestCall', payload as unknown as Record<string, unknown>);

    const callId = result.phoneCall.id.toString();
    this.exchanges.set(callId, exchange);
    this.peers.set(callId, {
      id: result.phoneCall.id,
      accessHash: result.phoneCall.accessHash,
    });

    return { callId, exchange };
  }

  /**
   * Accept an incoming call (called after receiving phoneCallRequested).
   */
  async acceptCall(call: PhoneCallRequested): Promise<{ callId: string; exchange: VoiceCallDhExchange }> {
    if (!this.dhConfig) {
      await this.fetchDhConfig();
    }

    const exchange = new VoiceCallDhExchange(this.dhConfig!);
    const { gB } = exchange.initAsCallee(call.gAHash);

    const peer: InputPhoneCall = { id: call.id, accessHash: call.accessHash };
    const payload = buildAcceptCallPayload(peer, gB);

    await this.transport.invoke('phone.acceptCall', payload as unknown as Record<string, unknown>);

    const callId = call.id.toString();
    this.exchanges.set(callId, exchange);
    this.peers.set(callId, peer);

    return { callId, exchange };
  }

  /**
   * Handle updatePhoneCall events.
   *
   * Automatically processes PhoneCallAccepted and PhoneCall updates.
   */
  async handleUpdate(phoneCall: PhoneCallUpdate): Promise<AuthParams | null> {
    if (phoneCall._ === 'phoneCallAccepted') {
      const callId = phoneCall.id.toString();
      const exchange = this.exchanges.get(callId);
      const peer = this.peers.get(callId);
      if (!exchange || !peer) return null;

      // Caller: derive key and confirm
      const authParams = exchange.onCallAccepted(phoneCall.gB);
      const payload = buildConfirmCallPayload(peer, authParams.gAOrB, authParams.keyFingerprint);
      await this.transport.invoke('phone.confirmCall', payload as unknown as Record<string, unknown>);

      return authParams;
    }

    if (phoneCall._ === 'phoneCall') {
      const callId = phoneCall.id.toString();
      const exchange = this.exchanges.get(callId);
      if (!exchange) return null;

      // Callee: verify g_a_hash and derive key
      const authParams = exchange.onCallConfirmed(phoneCall.gAOrB, phoneCall.keyFingerprint);
      return authParams;
    }

    if (phoneCall._ === 'phoneCallDiscarded') {
      const callId = phoneCall.id.toString();
      const exchange = this.exchanges.get(callId);
      if (exchange) {
        exchange.discard();
        this.exchanges.delete(callId);
        this.peers.delete(callId);
      }
    }

    return null;
  }

  /**
   * Discard (hang up / decline) a call.
   */
  async discardCall(callId: string, reason: DiscardReason = DiscardReason.Hangup): Promise<void> {
    const peer = this.peers.get(callId);
    if (!peer) return;

    const payload = buildDiscardCallPayload(peer, reason);
    await this.transport.invoke('phone.discardCall', payload as unknown as Record<string, unknown>);

    const exchange = this.exchanges.get(callId);
    if (exchange) exchange.discard();

    this.exchanges.delete(callId);
    this.peers.delete(callId);
  }

  /** Get the exchange for a call (for emoji verification etc.). */
  getExchange(callId: string): VoiceCallDhExchange | undefined {
    return this.exchanges.get(callId);
  }
}

// ---------------------------------------------------------------------------
// Error cases reference
// ---------------------------------------------------------------------------

/**
 * Error cases in the voice call DH exchange:
 *
 * From phone.requestCall:
 *   - PARTICIPANT_VERSION_OUTDATED — other user's app is too old
 *   - USER_PRIVACY_RESTRICTED — user's privacy settings block calls
 *   - USER_IS_BLOCKED — you blocked this user or vice versa
 *
 * From phone.acceptCall:
 *   - CALL_ALREADY_ACCEPTED — duplicate accept
 *   - CALL_ALREADY_DECLINED — call was already declined
 *   - CALL_OCCUPY_FAILED — user is already in another call
 *   - CALL_PROTOCOL_COMPAT_LAYER_INVALID — protocol version mismatch
 *   - CALL_PEER_INVALID — invalid call reference
 *
 * From phone.confirmCall:
 *   - CALL_ALREADY_DECLINED — call was declined after accept
 *   - CALL_PEER_INVALID — invalid call reference
 *
 * DH-specific:
 *   - DH_G_A_INVALID — g_a or g_b failed security checks
 *   - DH_PRIME_INVALID — DH prime from server is malformed
 *   - DH_G_A_HASH_MISMATCH — SHA-256(g_a) doesn't match g_a_hash (MITM!)
 *   - KEY_FINGERPRINT_MISMATCH — derived keys don't match (implementation bug)
 *
 * Timeouts:
 *   - The callee has ~30-60 seconds to accept before the call is missed
 *   - If no PhoneCallAccepted arrives, discard with reason Missed
 */

// ---------------------------------------------------------------------------
// Emoji list for visual key verification
// (This is a subset — Telegram uses 333 emoji, these are the first ones.
//  In production, use the full list from Telegram's source.)
// ---------------------------------------------------------------------------

const EMOJI_LIST: string[] = [
  '\u{1F609}',
  '\u{1F60D}',
  '\u{1F61B}',
  '\u{1F631}',
  '\u{1F621}',
  '\u{1F60E}',
  '\u{1F634}',
  '\u{1F635}',
  '\u{1F608}',
  '\u{1F62C}',
  '\u{1F607}',
  '\u{1F60F}',
  '\u{1F46E}',
  '\u{1F477}',
  '\u{1F482}',
  '\u{1F476}',
  '\u{1F468}',
  '\u{1F469}',
  '\u{1F474}',
  '\u{1F475}',
  '\u{1F63B}',
  '\u{1F63D}',
  '\u{1F640}',
  '\u{1F47A}',
  '\u{1F648}',
  '\u{1F649}',
  '\u{1F64A}',
  '\u{1F480}',
  '\u{1F47D}',
  '\u{1F4A9}',
  '\u{1F525}',
  '\u{1F4A5}',
  '\u{1F4A4}',
  '\u{1F442}',
  '\u{1F440}',
  '\u{1F443}',
  '\u{1F445}',
  '\u{1F444}',
  '\u{1F44D}',
  '\u{1F44E}',
  '\u{1F44C}',
  '\u{1F44A}',
  '\u{270C}',
  '\u{270B}',
  '\u{1F450}',
  '\u{1F446}',
  '\u{1F447}',
  '\u{1F449}',
  '\u{1F448}',
  '\u{1F64F}',
  '\u{1F44F}',
  '\u{1F4AA}',
  '\u{1F6B6}',
  '\u{1F3C3}',
  '\u{1F483}',
  '\u{1F46B}',
  '\u{1F46A}',
  '\u{1F46C}',
  '\u{1F46D}',
  '\u{1F485}',
  '\u{1F3A9}',
  '\u{1F451}',
  '\u{1F452}',
  '\u{1F45F}',
  '\u{1F45E}',
  '\u{1F460}',
  '\u{1F455}',
  '\u{1F457}',
  '\u{1F456}',
  '\u{1F459}',
  '\u{1F45C}',
  '\u{1F453}',
  '\u{1F380}',
  '\u{1F302}',
  '\u{1F484}',
  '\u{1F49B}',
  '\u{1F499}',
  '\u{1F49C}',
  '\u{1F49A}',
  '\u{1F48D}',
  '\u{1F48E}',
  '\u{1F436}',
  '\u{1F43A}',
  '\u{1F431}',
  '\u{1F42D}',
  '\u{1F439}',
  '\u{1F430}',
  '\u{1F438}',
  '\u{1F42F}',
  '\u{1F428}',
  '\u{1F43B}',
  '\u{1F437}',
  '\u{1F42E}',
  '\u{1F417}',
  '\u{1F435}',
  '\u{1F412}',
  '\u{1F434}',
  '\u{1F40E}',
  '\u{1F42B}',
  '\u{1F411}',
  '\u{1F418}',
  '\u{1F40D}',
  '\u{1F426}',
  '\u{1F424}',
  '\u{1F414}',
  '\u{1F427}',
  '\u{1F41B}',
  '\u{1F419}',
  '\u{1F420}',
  '\u{1F41F}',
  '\u{1F433}',
  '\u{1F40B}',
  '\u{1F42C}',
  '\u{1F404}',
  '\u{1F40C}',
  '\u{1F41A}',
  '\u{1F41D}',
  '\u{1F422}',
  '\u{1F40A}',
  '\u{1F43E}',
  '\u{1F490}',
  '\u{1F338}',
  '\u{1F337}',
  '\u{1F340}',
  '\u{1F339}',
  '\u{1F33B}',
  '\u{1F33A}',
  '\u{1F341}',
  '\u{1F343}',
  '\u{1F342}',
  '\u{1F334}',
  '\u{1F335}',
  '\u{1F33E}',
  '\u{1F33C}',
  '\u{1F31E}',
  '\u{1F31D}',
  '\u{1F31A}',
  '\u{1F311}',
  '\u{1F312}',
  '\u{1F313}',
  '\u{1F314}',
  '\u{1F315}',
  '\u{1F319}',
  '\u{1F304}',
  '\u{1F30A}',
  '\u{1F30B}',
  '\u{1F30C}',
  '\u{1F320}',
  '\u{2B50}',
  '\u{2600}',
  '\u{26C5}',
  '\u{2601}',
  '\u{26A1}',
  '\u{2614}',
  '\u{2744}',
  '\u{26C4}',
  '\u{1F300}',
  '\u{1F301}',
  '\u{1F308}',
  '\u{1F30A}',
  '\u{1F3E0}',
  '\u{1F3E2}',
  '\u{1F3E5}',
  '\u{1F3E6}',
  '\u{1F3EA}',
  '\u{1F3EB}',
  '\u{1F3E9}',
  '\u{26EA}',
  '\u{26F2}',
  '\u{1F3E8}',
  '\u{1F3EC}',
  '\u{1F3EF}',
  '\u{1F3F0}',
  '\u{26FA}',
  '\u{1F3ED}',
  '\u{1F5FC}',
  '\u{1F5FE}',
  '\u{1F5FB}',
  '\u{1F304}',
  '\u{1F305}',
  '\u{1F307}',
  '\u{1F306}',
  '\u{1F309}',
  '\u{1F3A0}',
  '\u{1F3A1}',
  '\u{26F5}',
  '\u{1F3A2}',
  '\u{1F6A2}',
  '\u{1F6A4}',
  '\u{2693}',
  '\u{1F680}',
  '\u{2708}',
  '\u{1F681}',
  '\u{1F682}',
  '\u{1F68B}',
  '\u{1F68E}',
  '\u{1F68C}',
  '\u{1F699}',
  '\u{1F697}',
  '\u{1F695}',
  '\u{1F69B}',
  '\u{1F6A8}',
  '\u{1F694}',
  '\u{1F692}',
  '\u{1F691}',
  '\u{1F693}',
  '\u{1F6B2}',
  '\u{1F6A1}',
  '\u{1F69F}',
  '\u{1F6A0}',
  '\u{1F6A7}',
  '\u{26FD}',
  '\u{1F3AF}',
  '\u{1F3C0}',
  '\u{26BD}',
  '\u{26BE}',
  '\u{1F3BE}',
  '\u{1F3B1}',
  '\u{1F3C9}',
  '\u{1F3B3}',
  '\u{1F3C7}',
  '\u{1F3C6}',
  '\u{1F3CA}',
  '\u{1F3C4}',
  '\u{1F3A3}',
  '\u{2615}',
  '\u{1F375}',
  '\u{1F376}',
  '\u{1F37A}',
  '\u{1F37B}',
  '\u{1F378}',
  '\u{1F379}',
  '\u{1F377}',
  '\u{1F374}',
  '\u{1F355}',
  '\u{1F354}',
  '\u{1F35F}',
  '\u{1F357}',
  '\u{1F371}',
  '\u{1F35A}',
  '\u{1F35C}',
  '\u{1F361}',
  '\u{1F363}',
  '\u{1F365}',
  '\u{1F359}',
  '\u{1F358}',
  '\u{1F35D}',
  '\u{1F35B}',
  '\u{1F362}',
  '\u{1F360}',
  '\u{1F34C}',
  '\u{1F34E}',
  '\u{1F34A}',
  '\u{1F353}',
  '\u{1F349}',
  '\u{1F345}',
  '\u{1F346}',
  '\u{1F34F}',
  '\u{1F351}',
  '\u{1F352}',
  '\u{1F34D}',
  '\u{1F347}',
  '\u{1F348}',
  '\u{1F350}',
  '\u{1F34B}',
  '\u{1F33D}',
  '\u{1F344}',
  '\u{1F330}',
  '\u{1F382}',
  '\u{1F370}',
  '\u{1F36A}',
  '\u{1F36B}',
  '\u{1F369}',
  '\u{1F368}',
  '\u{1F366}',
  '\u{1F367}',
  '\u{1F364}',
  '\u{1F36C}',
  '\u{1F36D}',
  '\u{1F36E}',
  '\u{1F36F}',
  '\u{1F373}',
  '\u{1F372}',
  '\u{1F32F}',
  '\u{1F32E}',
  '\u{1F32D}',
  '\u{1F37F}',
  '\u{1F3A4}',
  '\u{1F3A7}',
  '\u{1F3BC}',
  '\u{1F3B5}',
  '\u{1F3B6}',
  '\u{1F3A8}',
  '\u{1F3AD}',
  '\u{1F3AB}',
  '\u{1F3AC}',
  '\u{1F4F7}',
  '\u{1F4F9}',
  '\u{1F3AE}',
  '\u{1F47E}',
  '\u{1F3B2}',
  '\u{1F3B0}',
  '\u{1F0CF}',
  '\u{1F4E2}',
  '\u{1F514}',
  '\u{1F508}',
  '\u{1F4E3}',
  '\u{1F4AC}',
  '\u{1F4AD}',
  '\u{1F550}',
  '\u{1F551}',
  '\u{1F552}',
  '\u{1F553}',
  '\u{1F554}',
  '\u{1F555}',
  '\u{1F556}',
  '\u{1F557}',
  '\u{1F558}',
  '\u{1F559}',
  '\u{1F55A}',
  '\u{1F55B}',
  '\u{23F3}',
  '\u{231A}',
  '\u{23F0}',
  '\u{231B}',
  '\u{1F512}',
  '\u{1F513}',
  '\u{1F50F}',
  '\u{1F510}',
  '\u{1F511}',
  '\u{1F50E}',
  '\u{1F4A1}',
  '\u{1F526}',
  '\u{1F50C}',
];

// Pad to 333 entries if needed
while (EMOJI_LIST.length < 333) {
  EMOJI_LIST.push(`\u{2753}`); // question mark emoji as fallback
}
