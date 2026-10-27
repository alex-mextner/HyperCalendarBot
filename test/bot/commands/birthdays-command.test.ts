// Characterization of /birthdays: which group calendars are requested and how the reply is assembled.
import { describe, expect, mock, test } from 'bun:test';
import { handleBirthdays } from '../../../src/bot/commands/birthdays.ts';
import type { BirthdayDisplayItem, BirthdaysForDisplay } from '../../../src/services/birthday/birthday-service.ts';

type Args = Parameters<typeof handleBirthdays>;

function item(title: string, startAt: string, extra: Partial<BirthdayDisplayItem> = {}): BirthdayDisplayItem {
  return {
    event: { title, start_at: startAt } as BirthdayDisplayItem['event'],
    celebrantId: null,
    birthYear: null,
    username: null,
    ...extra,
  };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    dbUser: { telegram_id: 100, language: 'en' as const },
    chat: { type: 'private', id: 100 },
    send: mock(() => Promise.resolve()),
    ...overrides,
  };
}

function makeService(result: BirthdaysForDisplay) {
  return { getBirthdaysForDisplay: mock(() => result) };
}

async function run(
  ctx: ReturnType<typeof makeCtx>,
  service: ReturnType<typeof makeService>,
  groupChatRepo?: unknown,
  groupMemberRepo?: unknown,
) {
  await handleBirthdays(
    ctx as unknown as Args[0],
    service as unknown as Args[1],
    groupChatRepo as Args[2],
    groupMemberRepo as Args[3],
  );
}

const EMPTY: BirthdaysForDisplay = { personal: [], groups: [] };

describe('handleBirthdays', () => {
  test('does nothing without a db user', async () => {
    const ctx = makeCtx({ dbUser: undefined });
    const service = makeService(EMPTY);

    await run(ctx, service);

    expect(ctx.send).not.toHaveBeenCalled();
    expect(service.getBirthdaysForDisplay).not.toHaveBeenCalled();
  });

  test.each([
    ['en', 'No birthdays yet 🎂'],
    ['ru', 'Дней рождения пока нет 🎂'],
  ] as const)('empty result in %s says there are none', async (language, expected) => {
    const ctx = makeCtx({ dbUser: { telegram_id: 100, language } });

    await run(ctx, makeService(EMPTY));

    expect(ctx.send).toHaveBeenCalledTimes(1);
    expect(ctx.send).toHaveBeenCalledWith(expected);
  });

  test('groups without items count as empty', async () => {
    const ctx = makeCtx();
    const service = makeService({ personal: [], groups: [{ groupId: -1, title: 'G', items: [] }] });

    await run(ctx, service);

    expect(ctx.send).toHaveBeenCalledWith('No birthdays yet 🎂');
  });

  test('private chat requests every group the user belongs to, falling back to the id as title', async () => {
    const ctx = makeCtx();
    const service = makeService(EMPTY);
    const groupMemberRepo = {
      getGroupsForUser: mock(() => [
        { chat_id: -1, title: 'Team' },
        { chat_id: -2, title: null },
      ]),
    };

    await run(ctx, service, undefined, groupMemberRepo);

    expect(groupMemberRepo.getGroupsForUser).toHaveBeenCalledWith(100);
    expect(service.getBirthdaysForDisplay).toHaveBeenCalledWith(100, [
      { groupId: -1, title: 'Team' },
      { groupId: -2, title: '-2' },
    ]);
  });

  test('private chat without a member repository requests no groups', async () => {
    const ctx = makeCtx();
    const service = makeService(EMPTY);

    await run(ctx, service);

    expect(service.getBirthdaysForDisplay).toHaveBeenCalledWith(100, []);
  });

  test('group chat requests only that group, titled by the stored title', async () => {
    const ctx = makeCtx({ chat: { type: 'supergroup', id: -500 } });
    const service = makeService(EMPTY);
    const groupChatRepo = { findByChatId: mock(() => ({ title: 'Family' })) };
    const groupMemberRepo = { getGroupsForUser: mock(() => [{ chat_id: -1, title: 'Other' }]) };

    await run(ctx, service, groupChatRepo, groupMemberRepo);

    expect(groupChatRepo.findByChatId).toHaveBeenCalledWith(-500);
    expect(groupMemberRepo.getGroupsForUser).not.toHaveBeenCalled();
    expect(service.getBirthdaysForDisplay).toHaveBeenCalledWith(100, [{ groupId: -500, title: 'Family' }]);
  });

  test('group chat with an untitled group uses the chat id; unknown group requests nothing', async () => {
    const untitled = makeService(EMPTY);
    await run(makeCtx({ chat: { type: 'group', id: -7 } }), untitled, { findByChatId: () => ({ title: null }) });
    expect(untitled.getBirthdaysForDisplay).toHaveBeenCalledWith(100, [{ groupId: -7, title: '-7' }]);

    const unknown = makeService(EMPTY);
    await run(makeCtx({ chat: { type: 'group', id: -7 } }), unknown, { findByChatId: () => null });
    expect(unknown.getBirthdaysForDisplay).toHaveBeenCalledWith(100, []);

    const noRepo = makeService(EMPTY);
    await run(makeCtx({ chat: { type: 'group', id: -7 } }), noRepo);
    expect(noRepo.getBirthdaysForDisplay).toHaveBeenCalledWith(100, []);
  });

  test('renders personal then non-empty groups as HTML sections', async () => {
    const ctx = makeCtx();
    const service = makeService({
      personal: [
        item('Bday Ann', '2026-03-05T00:00:00Z', { birthYear: 1990, username: 'ann' }),
        item('Bday Bob', '2026-04-07T00:00:00Z', { celebrantId: 42 }),
      ],
      groups: [
        { groupId: -1, title: 'Empty <one>', items: [] },
        { groupId: -2, title: 'Team <b>', items: [item('Bday Cy', '2026-05-09T00:00:00Z', { birthYear: 2000 })] },
      ],
    });

    await run(ctx, service);

    const [text, options] = ctx.send.mock.calls[0] as unknown as [string, unknown];
    expect(options).toEqual({ parse_mode: 'HTML' });
    expect(text.split('\n')).toEqual([
      '🎂 <b>Birthdays</b>',
      '',
      '👤 <b>Personal calendar</b>',
      '• 🎁 Ann @ann — turns 36 (5 Mar)',
      '• 🎁 <a href="tg://user?id=42">Bob</a> (7 Apr)',
      '',
      '👥 <b>Team &lt;b&gt;</b>',
      '• 🎁 Cy — turns 26 (9 May)',
    ]);
  });

  test('groups-only result has no personal heading and uses Russian headings', async () => {
    const ctx = makeCtx({ dbUser: { telegram_id: 100, language: 'ru' } });
    const service = makeService({
      personal: [],
      groups: [{ groupId: -2, title: 'Команда', items: [item('Д/р Аня', '2026-05-09T00:00:00Z')] }],
    });

    await run(ctx, service);

    const text = (ctx.send.mock.calls[0] as unknown as [string])[0];
    expect(text.split('\n')).toEqual(['🎂 <b>Дни рождения</b>', '', '', '👥 <b>Команда</b>', '• 🎁 Аня (9 мая)']);
  });
});
