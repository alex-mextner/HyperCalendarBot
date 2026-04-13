import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import type { TelegramSession } from '../../../src/database/types.ts';
import { encryptString } from '../../../src/services/crypto/session-crypto.ts';

function makeMasterKey(): Buffer {
  return randomBytes(32);
}

function makeSession(masterKey: Buffer, overrides: Partial<TelegramSession> = {}): TelegramSession {
  const phone = '+79001234567';
  return {
    user_id: 100,
    encrypted_session: Buffer.from('fake-session-data'),
    encrypted_phone: encryptString(phone, masterKey),
    phone_hash: 'abc123',
    status: 'active',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('buildTelegramView', () => {
  test('shows "not connected" when no session', async () => {
    const { buildTelegramView } = await import('../../../src/bot/commands/settings.ts');
    const masterKey = makeMasterKey();

    const { text, kb } = buildTelegramView(null, masterKey, 'en');

    expect(text).toContain('not connected');
    const kbJson = JSON.stringify(kb);
    expect(kbJson).toContain('stg:tg_connect');
    expect(kbJson).not.toContain('stg:tg_disconnect_confirm');
  });

  test('shows connected with masked phone in RU', async () => {
    const { buildTelegramView } = await import('../../../src/bot/commands/settings.ts');
    const masterKey = makeMasterKey();
    const session = makeSession(masterKey);

    const { text, kb } = buildTelegramView(session, masterKey, 'ru');

    expect(text).toContain('подключён');
    // Masked phone should show last 4 digits
    expect(text).toContain('4567');
    const kbJson = JSON.stringify(kb);
    expect(kbJson).toContain('stg:tg_disconnect_confirm');
    expect(kbJson).not.toContain('stg:tg_connect');
  });

  test('shows connected with masked phone in EN', async () => {
    const { buildTelegramView } = await import('../../../src/bot/commands/settings.ts');
    const masterKey = makeMasterKey();
    const session = makeSession(masterKey);

    const { text } = buildTelegramView(session, masterKey, 'en');

    expect(text).toContain('connected');
    expect(text).toContain('4567');
  });

  test('shows not connected for expired session', async () => {
    const { buildTelegramView } = await import('../../../src/bot/commands/settings.ts');
    const masterKey = makeMasterKey();
    const session = makeSession(masterKey, { status: 'expired' });

    const { text, kb } = buildTelegramView(session, masterKey, 'en');

    expect(text).toContain('not connected');
    const kbJson = JSON.stringify(kb);
    expect(kbJson).toContain('stg:tg_connect');
  });

  test('shows not connected for revoked session', async () => {
    const { buildTelegramView } = await import('../../../src/bot/commands/settings.ts');
    const masterKey = makeMasterKey();
    const session = makeSession(masterKey, { status: 'revoked' });

    const { text } = buildTelegramView(session, masterKey, 'ru');

    expect(text).toContain('не подключён');
  });

  test('shows fallback masked phone on decryption failure', async () => {
    const { buildTelegramView } = await import('../../../src/bot/commands/settings.ts');
    const masterKey = makeMasterKey();
    const wrongKey = makeMasterKey();
    const session = makeSession(masterKey);

    // Use wrong key to trigger decryption failure
    const { text } = buildTelegramView(session, wrongKey, 'en');

    expect(text).toContain('connected');
    expect(text).toContain('••••');
  });

  test('shows not connected when masterKey is null', async () => {
    const { buildTelegramView } = await import('../../../src/bot/commands/settings.ts');
    const masterKey = makeMasterKey();
    const session = makeSession(masterKey);

    const { text } = buildTelegramView(session, null, 'en');

    expect(text).toContain('not connected');
  });

  test('reconnect after revoke: new session shows active status', async () => {
    const { buildTelegramView } = await import('../../../src/bot/commands/settings.ts');
    const masterKey = makeMasterKey();

    // First: revoked session
    const revokedSession = makeSession(masterKey, { status: 'revoked' });
    const revokedResult = buildTelegramView(revokedSession, masterKey, 'en');
    expect(revokedResult.text).toContain('not connected');

    // Then: new active session after reconnect
    const newSession = makeSession(masterKey, { status: 'active' });
    const activeResult = buildTelegramView(newSession, masterKey, 'en');
    expect(activeResult.text).toContain('connected');
    expect(activeResult.text).toContain('4567');
  });
});

describe('settingsCategoryKeyboard', () => {
  test('includes telegram account button', async () => {
    const { settingsCategoryKeyboard } = await import('../../../src/bot/commands/settings.ts');
    const kb = settingsCategoryKeyboard('ru');
    const kbJson = JSON.stringify(kb);
    expect(kbJson).toContain('stg:telegram');
  });

  test('includes telegram account button in EN', async () => {
    const { settingsCategoryKeyboard } = await import('../../../src/bot/commands/settings.ts');
    const kb = settingsCategoryKeyboard('en');
    const kbJson = JSON.stringify(kb);
    expect(kbJson).toContain('stg:telegram');
  });
});
