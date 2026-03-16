export interface CallSignalingDeps {
  callRaw: (method: Record<string, unknown>) => Promise<unknown>;
}

interface CallInfo {
  callId: bigint;
  accessHash: bigint;
}

/**
 * Wraps MTProto phone call signaling: requestCall, discardCall.
 *
 * The callRaw dependency abstracts the actual MTProto transport
 * (TelegramClient.call or a mock for testing).
 *
 * When full E2E key exchange is needed, wire in VoiceCallDhExchange
 * from '../voice-call/dh-exchange' to generate proper g_a_hash
 * and handle the DH parameter exchange.
 */
export class CallSignaling {
  constructor(private deps: CallSignalingDeps) {}

  /**
   * Initiate a voice call to a user.
   *
   * @param userId - Telegram user ID (must be > 0)
   * @returns Call ID and access hash for further operations
   */
  async initiateCall(userId: number): Promise<CallInfo> {
    if (!userId || userId <= 0) throw new Error('Invalid user_id');

    const result = (await this.deps.callRaw({
      _: 'phone.requestCall',
      user_id: { _: 'inputUser', user_id: userId, access_hash: 0n },
      random_id: Math.floor(Math.random() * 0x7ffffffe) + 1,
      g_a_hash: Buffer.alloc(32),
      protocol: {
        _: 'phoneCallProtocol',
        udp_p2p: true,
        udp_reflector: true,
        min_layer: 92,
        max_layer: 92,
        library_versions: ['5.0.0', '4.0.0', '3.0.0'],
      },
    })) as { phone_call: { id: bigint; access_hash: bigint } };

    const phoneCall = result.phone_call;
    return {
      callId: phoneCall.id,
      accessHash: phoneCall.access_hash,
    };
  }

  /**
   * Discard (hang up) a call.
   */
  async discardCall(callId: bigint, accessHash: bigint): Promise<void> {
    await this.deps.callRaw({
      _: 'phone.discardCall',
      peer: {
        _: 'inputPhoneCall',
        id: callId,
        access_hash: accessHash,
      },
      duration: 0,
      reason: { _: 'phoneCallDiscardReasonHangup' },
      connection_id: 0n,
    });
  }
}
