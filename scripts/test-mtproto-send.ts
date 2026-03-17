/**
 * Test MTProto message sending directly.
 * Usage: bun run scripts/test-mtproto-send.ts <username_or_id> [message]
 */

const target = process.argv[2];
const message = process.argv[3] ?? 'Тестовое сообщение от виртуального пользователя 📅';

if (!target) {
  console.error('Usage: bun run scripts/test-mtproto-send.ts <username_or_id> [message]');
  process.exit(1);
}

const API_ID = Number(process.env.MTPROTO_API_ID);
const API_HASH = process.env.MTPROTO_API_HASH!;

if (!API_ID || !API_HASH) {
  console.error('MTPROTO_API_ID and MTPROTO_API_HASH required in .env');
  process.exit(1);
}

console.log(`[1/4] Config: API_ID=${API_ID}, target=${target}`);

const { TelegramClient } = await import('@mtcute/bun');

const client = new TelegramClient({
  apiId: API_ID,
  apiHash: API_HASH,
  storage: 'data/mtproto-session',
});

console.log('[2/4] Connecting MTProto client...');
await client.connect();
console.log('  ✅ Connected');

const me = await client.getMe();
console.log(`  ✅ Logged in as: ${me.displayName} (@${me.username ?? 'no-username'}), id=${me.id}`);

// Try resolving the peer first
console.log(`[3/4] Resolving peer: ${target}`);
try {
  const isNumeric = /^\d+$/.test(target);

  if (isNumeric) {
    console.log(`  Trying by numeric ID: ${target}`);
    try {
      const result = await client.sendText(Number(target), message);
      console.log(`  ✅ Sent by ID! message_id=${result.id}`);
      await client.close();
      process.exit(0);
    } catch (e) {
      console.log(`  ❌ By ID failed: ${e}`);
      console.log('  Will NOT try username fallback (no username provided)');
      await client.close();
      process.exit(1);
    }
  }

  // By username
  console.log(`  Trying by username: ${target}`);
  try {
    const resolved = await client.resolvePeer(target);
    console.log(`  ✅ Peer resolved:`, JSON.stringify(resolved));
  } catch (e) {
    console.log(`  ⚠️ resolvePeer failed: ${e}`);
    console.log('  Will try sendText directly anyway...');
  }

  console.log(`[4/4] Sending message to @${target}...`);
  const result = await client.sendText(target, message);
  console.log(`  ✅ Message sent! message_id=${result.id}`);
} catch (error) {
  console.error(`  ❌ FAILED: ${error}`);
  console.error(`  Full error:`, error);
}

await client.close();
