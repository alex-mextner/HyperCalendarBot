#!/usr/bin/env bun
/**
 * Re-encrypt all Telegram sessions with a new master key.
 * Usage: OLD_KEY=<64hex> NEW_KEY=<64hex> bun scripts/rotate-session-master-key.ts
 */
import { Database } from 'bun:sqlite';
import { decryptBlob, encryptBlob } from '../src/services/crypto/session-crypto.ts';

const OLD_KEY_HEX = process.env.OLD_KEY;
const NEW_KEY_HEX = process.env.NEW_KEY;

if (!OLD_KEY_HEX || !/^[0-9a-f]{64}$/i.test(OLD_KEY_HEX)) {
  console.error('OLD_KEY must be 64 hex chars');
  process.exit(1);
}
if (!NEW_KEY_HEX || !/^[0-9a-f]{64}$/i.test(NEW_KEY_HEX)) {
  console.error('NEW_KEY must be 64 hex chars');
  process.exit(1);
}
if (OLD_KEY_HEX === NEW_KEY_HEX) {
  console.error('OLD_KEY and NEW_KEY are the same');
  process.exit(1);
}

const oldKey = Buffer.from(OLD_KEY_HEX, 'hex');
const newKey = Buffer.from(NEW_KEY_HEX, 'hex');

const db = new Database('data/bot.db');
db.exec('PRAGMA journal_mode=WAL');

interface Row {
  user_id: number;
  encrypted_session: Buffer;
  encrypted_phone: Buffer;
}

const rows = db
  .prepare('SELECT user_id, encrypted_session, encrypted_phone FROM user_telegram_sessions')
  .all() as Row[];

if (rows.length === 0) {
  console.log('No sessions to rotate.');
  process.exit(0);
}

console.log(`Found ${rows.length} session(s). Verifying OLD_KEY can decrypt all...`);

// Phase 1: verify all decrypt with old key (abort if any fail)
const decrypted: Array<{ userId: number; session: Buffer; phone: Buffer }> = [];
for (const row of rows) {
  try {
    const session = decryptBlob(Buffer.from(row.encrypted_session), oldKey);
    const phone = decryptBlob(Buffer.from(row.encrypted_phone), oldKey);
    decrypted.push({ userId: row.user_id, session, phone });
  } catch {
    console.error(`Failed to decrypt session for user ${row.user_id} — aborting. Is OLD_KEY correct?`);
    process.exit(1);
  }
}

// Phase 2: re-encrypt and update in a single transaction
console.log('All sessions decrypted successfully. Re-encrypting with NEW_KEY...');

const update = db.prepare(
  `UPDATE user_telegram_sessions SET encrypted_session = ?, encrypted_phone = ?, updated_at = datetime('now') WHERE user_id = ?`,
);

db.transaction(() => {
  for (const { userId, session, phone } of decrypted) {
    const newSession = encryptBlob(session, newKey);
    const newPhone = encryptBlob(phone, newKey);
    update.run(newSession, newPhone, userId);
  }
})();

console.log(
  `Done: rotated ${decrypted.length} session(s). Update TELEGRAM_SESSION_MASTER_KEY to NEW_KEY and restart the bot.`,
);
