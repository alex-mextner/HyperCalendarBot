import {
  buildConfirmCallPayload,
  buildDiscardCallPayload,
  buildGetDhConfigPayload,
  buildRequestCallPayload,
  type CallerExchangeInit,
  callerDeriveKey,
  callerInitExchange,
  type DhConfig,
} from '../voice-call/dh-exchange';
import { voiceLogger } from './types';

export interface CallSignalingDeps {
  callRaw: (method: Record<string, unknown>) => Promise<unknown>;
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

    // Step 3: Send phone.requestCall with proper g_a_hash
    const payload = buildRequestCallPayload(
      BigInt(userId),
      0n, // access_hash — will be resolved by MTProto layer
      exchange.gAHash,
    );

    const result = (await this.deps.callRaw(payload as unknown as Record<string, unknown>)) as {
      phone_call: { id: bigint; access_hash: bigint };
    };

    voiceLogger.info({ userId, callId: String(result.phone_call.id) }, 'Call initiated with DH exchange');

    return {
      callId: result.phone_call.id,
      accessHash: result.phone_call.access_hash,
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
    const payload = buildDiscardCallPayload({ id: callId, accessHash }, 'phoneCallDiscardReasonHangup');
    await this.deps.callRaw(payload as unknown as Record<string, unknown>);
    this.pendingExchange = null;
  }

  private async fetchDhConfig(): Promise<DhConfig> {
    const payload = buildGetDhConfigPayload();
    const result = (await this.deps.callRaw(payload as unknown as Record<string, unknown>)) as {
      g: number;
      p: Buffer;
      random: Buffer;
    };
    return { g: result.g, p: result.p, random: result.random };
  }
}
