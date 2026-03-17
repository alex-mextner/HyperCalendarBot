/**
 * Standalone auth script for MTProto voice call client
 * Run with: bun run scripts/mtproto-auth.ts
 *
 * Authenticates a Telegram user account that will be used for voice calls.
 * This should be a SEPARATE account from the bot owner — a virtual number.
 */

import { TelegramClient } from '@mtcute/bun';

const API_ID = Number(process.env.MTPROTO_API_ID);
const API_HASH = process.env.MTPROTO_API_HASH;

if (!API_ID || !API_HASH) {
  console.error('Error: MTPROTO_API_ID and MTPROTO_API_HASH are required in .env');
  process.exit(1);
}

const client = new TelegramClient({
  apiId: API_ID,
  apiHash: API_HASH,
  storage: 'data/mtproto-session',
});

console.log('Starting MTProto authentication for voice calls...');
console.log('Use a SEPARATE Telegram account (virtual number), not your main account.\n');

async function main() {
  const user = await client.start({
    phone: () => client.input('Enter phone number (with country code, e.g. +79001234567): '),
    code: () => client.input('Enter the code you received: '),
    password: () => client.input('Enter 2FA password (if enabled): '),
  });

  console.log(`\nSuccess! Logged in as ${user.displayName} (@${user.username ?? 'no username'})`);
  console.log(`User ID: ${user.id}`);
  console.log('\nSession saved to data/mtproto-session');
  console.log('Restart the bot to enable voice calls.');

  await client.destroy();
}

main().catch((err) => {
  console.error('Auth failed:', err);
  process.exit(1);
});
