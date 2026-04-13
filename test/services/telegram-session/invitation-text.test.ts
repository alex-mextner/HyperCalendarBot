import { describe, expect, test } from 'bun:test';
import { buildUserSessionInvitationText } from '../../../src/services/telegram-session/invitation-text.ts';

const baseEvent = {
  title: 'Обед с Леной',
  start_utc: '2026-04-20T10:00:00Z',
  location: 'Кофемания',
  description: 'Обсудим новый проект',
};

describe('buildUserSessionInvitationText', () => {
  test('RU format: first person, date, location, description, deep link', () => {
    const text = buildUserSessionInvitationText({
      event: baseEvent,
      inviterTimezone: 'Europe/Moscow',
      deepLink: 'https://t.me/hypercal_bot?start=invite_123',
      lang: 'ru',
    });
    expect(text).toContain('Приглашаю тебя на «Обед с Леной»');
    expect(text).toContain('📅');
    expect(text).toContain('📍 Кофемания');
    expect(text).toContain('Обсудим новый проект');
    expect(text).toContain('https://t.me/hypercal_bot?start=invite_123');
    expect(text).not.toMatch(/^Привет/i);
  });

  test('EN format', () => {
    const text = buildUserSessionInvitationText({
      event: baseEvent,
      inviterTimezone: 'Europe/Moscow',
      deepLink: 'https://t.me/hypercal_bot?start=invite_123',
      lang: 'en',
    });
    expect(text).toContain('Inviting you to "Обед с Леной"');
  });

  test('omits location line when location is null', () => {
    const text = buildUserSessionInvitationText({
      event: { ...baseEvent, location: null },
      inviterTimezone: 'Europe/Moscow',
      deepLink: 'https://t.me/hypercal_bot?start=invite_123',
      lang: 'ru',
    });
    expect(text).not.toContain('📍');
  });

  test('truncates description to 100 chars', () => {
    const longDesc = 'x'.repeat(200);
    const text = buildUserSessionInvitationText({
      event: { ...baseEvent, description: longDesc },
      inviterTimezone: 'Europe/Moscow',
      deepLink: 'https://t.me/hypercal_bot?start=invite_123',
      lang: 'ru',
    });
    const lines = text.split('\n');
    const descLine = lines.find((l) => l.startsWith('x'));
    expect(descLine).toBeDefined();
    expect(descLine!.length).toBeLessThanOrEqual(101); // 100 + "…"
  });

  test('omits description line when null', () => {
    const text = buildUserSessionInvitationText({
      event: { ...baseEvent, description: null },
      inviterTimezone: 'Europe/Moscow',
      deepLink: 'https://t.me/hypercal_bot?start=invite_123',
      lang: 'ru',
    });
    expect(text).not.toContain('Обсудим');
  });
});
