// Edge routing of /holidays and hl:* callbacks that the main holidays suite does not pin.
import { describe, expect, mock, test } from 'bun:test';
import { handleHolidayCallback, handleHolidays } from '../../../src/bot/commands/holidays.ts';

const user = { telegram_id: 100, language: 'en' as const, timezone: 'UTC' };

function makeCallbackCtx() {
  return {
    answer: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
  };
}

describe('handleHolidayCallback unknown actions', () => {
  test.each([
    '',
    'bogus',
    'constructor',
    'toString',
    '__proto__',
    'hasOwnProperty',
  ])('payload "%s" does nothing at all', async (payload) => {
    const ctx = makeCallbackCtx();
    const service = { getSubscriptions: mock(() => []) };

    await handleHolidayCallback(ctx as never, service as never, user as never, payload);

    expect(ctx.answer).not.toHaveBeenCalled();
    expect(ctx.editText).not.toHaveBeenCalled();
    expect(service.getSubscriptions).not.toHaveBeenCalled();
  });

  test('user without a language falls back to English', async () => {
    const ctx = makeCallbackCtx();
    const service = { getSubscriptions: mock(() => []), getCountryName: mock((c: string) => c) };

    await handleHolidayCallback(ctx as never, service as never, { ...user, language: undefined } as never, 'manage');

    expect((ctx.editText.mock.calls[0] as unknown[])[0]).toContain('No countries added yet');
  });
});

describe('handleHolidays in a group', () => {
  function makeGroupCtx(language: 'en' | 'ru') {
    return {
      args: null,
      dbUser: { ...user, language },
      chat: { type: 'supergroup', id: -100 },
      send: mock(() => Promise.resolve()),
    };
  }

  test('without a configured country asks for one in English', async () => {
    const ctx = makeGroupCtx('en');
    const groupRepo = { findByChatId: mock(() => ({ country: null })) };

    await handleHolidays(ctx as never, {} as never, groupRepo as never);

    expect(ctx.send).toHaveBeenCalledWith('🏳️ Set the group country first via /settings');
  });

  test('without a group repository asks for a country too', async () => {
    const ctx = makeGroupCtx('ru');

    await handleHolidays(ctx as never, {} as never);

    expect(ctx.send).toHaveBeenCalledWith('🏳️ Сначала задайте страну группы через /settings');
  });

  test.each([
    ['en', '🎉 Rus &amp; Co — no upcoming holidays'],
    ['ru', '🎉 Rus &amp; Co — праздников не найдено'],
  ] as const)('with no upcoming holidays says so in %s', async (language, expected) => {
    const ctx = makeGroupCtx(language);
    const groupRepo = { findByChatId: mock(() => ({ country: 'RU' })) };
    const service = { getUpcomingForCountry: mock(() => []), getCountryName: mock(() => 'Rus & Co') };

    await handleHolidays(ctx as never, service as never, groupRepo as never);

    expect(ctx.send).toHaveBeenCalledWith(expected, { parse_mode: 'HTML' });
  });

  test('ignores the "list" argument and lists the group country holidays', async () => {
    const ctx = { ...makeGroupCtx('en'), args: 'list' };
    const groupRepo = { findByChatId: mock(() => ({ country: 'RU' })) };
    const service = {
      getUpcomingForCountry: mock(() => [{ date: '2026-01-01', name: 'A <b>' }]),
      getCountryName: mock(() => 'Russia'),
      getUpcomingHolidays: mock(() => []),
    };

    await handleHolidays(ctx as never, service as never, groupRepo as never);

    expect(ctx.send).toHaveBeenCalledWith('🎉 <b>Russia</b>\n\n2026-01-01 — A &lt;b&gt;', { parse_mode: 'HTML' });
    expect(service.getUpcomingHolidays).not.toHaveBeenCalled();
  });
});
