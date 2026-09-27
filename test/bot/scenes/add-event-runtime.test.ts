import { afterEach, describe, expect, test } from 'bun:test';
import { scenes } from '@gramio/scenes';
import { Bot } from 'gramio';
import { z } from 'zod';
import { handleAdd } from '../../../src/bot/commands/add.ts';
import { createUserResolver, createUserResolverComposer } from '../../../src/bot/middleware/user-resolver.ts';
import { createAddEventScene } from '../../../src/bot/scenes/add-event.scene.ts';
import { createSceneStorage } from '../../../src/bot/scenes/storage.ts';
import { DatabaseService } from '../../../src/database/index.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { jsonCodec } from '../../../src/utils/json-codec.ts';

const RequestSchema = z.object({
  chat_id: z.union([z.number(), z.string()]).optional(),
  text: z.string().optional(),
  reply_markup: z
    .object({
      inline_keyboard: z.array(
        z.array(
          z.object({
            text: z.string(),
            callback_data: z.string().optional(),
          }),
        ),
      ),
    })
    .optional(),
});
const closes: (() => void)[] = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
});
function makeRuntime(groupTimezone?: string) {
  const db = new DatabaseService(':memory:');
  const service = new EventService({ eventRepo: db.events });
  const storage = createSceneStorage(db.db);
  const userId = 700001;
  const chat =
    groupTimezone === undefined
      ? { id: userId, type: 'private' as const }
      : { id: -700002, type: 'group' as const, title: 'Synthetic group' };
  db.users.create({ telegram_id: userId, language: 'ru', timezone: 'Europe/Belgrade' });
  if (groupTimezone !== undefined) {
    db.groupChats.upsertGroup({ chat_id: chat.id, title: 'Synthetic group', added_by: userId });
    db.groupMembers.upsert(chat.id, userId);
    if (groupTimezone) db.groupChats.setTimezone(chat.id, groupTimezone);
  }
  const messages: { id: number; text: string; keyboard: z.infer<typeof RequestSchema>['reply_markup'] }[] = [];
  const errors: Error[] = [];
  let outgoing = 100;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const payload = jsonCodec(RequestSchema).parse(await request.text());
      const method = new URL(request.url).pathname.split('/').at(-1);
      if (method === 'answerCallbackQuery') return Response.json({ ok: true, result: true });
      const id = outgoing++;
      messages.push({ id, text: payload.text ?? '', keyboard: payload.reply_markup });
      return Response.json({
        ok: true,
        result: {
          message_id: id,
          date: 1,
          chat,
          from: { id: 1, is_bot: true, first_name: 'Test' },
          text: payload.text,
          reply_markup: payload.reply_markup,
        },
      });
    },
  });
  closes.push(() => {
    server.stop(true);
    db.db.close();
  });
  const scene = createAddEventScene(service, createUserResolverComposer(db), db.actionLog);
  const bot = new Bot('1:synthetic-test', {
    info: { id: 1, is_bot: true, first_name: 'Test', username: 'SyntheticTestBot' },
    api: { baseURL: `http://127.0.0.1:${server.port}/bot` },
  })
    .derive(createUserResolver(db))
    .extend(scenes([scene], { storage }))
    .command('add', (ctx) => handleAdd(ctx, scene, db.groupChats));
  bot.onError((ctx) => {
    errors.push(ctx.error);
  });
  let incoming = 1;
  async function send(text: string) {
    await bot.updates.handleUpdate({
      update_id: incoming++,
      message: {
        message_id: incoming,
        date: 1,
        chat,
        from: { id: userId, is_bot: false, first_name: 'Synthetic' },
        text,
        ...(text.startsWith('/')
          ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] }
          : {}),
      },
    });
    expect(errors).toEqual([]);
  }
  async function click(data: string, messageId = messages.at(-1)!.id) {
    await bot.updates.handleUpdate({
      update_id: incoming++,
      callback_query: {
        id: String(incoming),
        chat_instance: 'synthetic',
        data,
        from: { id: userId, is_bot: false, first_name: 'Synthetic' },
        message: { message_id: messageId, date: 1, chat },
      },
    });
    expect(errors).toEqual([]);
  }
  const count = () => db.db.query<{ n: number }, []>('SELECT count(*) AS n FROM events').get()!.n;
  return { db, storage, send, click, count, messages, userId };
}

describe('real GramIO /add dialogue (GH-359)', () => {
  test('one draft reaches preview, then one explicit confirmation creates one event', async () => {
    const r = makeRuntime();
    await r.send('/add');
    await r.send('Встреча <без цензуры>');
    await r.send('завтра');
    expect(r.messages.at(-1)!.text).toMatch(/во сколько/i);
    await r.send('19:00');
    await r.send('30м');
    await r.click('ar:none');
    expect(r.messages.at(-1)!.text).toMatch(/описание/i);
    await r.send('Мат, секс — пользовательская заметка');
    await r.send('Офис');
    expect(r.count()).toBe(0);
    expect(r.messages.at(-1)!.text).toMatch(/проверь/i);
    await r.click('add:confirm');
    expect(r.count()).toBe(1);
    const event = r.db.events.findById(1, r.userId);
    expect(event?.title).toBe('Встреча <без цензуры>');
    expect(event?.description).toBe('Мат, секс — пользовательская заметка');
  });
  test('a stale cancel from the title prompt cannot destroy a later draft', async () => {
    const r = makeRuntime();
    await r.send('/add');
    const oldPrompt = r.messages.at(-1)!.id;
    await r.send('Test');
    await r.click('add:cancel', oldPrompt);
    expect(await r.storage.get(`@gramio/scenes:${r.userId}`)).not.toBeNull();
    await r.send('завтра 19:00');
    expect(r.messages.at(-1)!.text).toMatch(/длится/i);
  });
});

