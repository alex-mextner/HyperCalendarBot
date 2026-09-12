import { expect, test } from 'bun:test';
import { SessionBridge } from '../../src/services/telegram-session/session-bridge.ts';
import { formatSessionLoss } from '../../src/services/telegram-session/session-loss.ts';

test('a confirmed revocation is distinguished from unknown expiry', () => {
  const parsed = SessionBridge.parseResult(JSON.stringify({ error: 'SESSION_EXPIRED', reason: 'revoked' }), '', 1);
  expect(parsed).toMatchObject({ success: false, error: 'SESSION_EXPIRED', reason: 'revoked' });
  const text = formatSessionLoss('ru', 'revoked', '2026-09-12T10:00:00.000Z');
  expect(text).toContain('Telegram сообщил');
  expect(text).toContain('Обнаружено');
  expect(text).toContain('/connect_telegram');
  expect(text).not.toContain('ты отозвал');
  expect(text).not.toContain('Нидерланд');
});
test('unknown or local credential loss never blames a user action', () => {
  for (const reason of ['expired', 'local'] as const) {
    const text = formatSessionLoss('ru', reason, '2026-09-12T10:00:00.000Z');
    expect(text).toContain('/connect_telegram');
    expect(text).toContain('Календарь');
    expect(text).not.toContain('отозвал');
    expect(text).not.toContain('сменил пароль');
  }
});
test('English notice explains the affected feature and recovery', () => {
  const text = formatSessionLoss('en', 'expired', '2026-09-12T10:00:00.000Z');
  expect(text).toContain('invitations');
  expect(text).toContain('/connect_telegram');
  expect(text).toContain('Detected');
});
test('invalid observation time is not shown as a factual timestamp', () => {
  expect(() => formatSessionLoss('en', 'expired', 'not a time')).toThrow();
});

test('account deactivation has its own diagnosis, not an expired-password accusation', () => {
  const text = formatSessionLoss('en', 'account_unavailable');
  expect(text).toContain('account is deactivated');
  expect(text).not.toContain('undefined');
  expect(formatSessionLoss('ru', 'account_unavailable')).toContain('аккаунт отключён');
});
