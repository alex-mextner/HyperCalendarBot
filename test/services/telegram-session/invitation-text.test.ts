import { describe, expect, test } from 'bun:test';
import { buildUserSessionInvitationText } from '../../../src/services/telegram-session/invitation-text.ts';

const baseEvent = {
  title: 'Обед с Леной',
  start_at: '2026-04-20T10:00:00Z',
  location: 'Кофемания',
  description: 'Обсудим новый проект',
  resolved_address: null,
  venue_name: null,
  location_verified: 0,
  google_maps_url: null,
};

const MAP_URL = 'https://www.google.com/maps/search/?api=1&query=55.75,37.61&query_place_id=synthetic-place';
const verifiedEvent = {
  ...baseEvent,
  location: 'кафе у парка',
  resolved_address: 'ул. Примерная, 1, Москва',
  venue_name: 'Кафе Ромашка',
  location_verified: 1,
  google_maps_url: MAP_URL,
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

  test('verified location: shows the venue, the resolved address and a map link', () => {
    const text = buildUserSessionInvitationText({
      event: verifiedEvent,
      inviterTimezone: 'Europe/Moscow',
      deepLink: 'https://t.me/hypercal_bot?start=invite_123',
      lang: 'ru',
    });
    expect(text).toContain(`📍 Кафе Ромашка — ул. Примерная, 1, Москва\n${MAP_URL}`);
    expect(text).not.toContain('кафе у парка');
    expect(text).toContain('https://t.me/hypercal_bot?start=invite_123');
  });

  test('unverified location: exactly the typed text, no address and no map link', () => {
    const text = buildUserSessionInvitationText({
      event: { ...verifiedEvent, location_verified: 0 },
      inviterTimezone: 'Europe/Moscow',
      deepLink: 'https://t.me/hypercal_bot?start=invite_123',
      lang: 'ru',
    });
    expect(text).toContain('📍 кафе у парка\n');
    expect(text).not.toContain('Примерная');
    expect(text).not.toContain('Ромашка');
    expect(text).not.toContain('google.com/maps');
  });

  test('a place confirmed with a pin on an event without typed text is shown with its map link', () => {
    const text = buildUserSessionInvitationText({
      event: { ...verifiedEvent, location: null },
      inviterTimezone: 'Europe/Moscow',
      deepLink: 'https://t.me/hypercal_bot?start=invite_123',
      lang: 'ru',
    });
    expect(text).toContain(`📍 Кафе Ромашка — ул. Примерная, 1, Москва\n${MAP_URL}`);
  });
});
