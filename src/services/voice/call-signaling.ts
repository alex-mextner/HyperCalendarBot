import {
  buildConfirmCallPayload,
  buildDiscardCallPayload,
  buildGetDhConfigPayload,
  type CallerExchangeInit,
  callerDeriveKey,
  callerInitExchange,
  type DhConfig,
  DiscardReason,
} from '../voice-call/dh-exchange';
import { voiceLogger } from './types';

export interface CallSignalingDeps {
  callRaw: (method: Record<string, unknown>) => Promise<unknown>;
  resolvePeer?: (userId: number) => Promise<{ userId: number; accessHash: unknown }>;
}

interface CallInfo {
  callId: bigint;
  accessHash: bigint;
}

interface EstablishedCall extends CallInfo {
  authKey: Buffer;
  keyFingerprint: bigint;
}

/**
 * Wraps MTProto phone call signaling with full DH key exchange.
 *
 * Flow:
 *   1. getDhConfig → get DH parameters from Telegram
 *   2. callerInitExchange → generate g_a, g_a_hash
 *   3. phone.requestCall → ring the user (sends g_a_hash)
 *   4. Wait for PhoneCallAccepted (contains g_b)
 *   5. callerDeriveKey → compute shared secret
 *   6. phone.confirmCall → send g_a + key fingerprint
 *   7. Call established — authKey ready for ntgcalls
 */
export class CallSignaling {
  private dhConfig: DhConfig | null = null;
  private pendingExchange: CallerExchangeInit | null = null;

  constructor(private deps: CallSignalingDeps) {}

  async initiateCall(userId: number): Promise<CallInfo> {
    if (!userId || userId <= 0) throw new Error('Invalid user_id');

    // Step 1: Get DH config
    if (!this.dhConfig) {
      this.dhConfig = await this.fetchDhConfig();
    }

    // Step 2: Generate DH keys
    const exchange = callerInitExchange(this.dhConfig);
    this.pendingExchange = exchange;

    // Step 3: Resolve peer to get accessHash, then send phone.requestCall
    let resolvedAccessHash: unknown = 0;
    if (this.deps.resolvePeer) {
      const peer = await this.deps.resolvePeer(userId);
      resolvedAccessHash = peer.accessHash;
    }
    const payload = {
      _: 'phone.requestCall',
      userId: { _: 'inputUser', userId, accessHash: resolvedAccessHash },
      randomId: Math.floor(Math.random() * 0x7ffffffe) + 1,
      gAHash: exchange.gAHash,
      protocol: {
        _: 'phoneCallProtocol',
        flags: 3,
        udpP2p: true,
        udpReflector: true,
        minLayer: 92,
        maxLayer: 92,
        libraryVersions: ['7.0.0'],
      },
    };

    const rawResult = await this.deps.callRaw(payload as unknown as Record<string, unknown>);
    voiceLogger.info(
      { rawResult: JSON.stringify(rawResult, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 500) },
      'phone.requestCall response',
    );
    const result = rawResult as {
      phone_call?: { id: bigint; access_hash: bigint };
      phoneCall?: { id: bigint; accessHash: bigint };
    };

    // mtcute may use camelCase or snake_case depending on version
    const phoneCall = result.phoneCall ?? result.phone_call;
    if (!phoneCall) throw new Error('No phone_call in response');

    voiceLogger.info({ userId, callId: String(phoneCall.id) }, 'Call initiated with DH exchange');

    const accessHash =
      (phoneCall as Record<string, unknown>).accessHash ?? (phoneCall as Record<string, unknown>).access_hash;
    return {
      callId: phoneCall.id,
      accessHash: accessHash as bigint,
    };
  }

  /**
   * Handle PhoneCallAccepted update — complete DH exchange.
   * Called when the callee answers the call.
   */
  async confirmCall(callId: bigint, accessHash: bigint, gB: Buffer): Promise<EstablishedCall> {
    if (!this.pendingExchange || !this.dhConfig) {
      throw new Error('No pending exchange — initiateCall must be called first');
    }

    const { gA, privateExponent } = this.pendingExchange;
    const authParams = callerDeriveKey(gB, privateExponent, this.dhConfig, gA);

    const payload = buildConfirmCallPayload({ id: callId, accessHash }, gA, authParams.keyFingerprint);

    await this.deps.callRaw(payload as unknown as Record<string, unknown>);

    // Wipe private exponent
    this.pendingExchange = null;

    voiceLogger.info({ callId: String(callId) }, 'Call confirmed with DH key exchange');

    return {
      callId,
      accessHash,
      authKey: authParams.key,
      keyFingerprint: authParams.keyFingerprint,
    };
  }

  async discardCall(callId: bigint, accessHash: bigint): Promise<void> {
    const payload = buildDiscardCallPayload({ id: callId, accessHash }, DiscardReason.Hangup);
    await this.deps.callRaw(payload as unknown as Record<string, unknown>);
    this.pendingExchange = null;
  }

  private async fetchDhConfig(): Promise<DhConfig> {
    const payload = buildGetDhConfigPayload();
    const result = (await this.deps.callRaw(payload as unknown as Record<string, unknown>)) as {
      g: number;
      p: Uint8Array | Buffer;
      random: Uint8Array | Buffer;
    };
    // mtcute may return Uint8Array — ensure Buffer for BigInt conversion
    return {
      g: result.g,
      p: Buffer.isBuffer(result.p) ? result.p : Buffer.from(result.p),
      random: Buffer.isBuffer(result.random) ? result.random : Buffer.from(result.random),
    };
  }
}