test('quick add with only a date asks for time without writing', async () => {
  const r = makeRuntime();
  await r.send('/add Task завтра');
  expect(r.count()).toBe(0);
  expect(r.messages.at(-1)!.text).toMatch(/во сколько/i);
  await r.send('19:00');
  expect(r.messages.at(-1)!.text).toMatch(/длится/i);
});

test('group wizard keeps group ownership and group timezone', async () => {
  const r = makeRuntime('Asia/Tokyo');
  await r.send('/add');
  await r.send('Group event');
  await r.send('2027-01-15 19:00');
  await r.click('add:duration:30');
  await r.click('ar:none');
  await r.click('ask:5');
  await r.click('ask:6');
  await r.click('add:confirm');
  expect(r.db.events.findById(1, r.userId)).toMatchObject({
    owner_type: 'group',
    group_id: -700002,
    timezone: 'Asia/Tokyo',
    start_at: '2027-01-15T10:00:00.000Z',
  });
});

async function finishDraft(r: ReturnType<typeof makeRuntime>) {
  await r.click('ask:5');
  await r.click('ask:6');
  expect(r.count()).toBe(0);
  await r.click('add:confirm');
  expect(r.count()).toBe(1);
  return r.db.events.findById(1, r.userId)!;
}
test('until includes the selected local day and preserves the default duration', async () => {
  const r = makeRuntime();
  await r.send('/add Repeat 2027-01-15 19:00');
  await r.click('ask:2');
  await r.click('ar:DAILY');
  await r.click('are:until');
  await r.send('15');
  const event = await finishDraft(r);
  expect(event.recurrence_rule).toBe('FREQ=DAILY;UNTIL=20270115T225959Z');
  expect(event.end_at).toBe('2027-01-15T19:00:00.000Z');
});
test('repeat count rejects zero and accepts a natural-language number', async () => {
  const r = makeRuntime();
  await r.send('/add Repeat 2027-01-15 19:00');
  await r.click('ask:2');
  await r.click('ar:WEEKLY');
  await r.click('are:count');
  await r.send('0');
  expect(r.messages.at(-1)!.text).toContain('999');
  await r.send('5 раз');
  expect((await finishDraft(r)).recurrence_rule).toBe('FREQ=WEEKLY;COUNT=5');
});

test('ambiguous end number is resolved by one choice button', async () => {
  const r = makeRuntime();
  await r.send('/add Repeat 2027-01-15 19:00');
  await r.click('ask:2');
  await r.click('ar:DAILY');
  await r.send('16');
  expect(
    r.messages
      .at(-1)!
      .keyboard?.inline_keyboard.flat()
      .map((b) => b.callback_data),
  ).toContain('are:until:16');
  await r.click('are:until:16');
  expect((await finishDraft(r)).recurrence_rule).toBe('FREQ=DAILY;UNTIL=20270116T225959Z');
});
test('Back permits correction and does not replay the old message into another step', async () => {
  const r = makeRuntime();
  await r.send('/add Change 2027-01-15 19:00');
  await r.click('add:duration:30');
  await r.click('add:back:3');
  expect(r.messages.at(-1)!.text).toMatch(/длится/i);
  await r.click('add:duration:120');
  await r.click('ar:none');
  await r.click('add:back:5');
  expect(r.messages.at(-1)!.text).toMatch(/повторять/i);
  await r.click('ar:none');
  expect((await finishDraft(r)).end_at).toBe('2027-01-15T20:00:00.000Z');
});
test('two simultaneous confirmation callbacks create exactly one event', async () => {
  const r = makeRuntime();
  await r.send('/add Once 2027-01-15 19:00');
  await r.click('ask:2');
  await r.click('ar:none');
  await r.click('ask:5');
  await r.click('ask:6');
  const previewId = r.messages.at(-1)!.id;
  await Promise.all([r.click('add:confirm', previewId), r.click('add:confirm', previewId)]);
  expect(r.count()).toBe(1);
});

test('a long description is stored fully but Telegram replies stay within limits', async () => {
  const r = makeRuntime();
  await r.send('/add Long note 2027-01-15 19:00');
  await r.click('ask:2');
  await r.click('ar:none');
  const description = 'a'.repeat(4000);
  await r.send(description);
  await r.send('Office');
  await r.click('add:confirm');
  expect(r.db.events.findById(1, r.userId)?.description).toBe(description);
  expect(r.messages.every((message) => message.text.length <= 4096)).toBe(true);
});
test('relative recurrence end means tomorrow from now, not from the future event', async () => {
  const r = makeRuntime();
  const start = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  await r.send(`/add Repeat ${start} 19:00`);
  await r.click('ask:2');
  await r.click('ar:DAILY');
  await r.click('are:until');
  await r.send('завтра');
  expect(r.messages.at(-1)!.text).toContain('не раньше начала');
  expect(r.count()).toBe(0);
});

test('Back allows editing a title seeded by the command without applying it again', async () => {
  const r = makeRuntime();
  await r.send('/add Initial завтра');
  await r.click('add:back:1');
  expect(r.messages.at(-1)!.text).toContain('Как назовём');
  await r.send('Changed title');
  await r.send('19:00');
  await r.click('ask:2');
  await r.click('ar:none');
  expect((await finishDraft(r)).title).toBe('Changed title');
});
