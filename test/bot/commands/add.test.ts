import { afterEach, expect, mock, test } from 'bun:test';
import { Scene } from '@gramio/scenes';
import { handleAdd } from '../../../src/bot/commands/add.ts';
import type { AddEventParams } from '../../../src/bot/scenes/types.ts';
import type { BotCommandContext } from '../../../src/bot/types.ts';
import { DatabaseService } from '../../../src/database/index.ts';

const databases: DatabaseService[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.db.close();
});
function makeInput(args: string, groupTimezone?: string) {
  const db = new DatabaseService(':memory:');
  databases.push(db);
  const user = db.users.create({ telegram_id: 42, language: 'ru', timezone: 'Europe/Belgrade' });
  const chat = groupTimezone === undefined ? { type: 'private', id: 42 } : { type: 'group', id: -100 };
  if (groupTimezone !== undefined) {
    db.groupChats.upsertGroup({ chat_id: -100, added_by: 42 });
    if (groupTimezone) db.groupChats.setTimezone(-100, groupTimezone);
  }
  const send = mock(async (text: string) => text);
  const enter = mock(async (scene: Scene, params?: AddEventParams) => ({ scene, params }));
  const context = { chat, dbUser: user, args, send, scene: { enter } } as unknown as BotCommandContext;
  return { context, send, enter, db, scene: new Scene('add_event') };
}

test('group with no args enters a group-scoped draft', async () => {
  const r = makeInput('', 'Europe/Moscow');
  await handleAdd(r.context, r.scene, r.db.groupChats);
  expect(r.enter.mock.calls[0]?.[1]).toMatchObject({ groupId: -100, timezone: 'Europe/Moscow' });
});
test('group without a timezone explains settings and does not enter', async () => {
  const r = makeInput('Встреча завтра', '');
  await handleAdd(r.context, r.scene, r.db.groupChats);
  expect(r.enter).not.toHaveBeenCalled();
  expect(r.send.mock.calls[0]?.[0]).toContain('/settings');
});
test('group quick-add retains group owner and waits for the missing time', async () => {
  const r = makeInput('Встреча завтра', 'Europe/Moscow');
  await handleAdd(r.context, r.scene, r.db.groupChats);
  const params = r.enter.mock.calls[0]?.[1];
  expect(params).toMatchObject({ title: 'Встреча', groupId: -100, timezone: 'Europe/Moscow' });
  expect(params?.pendingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(params?.startAt).toBeUndefined();
});
test('group quick-add converts the group timezone, not the author timezone', async () => {
  const r = makeInput('Митинг 2027-01-15 19:00', 'Asia/Tokyo');
  await handleAdd(r.context, r.scene, r.db.groupChats);
  expect(r.enter.mock.calls[0]?.[1]).toMatchObject({ timezone: 'Asia/Tokyo', startAt: '2027-01-15T10:00:00.000Z' });
});

test('private quick-add has no group fields and never invents midnight', async () => {
  const r = makeInput('Task завтра');
  await handleAdd(r.context, r.scene);
  expect(r.enter.mock.calls[0]?.[1]?.groupId).toBeUndefined();
  expect(r.enter.mock.calls[0]?.[1]?.startAt).toBeUndefined();
  expect(r.enter.mock.calls[0]?.[1]?.title).toBe('Task');
});
test('private chat without args starts a timezone-aware draft', async () => {
  const r = makeInput('');
  await handleAdd(r.context, r.scene);
  expect(r.enter.mock.calls[0]?.[1]).toEqual({ timezone: 'Europe/Belgrade' });
});
test.each([
  'Team standup',
  'Разбор ошибок',
  '  Важное   дело  ',
])('title without a recognized date is preserved: %s', async (title) => {
  const r = makeInput(title);
  await handleAdd(r.context, r.scene);
  expect(r.enter.mock.calls[0]?.[1]?.title).toBe(title.trim());
});
test('long natural date suffix does not become part of the title', async () => {
  const r = makeInput('Встреча 25 сентября 2027 в 7 вечера');
  await handleAdd(r.context, r.scene);
  expect(r.enter.mock.calls[0]?.[1]).toMatchObject({ title: 'Встреча', startAt: '2027-09-25T17:00:00.000Z' });
});
