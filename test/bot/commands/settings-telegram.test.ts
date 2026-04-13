import { describe, expect, test } from 'bun:test';
import type { TelegramSession } from '../../../src/database/types.ts';

function makeSession(overrides: Partial<TelegramSession> = {}): TelegramSession {
  return {
    user_id: 100,
    encrypted_session: Buffer.from('fake-session-data'),
    phone_masked: '+7 ••• 4567',
    phone_hash: 'abc123',
    status: 'active',
    tz_detection_consent_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('buildTelegramView', () => {
  test('shows "not connected" when no session', async () => {
    const { buildTelegramView } = await import('../../../src/bot/commands/settings.ts');

    const { text, kb } = buildTelegramView(null, 'en');

    expect(text).toContain('not connected');
    const kbJson = JSON.stringify(kb);
    expect(kbJson).toContain('stg:tg_connect');
    expect(kbJson).not.toContain('stg:tg_disconnect_confirm');
  });

  test('shows connected with masked phone in RU', async () => {
    const { buildTelegramView } = await import('../../../src/bot/commands/settings.ts');
    const session = makeSession();

    const { text, kb } = buildTelegramView(session, 'ru');

    expect(text).toContain('подключён');
    // Masked phone should show last 4 digits
    expect(text).toContain('4567');
    const kbJson = JSON.stringify(kb);
    expect(kbJson).toContain('stg:tg_disconnect_confirm');
    expect(kbJson).not.toContain('stg:tg_connect');
  });

  test('shows connected with masked phone in EN', async () => {
    const { buildTelegramView } = await import('../../../src/bot/commands/settings.ts');
    const session = makeSession();

    const { text } = buildTelegramView(session, 'en');

    expect(text).toContain('connected');
    expect(text).toContain('4567');
  });

  test('shows not connected for expired session', async () => {
    const { buildTelegramView } = await import('../../../src/bot/commands/settings.ts');
    const session = makeSession({ status: 'expired' });

    const { text, kb } = buildTelegramView(session, 'en');

    expect(text).toContain('not connected');
    const kbJson = JSON.stringify(kb);
    expect(kbJson).toContain('stg:tg_connect');
  });

  test('shows not connected for revoked session', async () => {
    const { buildTelegramView } = await import('../../../src/bot/commands/settings.ts');
    const session = makeSession({ status: 'revoked' });

    const { text } = buildTelegramView(session, 'ru');

    expect(text).toContain('не подключён');
  });

  test('shows phone_masked directly without decryption', async () => {
    const { buildTelegramView } = await import('../../../src/bot/commands/settings.ts');
    const session = makeSession({ phone_masked: '+1 ••• 9999' });

    const { text } = buildTelegramView(session, 'en');

    expect(text).toContain('connected');
    expect(text).toContain('+1 ••• 9999');
  });

  test('reconnect after revoke: new session shows active status', async () => {
    const { buildTelegramView } = await import('../../../src/bot/commands/settings.ts');

    // First: revoked session
    const revokedSession = makeSession({ status: 'revoked' });
    const revokedResult = buildTelegramView(revokedSession, 'en');
    expect(revokedResult.text).toContain('not connected');

    // Then: new active session after reconnect
    const newSession = makeSession({ status: 'active' });
    const activeResult = buildTelegramView(newSession, 'en');
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
