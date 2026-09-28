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
function makeRuntime(groupTimezone?: string, lang: 'en' | 'ru' = 'ru') {
  const db = new DatabaseService(':memory:');
  const service = new EventService({ eventRepo: db.events });
  const storage = createSceneStorage(db.db);
  const userId = 700001;
  const chat =
    groupTimezone === undefined
      ? { id: userId, type: 'private' as const }
      : { id: -700002, type: 'group' as const, title: 'Synthetic group' };
  db.users.create({ telegram_id: userId, language: lang, timezone: 'Europe/Belgrade' });
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

// ---------------------------------------------------------------------------
// Legacy /add wizard time step wired to the shared wall-time parser (GH-650/GH-652
// bounded repair, PR682): bare-hour ambiguity, DST fold/gap, all-day, and the keyboard
// that now depends on what is actually pending, not just the numeric step.
// ---------------------------------------------------------------------------

test('the date question offers Today/Tomorrow; the time question swaps to All day and Change date', async () => {
  const r = makeRuntime();
  await r.send('/add');
  await r.send('Встреча');
  const dateButtons = r.messages
    .at(-1)!
    .keyboard?.inline_keyboard.flat()
    .map((b) => b.callback_data);
  expect(dateButtons).toEqual(expect.arrayContaining(['add:date:today', 'add:date:tomorrow']));
  await r.send('завтра');
  expect(r.messages.at(-1)!.text).toMatch(/во сколько/i);
  const timeButtons = r.messages
    .at(-1)!
    .keyboard?.inline_keyboard.flat()
    .map((b) => b.callback_data);
  expect(timeButtons).toEqual(expect.arrayContaining(['add:allday', 'add:changedate']));
  expect(timeButtons).not.toContain('add:date:today');
  expect(timeButtons).not.toContain('add:date:tomorrow');
});

test('a bare hour after the date offers 02:00/14:00 and writes nothing until one is chosen', async () => {
  const r = makeRuntime();
  await r.send('/add Йога 2027-01-15');
  expect(r.messages.at(-1)!.text).toMatch(/во сколько/i);
  await r.send('2');
  expect(r.count()).toBe(0);
  const candidates = r.messages
    .at(-1)!
    .keyboard?.inline_keyboard.flat()
    .map((b) => b.callback_data);
  expect(candidates).toEqual(expect.arrayContaining(['add:time:02:00', 'add:time:14:00']));
  await r.click('add:time:14:00');
  expect(r.messages.at(-1)!.text).toMatch(/длится/i);
  await r.click('add:duration:30');
  await r.click('ar:none');
  const event = await finishDraft(r);
  expect(event.start_at).toBe('2027-01-15T13:00:00.000Z');
  expect(event.all_day).toBe(0);
});

test('a spelled-out Russian hour resolves through the same ambiguity as its digit form', async () => {
  const r = makeRuntime();
  await r.send('/add Йога 2027-01-15');
  await r.send('два');
  const candidates = r.messages
    .at(-1)!
    .keyboard?.inline_keyboard.flat()
    .map((b) => b.callback_data);
  expect(candidates).toEqual(expect.arrayContaining(['add:time:02:00', 'add:time:14:00']));
  await r.click('add:time:02:00');
  await r.click('add:duration:30');
  await r.click('ar:none');
  expect((await finishDraft(r)).start_at).toBe('2027-01-15T01:00:00.000Z');
});

test('a time repeated by the fall-back fold offers both offsets; the chosen one is exact, never guessed', async () => {
  const r = makeRuntime();
  await r.send('/add Звонок 2026-10-25');
  await r.send('02:00');
  expect(r.count()).toBe(0);
  const candidates = (
    r.messages
      .at(-1)!
      .keyboard?.inline_keyboard.flat()
      .map((b) => b.callback_data) ?? []
  ).filter((d): d is string => !!d?.startsWith('add:time:'));
  expect(candidates).toHaveLength(2);
  expect(candidates[0]).not.toBe(candidates[1]);
  await r.click(candidates[0]!);
  await r.click('add:duration:30');
  await r.click('ar:none');
  const event = await finishDraft(r);
  expect(['2026-10-25T00:00:00.000Z', '2026-10-25T01:00:00.000Z']).toContain(event.start_at);
});

test('a bare-hour candidate landing inside a spring-forward gap is rejected, never silently accepted', async () => {
  const r = makeRuntime();
  await r.send('/add Йога 2026-03-29');
  await r.send('2');
  await r.click('add:time:02:00');
  expect(r.count()).toBe(0);
  expect(r.messages.at(-1)!.text).toMatch(/разобрать/i);
});

test('the All day button sets all_day, skips the duration step, and stores an exclusive next-day end', async () => {
  const r = makeRuntime();
  await r.send('/add Отпуск 2027-03-10');
  await r.click('add:allday');
  expect(r.messages.at(-1)!.text).toMatch(/повторять/i);
  await r.click('ar:none');
  const event = await finishDraft(r);
  expect(event.all_day).toBe(1);
  // Belgrade is UTC+1 in March (before its DST start): local midnight is 00:00+01:00, not
  // 00:00Z — the naive UTC-midnight bug this fix replaces happened to still name the right day
  // for this positive offset (see the New York/negative-offset regression test below).
  expect(event.start_at).toBe('2027-03-10T00:00:00.000+01:00');
  expect(event.end_at).toBe('2027-03-11T00:00:00.000+01:00');
});

test('typing "весь день" is equivalent to the All day button', async () => {
  const r = makeRuntime();
  await r.send('/add Отпуск 2027-06-01');
  await r.send('весь день');
  expect(r.messages.at(-1)!.text).toMatch(/повторять/i);
  await r.click('ar:none');
  const event = await finishDraft(r);
  expect(event.all_day).toBe(1);
  // Belgrade is UTC+2 in June (DST active).
  expect(event.start_at).toBe('2027-06-01T00:00:00.000+02:00');
  expect(event.end_at).toBe('2027-06-02T00:00:00.000+02:00');
});

test('going back out of an all-day draft returns to the date question, skipping the removed duration step', async () => {
  const r = makeRuntime();
  await r.send('/add Отпуск 2027-04-01');
  await r.click('add:allday');
  await r.click('add:back:3');
  expect(r.messages.at(-1)!.text).toMatch(/когда/i);
  await r.send('2027-04-02 15:00');
  expect(r.messages.at(-1)!.text).toMatch(/длится/i);
  await r.click('add:duration:30');
  await r.click('ar:none');
  const event = await finishDraft(r);
  expect(event.all_day).toBe(0);
  expect(event.start_at).toBe('2027-04-02T13:00:00.000Z');
  expect(event.end_at).toBe('2027-04-02T13:30:00.000Z');
});

test('Change date clears only the pending date/time, keeping the title', async () => {
  const r = makeRuntime();
  await r.send('/add Йога 2027-01-15');
  await r.click('add:changedate');
  expect(r.messages.at(-1)!.text).toMatch(/когда/i);
  await r.send('2027-02-01');
  expect(r.messages.at(-1)!.text).toMatch(/во сколько/i);
  await r.send('09:00');
  await r.click('add:duration:30');
  await r.click('ar:none');
  const event = await finishDraft(r);
  expect(event.title).toBe('Йога');
  expect(event.start_at).toBe('2027-02-01T08:00:00.000Z');
  expect(event.all_day).toBe(0);
});

test('a stale All day button from a superseded time question is rejected without altering the draft', async () => {
  const r = makeRuntime();
  await r.send('/add Прогулка 2027-05-05');
  const staleId = r.messages.at(-1)!.id;
  await r.send('10:00');
  await r.click('add:allday', staleId);
  expect(r.count()).toBe(0);
  await r.click('add:duration:30');
  await r.click('ar:none');
  const event = await finishDraft(r);
  expect(event.all_day).toBe(0);
  expect(event.start_at).toBe('2027-05-05T08:00:00.000Z');
});

test('English locale: the time question keyboard and ambiguous-time prompt are in English', async () => {
  const r = makeRuntime(undefined, 'en');
  await r.send('/add Yoga 2027-01-15');
  expect(r.messages.at(-1)!.text).toMatch(/what time/i);
  const timeButtons = r.messages
    .at(-1)!
    .keyboard?.inline_keyboard.flat()
    .map((b) => b.callback_data);
  expect(timeButtons).toEqual(expect.arrayContaining(['add:allday', 'add:changedate']));
  await r.send('2');
  expect(r.messages.at(-1)!.text).toMatch(/which time/i);
  await r.click('add:time:14:00');
  await r.click('add:duration:30');
  await r.click('ar:none');
  const event = await finishDraft(r);
  expect(event.start_at).toBe('2027-01-15T13:00:00.000Z');
});

// ---------------------------------------------------------------------------
// All-day calendar-date semantics across timezones (GH-652 parent review,
// issuecomment-5878910926 / PR682 review comment 5345159046): all-day is a DATE range, not a
// UTC-midnight instant. A negative-offset zone (New York) is the case the parent's real-scene
// probe (/tmp/hcb-live-add-parent-review.test.ts) caught showing "Mar 9" instead of "Mar 10".
// ---------------------------------------------------------------------------

test('PARENT all-day case: preview, receipt, storage and the day query all keep the chosen date in a negative-offset zone', async () => {
  const r = makeRuntime('America/New_York', 'en');
  await r.send('/add Holiday 2027-03-10');
  await r.click('add:allday');
  await r.click('ar:none');
  await r.click('ask:5');
  await r.click('ask:6');
  const preview = r.messages.at(-1)!.text;
  expect(preview).toContain('Mar 10, 2027');
  expect(preview).not.toContain('Mar 9, 2027');
  expect(r.count()).toBe(0);
  await r.click('add:confirm');
  expect(r.count()).toBe(1);
  const event = r.db.events.findById(1, r.userId)!;
  expect(event.all_day).toBe(1);
  // Naive UTC midnight ("...T00:00:00.000Z") reads back as March 9 in America/New_York (-05:00
  // in March); the actual local-midnight instant keeps the real calendar day on both ends.
  expect(event.start_at).toBe('2027-03-10T00:00:00.000-05:00');
  expect(event.end_at).toBe('2027-03-11T00:00:00.000-05:00');
  expect(event.start_at.slice(0, 10)).toBe('2027-03-10');
  expect(event.end_at!.slice(0, 10)).toBe('2027-03-11');
  const receipt = r.messages.at(-1)!.text;
  expect(receipt).toContain('Wed 10');
  expect(receipt).not.toContain('Tue 9');
  // The actual EventRepository day-range query (via EventService.getEventsForDay), not just the
  // stored string: the event must be found on March 10 and NOT bleed into March 9's query.
  const service = new EventService({ eventRepo: r.db.events });
  const onChosenDay = service.getEventsForDay(r.userId, new Date('2027-03-10T12:00:00Z'), 'America/New_York');
  expect(onChosenDay.map((occ) => occ.event.id)).toContain(event.id);
  const onPriorDay = service.getEventsForDay(r.userId, new Date('2027-03-09T12:00:00Z'), 'America/New_York');
  expect(onPriorDay.map((occ) => occ.event.id)).not.toContain(event.id);
});

test('a positive-offset zone (Tokyo) also keeps the chosen all-day calendar date exactly', async () => {
  const r = makeRuntime('Asia/Tokyo', 'en');
  await r.send('/add Sakura 2027-04-10');
  await r.click('add:allday');
  await r.click('ar:none');
  await r.click('ask:5');
  await r.click('ask:6');
  expect(r.messages.at(-1)!.text).toContain('Apr 10, 2027');
  await r.click('add:confirm');
  const event = r.db.events.findById(1, r.userId)!;
  expect(event.all_day).toBe(1);
  expect(event.start_at).toBe('2027-04-10T00:00:00.000+09:00');
  expect(event.end_at).toBe('2027-04-11T00:00:00.000+09:00');
  const service = new EventService({ eventRepo: r.db.events });
  const onChosenDay = service.getEventsForDay(r.userId, new Date('2027-04-10T00:30:00Z'), 'Asia/Tokyo');
  expect(onChosenDay.map((occ) => occ.event.id)).toContain(event.id);
});

test('a spring-forward all-day event spans 23 real hours, never a fixed 86,400,000ms day', async () => {
  // New York's clocks skip forward on 2027-03-14 (02:00 -> 03:00): the calendar day from
  // midnight to midnight is only 23 real hours, not 24 — an implementation that adds
  // 86_400_000ms instead of resolving the real next local midnight would end 1 hour early.
  const r = makeRuntime('America/New_York', 'en');
  await r.send('/add Conference 2027-03-14');
  await r.click('add:allday');
  await r.click('ar:none');
  await r.click('ask:5');
  await r.click('ask:6');
  await r.click('add:confirm');
  const event = r.db.events.findById(1, r.userId)!;
  expect(event.start_at).toBe('2027-03-14T00:00:00.000-05:00');
  expect(event.end_at).toBe('2027-03-15T00:00:00.000-04:00');
  expect(event.end_at!.slice(0, 10)).toBe('2027-03-15');
  const spanMs = Date.parse(event.end_at!) - Date.parse(event.start_at);
  expect(spanMs).toBe(23 * 60 * 60 * 1000);
  expect(spanMs).not.toBe(86_400_000);
});

test('a fall-back all-day event spans 25 real hours, never a fixed 86,400,000ms day', async () => {
  // New York's clocks fall back on 2027-11-07 (02:00 -> 01:00): that calendar day is 25 real
  // hours long.
  const r = makeRuntime('America/New_York', 'en');
  await r.send('/add Conference 2027-11-07');
  await r.click('add:allday');
  await r.click('ar:none');
  await r.click('ask:5');
  await r.click('ask:6');
  await r.click('add:confirm');
  const event = r.db.events.findById(1, r.userId)!;
  expect(event.start_at).toBe('2027-11-07T00:00:00.000-04:00');
  expect(event.end_at).toBe('2027-11-08T00:00:00.000-05:00');
  expect(event.end_at!.slice(0, 10)).toBe('2027-11-08');
  const spanMs = Date.parse(event.end_at!) - Date.parse(event.start_at);
  expect(spanMs).toBe(25 * 60 * 60 * 1000);
  expect(spanMs).not.toBe(86_400_000);
});
