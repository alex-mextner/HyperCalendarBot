/**
 * CLI for testing voice call pipeline independently.
 * Usage: bun run scripts/test-call.ts <username_or_id> [text]
 */

import { TelegramClient } from '@mtcute/bun';
import { CallSignaling } from '../src/services/voice/call-signaling.ts';
import { TtsService } from '../src/services/voice/tts-service.ts';

const API_ID = Number(process.env.MTPROTO_API_ID);
const API_HASH = process.env.MTPROTO_API_HASH!;
const target = process.argv[2];
const ttsText = process.argv[3] ?? 'Привет! Это тестовый звонок от вашего календаря.';

if (!target || !API_ID || !API_HASH) {
  console.error('Usage: bun run scripts/test-call.ts <username_or_user_id> [text]');
  process.exit(1);
}

console.log(`Target: ${target}`);
console.log(`Text: ${ttsText}\n`);

// Step 1: TTS
console.log('[1/5] Synthesizing TTS...');
const tts = new TtsService();
const audio = await tts.synthesize(ttsText, 'ru');
console.log(`  ✅ Audio: ${audio.length} bytes`);

// Step 2: Connect MTProto
console.log('[2/5] Connecting MTProto...');
const client = new TelegramClient({
  apiId: API_ID,
  apiHash: API_HASH,
  storage: 'data/mtproto-session',
});
await client.connect();
console.log('  ✅ MTProto connected');

// Step 3: Resolve peer
console.log('[3/5] Resolving peer...');
const targetPeer = /^\d+$/.test(target) ? Number(target) : target;
let peer: { _: string; userId: number; accessHash: unknown };
try {
  peer = (await client.resolvePeer(targetPeer)) as typeof peer;
  console.log(`  ✅ Resolved: userId=${peer.userId}`);
} catch (e) {
  console.error(`  ❌ Failed to resolve peer: ${(e as Error).message}`);
  await client.destroy();
  process.exit(1);
}

// Step 4: Initiate call
console.log('[4/5] Initiating call...');
const callSignaling = new CallSignaling({
  callRaw: (method) => client.call(method as never) as Promise<unknown>,
  resolvePeer: async (userId) => ({
    userId,
    accessHash: peer.accessHash,
  }),
});

try {
  const callInfo = await callSignaling.initiateCall(peer.userId);
  console.log(`  ✅ Call initiated: callId=${callInfo.callId}`);

  // Step 5: Wait, then hang up
  console.log('[5/5] Ringing for 5s...');
  await new Promise((r) => setTimeout(r, 5000));
  await callSignaling.discardCall(callInfo.callId, callInfo.accessHash);
  console.log('  ✅ Call ended');
} catch (error) {
  console.error(`  ❌ Call failed: ${(error as Error).message}`);
}

await client.destroy();
process.exit(0);
