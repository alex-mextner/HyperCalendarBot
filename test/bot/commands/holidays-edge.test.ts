// Edge routing of /holidays and hl:* callbacks that the main holidays suite does not pin.
import { describe, expect, mock, test } from 'bun:test';
import { handleHolidayCallback, handleHolidays } from '../../../src/bot/commands/holidays.ts';
import type { GroupChatRepository } from '../../../src/database/repositories/group-chat.repository.ts';
import type { GroupChat, User } from '../../../src/database/types.ts';
import type { HolidayEntry } from '../../../src/services/holiday/holiday-service.ts';
import { stub } from '../partial-stub.ts';
import { makeUserRow, sentMessage, telegramChat } from '../telegram-fixtures.ts';

const user = makeUserRow({ telegram_id: 100, language: 'en', timezone: 'UTC' });

function makeCallbackCtx() {
  return {
    answer: mock(() => Promise.resolve(true as const)),
    editText: mock(() => Promise.resolve(sentMessage())),
  };
}

function makeGroupRow(country: string | null): GroupChat {
  return {
    chat_id: -100,
    title: 'Team',
    added_by: 100,
    added_at: '2026-01-01 00:00:00',
    is_active: 1,
    pin_hint_shown: 0,
    timezone: null,
    country,
    invite_link: null,
  };
}

function makeHoliday(date: string, name: string): HolidayEntry {
  return { date, name, type: 'public', countryCode: 'RU', countryName: 'Russia' };
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

    await handleHolidayCallback(stub(ctx), stub(service), user, payload);

    expect(ctx.answer).not.toHaveBeenCalled();
    expect(ctx.editText).not.toHaveBeenCalled();
    expect(service.getSubscriptions).not.toHaveBeenCalled();
  });

  test('user without a language falls back to English', async () => {
    const ctx = makeCallbackCtx();
    const service = { getSubscriptions: mock(() => []), getCountryName: mock((c: string) => c) };
    // Negative case: a stored row that lacks the language column, which the typed User model forbids.
    // JSON.parse is typed `any`, the same way a stored value reaches the code at runtime.
    const rowWithoutLanguage: User = JSON.parse(JSON.stringify({ ...user, language: undefined }));

    await handleHolidayCallback(stub(ctx), stub(service), rowWithoutLanguage, 'manage');

    expect((ctx.editText.mock.calls[0] as unknown[])[0]).toContain('No countries added yet');
  });
});

describe('handleHolidays in a group', () => {
  function makeGroupCtx(language: 'en' | 'ru') {
    return {
      args: null,
      dbUser: makeUserRow({ ...user, language }),
      chat: telegramChat('supergroup', -100),
      send: mock(() => Promise.resolve(sentMessage())),
    };
  }

  test('without a configured country asks for one in English', async () => {
    const ctx = makeGroupCtx('en');
    const groupRepo = { findByChatId: mock(() => makeGroupRow(null)) };

    await handleHolidays(stub(ctx), stub({}), stub<GroupChatRepository>(groupRepo));

    expect(ctx.send).toHaveBeenCalledWith('🏳️ Set the group country first via /settings');
  });

  test('without a group repository asks for a country too', async () => {
    const ctx = makeGroupCtx('ru');

    await handleHolidays(stub(ctx), stub({}));

    expect(ctx.send).toHaveBeenCalledWith('🏳️ Сначала задайте страну группы через /settings');
  });

  test.each([
    ['en', '🎉 Rus &amp; Co — no upcoming holidays'],
    ['ru', '🎉 Rus &amp; Co — праздников не найдено'],
  ] as const)('with no upcoming holidays says so in %s', async (language, expected) => {
    const ctx = makeGroupCtx(language);
    const groupRepo = { findByChatId: mock(() => makeGroupRow('RU')) };
    const service = { getUpcomingForCountry: mock(() => []), getCountryName: mock(() => 'Rus & Co') };

    await handleHolidays(stub(ctx), stub(service), stub<GroupChatRepository>(groupRepo));

    expect(ctx.send).toHaveBeenCalledWith(expected, { parse_mode: 'HTML' });
  });

  test('ignores the "list" argument and lists the group country holidays', async () => {
    const ctx = { ...makeGroupCtx('en'), args: 'list' };
    const groupRepo = { findByChatId: mock(() => makeGroupRow('RU')) };
    const service = {
      getUpcomingForCountry: mock(() => [makeHoliday('2026-01-01', 'A <b>')]),
      getCountryName: mock(() => 'Russia'),
      getUpcomingHolidays: mock(() => []),
    };

    await handleHolidays(stub(ctx), stub(service), stub<GroupChatRepository>(groupRepo));

    expect(ctx.send).toHaveBeenCalledWith('🎉 <b>Russia</b>\n\n2026-01-01 — A &lt;b&gt;', { parse_mode: 'HTML' });
    expect(service.getUpcomingHolidays).not.toHaveBeenCalled();
  });
});
