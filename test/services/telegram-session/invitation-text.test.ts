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
    const { text } = buildUserSessionInvitationText({
      event: baseEvent,
      inviterTimezone: 'Europe/Moscow',
      deepLink: 'https://t.me/hypercal_bot?start=invite_123',
      botUsername: 'hypercal_bot',
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
    const { text } = buildUserSessionInvitationText({
      event: baseEvent,
      inviterTimezone: 'Europe/Moscow',
      deepLink: 'https://t.me/hypercal_bot?start=invite_123',
      botUsername: 'hypercal_bot',
      lang: 'en',
    });
    expect(text).toContain('Inviting you to "Обед с Леной"');
  });

  test('omits location line when location is null', () => {
    const { text } = buildUserSessionInvitationText({
      event: { ...baseEvent, location: null },
      inviterTimezone: 'Europe/Moscow',
      deepLink: 'https://t.me/hypercal_bot?start=invite_123',
      botUsername: 'hypercal_bot',
      lang: 'ru',
    });
    expect(text).not.toContain('📍');
  });

  test('truncates description to 100 chars', () => {
    const longDesc = 'x'.repeat(200);
    const { text } = buildUserSessionInvitationText({
      event: { ...baseEvent, description: longDesc },
      inviterTimezone: 'Europe/Moscow',
      deepLink: 'https://t.me/hypercal_bot?start=invite_123',
      botUsername: 'hypercal_bot',
      lang: 'ru',
    });
    const lines = text.split('\n');
    const descLine = lines.find((l) => l.startsWith('x'));
    expect(descLine).toBeDefined();
    expect(descLine!.length).toBeLessThanOrEqual(101); // 100 + "…"
  });

  test('omits description line when null', () => {
    const { text } = buildUserSessionInvitationText({
      event: { ...baseEvent, description: null },
      inviterTimezone: 'Europe/Moscow',
      deepLink: 'https://t.me/hypercal_bot?start=invite_123',
      botUsername: 'hypercal_bot',
      lang: 'ru',
    });
    expect(text).not.toContain('Обсудим');
  });

  test('verified location: shows the venue, the resolved address and a map link', () => {
    const { text } = buildUserSessionInvitationText({
      event: verifiedEvent,
      inviterTimezone: 'Europe/Moscow',
      deepLink: 'https://t.me/hypercal_bot?start=invite_123',
      botUsername: 'hypercal_bot',
      lang: 'ru',
    });
    expect(text).toContain(`📍 Кафе Ромашка — ул. Примерная, 1, Москва\n${MAP_URL}`);
    expect(text).not.toContain('кафе у парка');
    expect(text).toContain('https://t.me/hypercal_bot?start=invite_123');
  });

  test('unverified location: exactly the typed text, no address and no map link', () => {
    const { text } = buildUserSessionInvitationText({
      event: { ...verifiedEvent, location_verified: 0 },
      inviterTimezone: 'Europe/Moscow',
      deepLink: 'https://t.me/hypercal_bot?start=invite_123',
      botUsername: 'hypercal_bot',
      lang: 'ru',
    });
    expect(text).toContain('📍 кафе у парка\n');
    expect(text).not.toContain('Примерная');
    expect(text).not.toContain('Ромашка');
    expect(text).not.toContain('google.com/maps');
  });

  test('a place confirmed with a pin on an event without typed text is shown with its map link', () => {
    const { text } = buildUserSessionInvitationText({
      event: { ...verifiedEvent, location: null },
      inviterTimezone: 'Europe/Moscow',
      deepLink: 'https://t.me/hypercal_bot?start=invite_123',
      botUsername: 'hypercal_bot',
      lang: 'ru',
    });
    expect(text).toContain(`📍 Кафе Ромашка — ул. Примерная, 1, Москва\n${MAP_URL}`);
  });
});

describe('account invitation footer', () => {
  test.each([
    ['ru', 'Открой @CalendarStageBot, чтобы приглашать на свои встречи без email.'],
    ['en', 'Open @CalendarStageBot to invite people to your own meetings without email.'],
  ] as const)('adds one localized footer for %s using the actual bot username', (lang, footer) => {
    const { text, italicFooter } = buildUserSessionInvitationText({
      event: baseEvent,
      inviterTimezone: 'Europe/Moscow',
      deepLink: 'https://t.me/CalendarStageBot?start=invite_synthetic',
      botUsername: 'CalendarStageBot',
      lang,
    });
    expect(text.endsWith(`\n\n${footer}`)).toBe(true);
    expect(text.split('@CalendarStageBot')).toHaveLength(2);
    expect(text).toContain('https://t.me/CalendarStageBot?start=invite_synthetic');
    expect(text).not.toContain('@HyperCalendarBot');
    expect(text.slice(italicFooter!.offset, italicFooter!.offset + italicFooter!.length)).toBe(footer);
    expect(italicFooter!.offset + italicFooter!.length).toBe(text.length);
  });

  test('keeps meeting content literal and offsets the footer in UTF-16 after emoji', () => {
    const title = '🧑‍💻 Launch **title** <b>tag</b> __under__';
    const deepLink = 'https://t.me/CalendarStageBot?start=invite_synthetic';
    const mapUrl = 'https://www.google.com/maps/search/?api=1&query=Synthetic&query_place_id=ChIJ--ab__cd--x';
    const { text, italicFooter } = buildUserSessionInvitationText({
      event: { ...verifiedEvent, title, google_maps_url: mapUrl },
      inviterTimezone: 'UTC',
      deepLink,
      botUsername: 'CalendarStageBot',
      lang: 'en',
    });
    expect(text).toContain(title);
    expect(text).toContain(mapUrl);
    expect(text).toContain(deepLink);
    const prefix = text.slice(0, italicFooter!.offset);
    expect(italicFooter!.offset).toBe(Buffer.byteLength(prefix, 'utf16le') / 2);
    expect(italicFooter!.offset).toBeGreaterThan([...prefix].length);
    expect(text.slice(italicFooter!.offset)).toBe(
      'Open @CalendarStageBot to invite people to your own meetings without email.',
    );
    expect(text).not.toContain('<i>');
  });
});

test('keeps a footer at 4096 UTF-16 units and omits only the footer when it would overflow', () => {
  const input = {
    event: { ...baseEvent, title: '', location: null, description: null },
    inviterTimezone: 'UTC',
    deepLink: 'https://t.me/CalendarStageBot?start=invite_synthetic',
    botUsername: 'CalendarStageBot',
    lang: 'en' as const,
  };
  const fixedLength = buildUserSessionInvitationText(input).text.length;
  const fittingTitle = 'x'.repeat(4096 - fixedLength);
  const fitting = buildUserSessionInvitationText({ ...input, event: { ...input.event, title: fittingTitle } });
  expect(fitting.text.length).toBe(4096);
  expect(fitting.italicFooter).toBeDefined();
  const title = `${fittingTitle}x`;
  const overflowing = buildUserSessionInvitationText({ ...input, event: { ...input.event, title } });
  expect(overflowing.italicFooter).toBeUndefined();
  expect(overflowing.text.length).toBeLessThanOrEqual(4096);
  expect(overflowing.text).toContain(title);
  expect(overflowing.text.endsWith(input.deepLink)).toBe(true);
  expect(overflowing.text).not.toContain('@CalendarStageBot');
});
