import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { toEventSummary } from '../../src/bot/handlers/message.handler.ts';
import { createEventContextResolver, createIntentMatcherLayer } from '../../src/bot/pipeline/intent-matcher-layer.ts';
import type { GroupContext } from '../../src/bot/pipeline/types.ts';
import type { BotCommandContext } from '../../src/bot/types.ts';
import { migrations } from '../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../src/database/repositories/holiday.repository.ts';
import { IntentRepository } from '../../src/database/repositories/intent.repository.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import { WorkflowSessionRepository } from '../../src/database/repositories/workflow-session.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import { _resetToolThrottleForTest, executeTool, isMutationTool } from '../../src/services/ai/tool-executor.ts';
import type { AgentContext, ToolResult } from '../../src/services/ai/types.ts';
import { ConversationLogger } from '../../src/services/conversation-logger.ts';
import { EventService } from '../../src/services/event/event-service.ts';
import { HolidayService } from '../../src/services/holiday/holiday-service.ts';
import { captureReferences, EventReferenceStore } from '../../src/services/intent/event-reference-store.ts';
import { IntentExecutor } from '../../src/services/intent/intent-executor.ts';
import { IntentMatcher } from '../../src/services/intent/intent-matcher.ts';
import { seedIntents } from '../../src/services/intent/seed-catalog.ts';

// Saturday 2026-09-19 10:00 in Belgrade (UTC+2). The clocks go back on 2026-10-25.
const NOW = new Date('2026-09-19T08:00:00Z');
const USER = 8101;
const OTHER = 8102;
const GROUP = -100777;

let db: Database;
beforeEach(() => {
  _resetToolThrottleForTest();
  setSystemTime(NOW);
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  runMigrations(db, migrations);
  const users = new UserRepository(db);
  users.create({ telegram_id: USER, timezone: 'Europe/Belgrade', language: 'ru', first_name: 'Ann' });
  users.create({ telegram_id: OTHER, timezone: 'Europe/Belgrade', language: 'ru' });
  const insert = db.query(
    'INSERT INTO intents (canonical_name,phrases,trigger_words,pattern,workflow,status,format,source_message) VALUES(?,?,?,?,?,?,?,?)',
  );
  for (const seed of seedIntents)
    insert.run(
      seed.canonical_name,
      JSON.stringify(seed.phrases),
      JSON.stringify(seed.trigger_words),
      seed.pattern,
      JSON.stringify(seed.workflow),
      'approved',
      'text',
      seed.source_message,
    );
});
afterEach(() => {
  setSystemTime();
  db.close();
});

interface Where {
  as?: number;
  group?: boolean;
  thread?: number;
  replyTo?: number;
}

/** One bot process over the shared database; a second call models a restart. */
function boot(
  options: { wrapTool?: (name: string, input: unknown, real: () => Promise<ToolResult>) => Promise<ToolResult> } = {},
) {
  const users = new UserRepository(db);
  const events = new EventService({ eventRepo: new EventRepository(db) });
  const history = new ChatHistoryRepository(db);
  const store = new EventReferenceStore(db);
  const sessions = new WorkflowSessionRepository(db);
  const matcher = new IntentMatcher();
  matcher.load(db.query<Parameters<IntentMatcher['load']>[0][number], []>('SELECT * FROM intents').all());
  let current: Required<Pick<Where, 'as'>> & Where = { as: USER };
  let text = '';
  const chatOf = (where: Where) => (where.group ? GROUP : (where.as ?? USER));
  const agentCtx = (where: Where, source: 'ai_tool' | 'intent'): AgentContext => {
    const actor = where.as ?? USER;
    const ctx = {
      user: users.findByTelegramId(actor)!,
      chatId: chatOf(where),
      messageText: text,
      isGroup: where.group ?? false,
      groupChatId: where.group ? GROUP : undefined,
      userRepo: users,
      eventService: events,
      holidayService: new HolidayService(new HolidayRepository(db)),
      chatHistory: history,
      eventReminderRepo: new EventReminderRepository(db),
      conversationLogger: new ConversationLogger(history),
    } as unknown as AgentContext;
    captureReferences(
      ctx,
      store,
      { actorId: actor, chatId: chatOf(where), threadId: where.thread },
      { source },
      (err) => {
        throw err;
      },
    );
    return ctx;
  };
  const call = mock((name: string, input: unknown) => {
    const real = () => executeTool(agentCtx(current, 'intent'), name, input);
    return options.wrapTool ? options.wrapTool(name, input, real) : real();
  });
  let nextMessageId = 500;
  const send = mock(async (_text: string, _opts?: unknown) => ({ id: ++nextMessageId }));
  const layer = createIntentMatcherLayer(
    matcher,
    new IntentRepository(db),
    new IntentExecutor(),
    call,
    sessions,
    undefined,
    createEventContextResolver({ eventService: events, store, toSummary: toEventSummary }),
    undefined,
    undefined,
    store,
  );
  const say = async (message: string, where: Where = {}) => {
    current = { ...where, as: where.as ?? USER };
    text = message;
    const ctx = {
      dbUser: users.findByTelegramId(current.as)!,
      chatId: chatOf(current),
      id: 1,
      threadId: where.thread,
      replyMessage: where.replyTo === undefined ? undefined : { id: where.replyTo, from: { isBot: () => true } },
      send,
    } as unknown as BotCommandContext;
    const groupContext: GroupContext | undefined = where.group ? { isGroup: true, groupChatId: GROUP } : undefined;
    return layer(ctx, message, groupContext ? { groupContext } : undefined);
  };
  const choices = (): string[] => {
    const markup = (send.mock.calls.at(-1)?.[1] as { reply_markup?: { keyboard?: { text: string }[][] } } | undefined)
      ?.reply_markup;
    return (markup?.keyboard ?? []).flat().map((button) => button.text);
  };
  return {
    events,
    store,
    sessions,
    call,
    send,
    say,
    choices,
    /** A tool call made by the assistant (the AI path), with the production capture hook attached. */
    ai: (name: string, input: unknown, where: Where = {}) => executeTool(agentCtx(where, 'ai_tool'), name, input),
    yes: (where: Where = {}) => say(choices()[0]!, where),
    no: (where: Where = {}) => say(choices().at(-1)!, where),
    lastText: () => String(send.mock.calls.at(-1)?.[0] ?? ''),
    lastSentId: () => nextMessageId,
    writes: () => call.mock.calls.filter((entry) => isMutationTool(entry[0], entry[1])),
    add: (title: string, start: string, end?: string, owner = USER) =>
      events.createEvent({
        user_id: owner,
        title,
        start_at: start,
        ...(end ? { end_at: end } : {}),
        timezone: 'Europe/Belgrade',
      }).id,
    live: () =>
      db
        .query<{ id: number; title: string; start_at: string; end_at: string | null }, []>(
          'SELECT id,title,start_at,end_at FROM events WHERE is_deleted=0 ORDER BY id',
        )
        .all(),
  };
}

const instant = (value: string | null | undefined) => (value ? Date.parse(value) : null);

describe('delete the event just discussed', () => {
  test('"удали его" names the event get_event actually returned, deletes once on yes, and never twice', async () => {
    const bot = boot();
    const retro = bot.add('Retro', '2026-10-05T10:00:00+02:00');
    bot.add('Planning', '2026-10-06T10:00:00+02:00');
    await bot.ai('get_event', { event_id: retro });
    expect(await bot.say('удали его')).toMatchObject({ handled: true });
    expect(bot.lastText()).toContain('Retro');
    expect(bot.lastText()).toContain(`#${retro}`);
    expect(bot.writes()).toEqual([]);
    await bot.yes();
    expect(bot.live().map((row) => row.title)).toEqual(['Planning']);
    expect((await bot.say('Да')).handled).toBe(false);
    expect(bot.writes().filter((entry) => entry[0] === 'delete_event')).toHaveLength(1);
  });

  test('"удали последнее" is the event this actor created here, even after another event was mentioned; "его" is then that discussed event', async () => {
    const bot = boot();
    const other = bot.add('Dentist', '2026-10-07T09:00:00+02:00');
    const created = await bot.ai('create_event', { title: 'Standup', start_at: '2026-10-05T10:00:00+02:00' });
    expect(created.success).toBe(true);
    await bot.ai('get_event', { event_id: other });
    await bot.say('удали последнее');
    expect(bot.lastText()).toContain('Standup');
    await bot.say('удали его');
    // A new request replaces nothing: the pending question is still the first one.
    expect(bot.lastText()).toContain('Standup');
    await bot.no();
    expect(bot.writes()).toEqual([]);
    // The last event the conversation actually showed is Standup (re-read for the question), not Dentist.
    await bot.say('удали его');
    expect(bot.lastText()).toContain('Standup');
    await bot.no();
    expect(bot.live()).toHaveLength(2);
  });

  test('a bare "Удали." right after a mention asks about exactly that event', async () => {
    const bot = boot();
    const id = bot.add('Lesson', '2026-10-05T10:00:00+02:00');
    await bot.ai('get_event', { event_id: id });
    await bot.say('Удали.');
    expect(bot.lastText()).toContain('Lesson');
    expect(bot.writes()).toEqual([]);
  });

  test('without any evidence it asks which event, calls no tool and writes nothing', async () => {
    const bot = boot();
    bot.add('Retro', '2026-10-05T10:00:00+02:00');
    expect(await bot.say('удали его')).toMatchObject({ handled: true });
    expect(bot.call).not.toHaveBeenCalled();
    expect(bot.live()).toHaveLength(1);
  });

  test('after a list of several events "его" lists the choices instead of picking one; an ordinal then selects', async () => {
    const bot = boot();
    const a = bot.add('Sync A', '2026-10-05T10:00:00+02:00');
    const b = bot.add('Sync B', '2026-10-06T10:00:00+02:00');
    const found = await bot.ai('search_events', { query: 'Sync' });
    expect(Array.isArray(found.data) && found.data.length).toBe(2);
    await bot.say('удали его');
    expect(bot.lastText()).toContain(`#${a}`);
    expect(bot.lastText()).toContain(`#${b}`);
    expect(bot.call).not.toHaveBeenCalled();
    expect(bot.sessions.get(USER, USER)).toBeNull();
    await bot.say('удали второе');
    expect(bot.lastText()).toContain('Sync B');
    await bot.yes();
    expect(bot.live().map((row) => row.id)).toEqual([a]);
  });

  test('an ordinal beyond the list, or with no list, changes nothing', async () => {
    const bot = boot();
    bot.add('Sync A', '2026-10-05T10:00:00+02:00');
    await bot.say('удали второе');
    expect(bot.call).not.toHaveBeenCalled();
    await bot.ai('search_events', { query: 'Sync' });
    await bot.say('удали пятое');
    expect(bot.call).not.toHaveBeenCalled();
    expect(bot.live()).toHaveLength(1);
  });
});

describe('references never cross actors, chats, topics or their lifetime', () => {
  test("another actor, the same actor in a group, or another topic cannot use this chat's mention", async () => {
    const bot = boot();
    const id = bot.add('Retro', '2026-10-05T10:00:00+02:00');
    await bot.ai('get_event', { event_id: id });
    await bot.say('удали его', { as: OTHER });
    await bot.say('удали его', { group: true });
    expect(bot.call).not.toHaveBeenCalled();
    const g = bot.add('Group sync', '2026-10-05T12:00:00+02:00');
    db.query('UPDATE events SET owner_type = ?, group_id = ? WHERE id = ?').run('group', GROUP, g);
    await bot.ai('get_event', { event_id: g, scope: 'group' }, { group: true, thread: 7 });
    await bot.say('удали его', { group: true, thread: 8 });
    await bot.say('удали его', { group: true, as: OTHER, thread: 7 });
    expect(bot.call).not.toHaveBeenCalled();
    await bot.say('удали его', { group: true, thread: 7 });
    expect(bot.lastText()).toContain('Group sync');
  });

  test('a mention older than a day is forgotten', async () => {
    const bot = boot();
    const id = bot.add('Retro', '2026-10-05T10:00:00+02:00');
    await bot.ai('get_event', { event_id: id });
    setSystemTime(new Date(NOW.getTime() + 25 * 60 * 60 * 1000));
    await bot.say('удали его');
    expect(bot.call).not.toHaveBeenCalled();
  });

  test('an ID the assistant tried for an event it cannot read never becomes a reference', async () => {
    const bot = boot();
    const foreign = bot.add('Private of other', '2026-10-05T10:00:00+02:00', undefined, OTHER);
    const denied = await bot.ai('get_event', { event_id: foreign });
    expect(denied.success).toBe(false);
    await bot.say('удали его');
    expect(bot.call).not.toHaveBeenCalled();
    expect(bot.live()).toHaveLength(1);
  });

  test('a reply to a bot message names the event that message showed; an unknown message names nothing', async () => {
    const bot = boot();
    const a = bot.add('Alpha', '2026-10-05T10:00:00+02:00');
    const b = bot.add('Beta', '2026-10-06T10:00:00+02:00');
    await bot.say(`покажи событие #${a}`);
    const shownAlpha = bot.lastSentId();
    await bot.ai('get_event', { event_id: b });
    await bot.say('удали его', { replyTo: shownAlpha });
    expect(bot.lastText()).toContain('Alpha');
    await bot.no({ replyTo: shownAlpha });
    const calls = bot.call.mock.calls.length;
    await bot.say('удали его', { replyTo: 99_999 });
    expect(bot.call.mock.calls.length).toBe(calls);
  });
});

describe('the confirmed target is frozen and rechecked before the write', () => {
  test('an event deleted between the question and yes is not written and nothing is retried', async () => {
    const bot = boot();
    const id = bot.add('Retro', '2026-10-05T10:00:00+02:00');
    await bot.ai('get_event', { event_id: id });
    await bot.say('удали его');
    bot.events.deleteEvent(id, USER);
    await bot.yes();
    expect(bot.writes()).toEqual([]);
    expect((await bot.say('Да')).handled).toBe(false);
  });

  test('an event changed between the question and yes is not written; the user is told and nothing replays', async () => {
    const bot = boot();
    const id = bot.add('Retro', '2026-10-05T10:00:00+02:00');
    await bot.ai('get_event', { event_id: id });
    await bot.say('удали его');
    bot.events.updateEvent(id, USER, { start_at: '2026-10-05T12:00:00+02:00' });
    await bot.yes();
    expect(bot.writes()).toEqual([]);
    expect(bot.live()).toHaveLength(1);
    expect(bot.lastText()).toContain('Retro');
  });

  test('a write with an unknown outcome is reported and never replayed by a second yes', async () => {
    const bot = boot({
      wrapTool: async (name, _input, real) => {
        if (name === 'delete_event') throw new Error('connection reset');
        return real();
      },
    });
    const id = bot.add('Retro', '2026-10-05T10:00:00+02:00');
    await bot.ai('get_event', { event_id: id });
    await bot.say('удали его');
    await bot.yes();
    expect(bot.call.mock.calls.filter((entry) => entry[0] === 'delete_event')).toHaveLength(1);
    expect((await bot.say('Да')).handled).toBe(false);
    expect(bot.call.mock.calls.filter((entry) => entry[0] === 'delete_event')).toHaveLength(1);
  });

  test('the pending target survives a restart and the confirmation writes that exact event', async () => {
    const first = boot();
    const id = first.add('Retro', '2026-10-05T10:00:00+02:00');
    first.add('Other', '2026-10-06T10:00:00+02:00');
    await first.ai('get_event', { event_id: id });
    await first.say('удали его');
    const options = first.choices();
    const second = boot();
    await second.say(options[0]!);
    expect(second.live().map((row) => row.title)).toEqual(['Other']);
  });
});

describe('moving and resizing with bounded time arithmetic', () => {
  test('"перенеси его на завтра" keeps the wall-clock time and duration across the clock change', async () => {
    // Saturday 2026-10-24 07:00 in Belgrade; tomorrow is the day the clocks go back.
    setSystemTime(new Date('2026-10-24T05:00:00Z'));
    const bot = boot();
    const id = bot.add('Standup', '2026-10-24T10:00:00+02:00', '2026-10-24T10:45:00+02:00');
    await bot.ai('get_event', { event_id: id });
    await bot.say('перенеси его на завтра');
    expect(bot.lastText()).toContain('Standup');
    expect(bot.lastText()).toContain('2026-10-25 10:00');
    expect(instant(bot.live()[0]!.start_at)).toBe(Date.parse('2026-10-24T10:00:00+02:00'));
    await bot.yes();
    const row = bot.live()[0]!;
    expect(instant(row.start_at)).toBe(Date.parse('2026-10-25T10:00:00+01:00'));
    expect(instant(row.end_at)).toBe(Date.parse('2026-10-25T10:45:00+01:00'));
  });

  test('the moved event stays the one "его" refers to after the confirmation', async () => {
    const bot = boot();
    const id = bot.add('Standup', '2026-10-05T10:00:00+02:00');
    await bot.ai('get_event', { event_id: id });
    await bot.say('перенеси его на завтра');
    await bot.yes();
    await bot.say('удали его');
    expect(bot.lastText()).toContain('Standup');
    expect(bot.lastText()).toContain('2026-09-20');
  });

  test('an hour later and thirty minutes earlier shift start and end by elapsed time', async () => {
    const bot = boot();
    const id = bot.add('Breakfast', '2026-10-05T09:00:00+02:00', '2026-10-05T09:30:00+02:00');
    await bot.say('перенеси завтрак на час позже');
    expect(bot.call).toHaveBeenCalled();
    await bot.ai('get_event', { event_id: id });
    await bot.say('перенеси его на час позже');
    await bot.yes();
    expect(instant(bot.live()[0]!.start_at)).toBe(Date.parse('2026-10-05T10:00:00+02:00'));
    expect(instant(bot.live()[0]!.end_at)).toBe(Date.parse('2026-10-05T10:30:00+02:00'));
    await bot.say('сдвинь его на 30 минут раньше');
    await bot.yes();
    expect(instant(bot.live()[0]!.start_at)).toBe(Date.parse('2026-10-05T09:30:00+02:00'));
  });

  test('a titled event can be shifted by name when exactly one event matches', async () => {
    const bot = boot();
    bot.add('завтрак', '2026-10-05T09:00:00+02:00');
    await bot.say('перенеси завтрак на час позже');
    expect(bot.lastText()).toContain('завтрак');
    await bot.yes();
    expect(instant(bot.live()[0]!.start_at)).toBe(Date.parse('2026-10-05T10:00:00+02:00'));
  });

  test('longer uses the real end; without an end the default duration is stated; shorter cannot reach zero', async () => {
    const bot = boot();
    const withEnd = bot.add('Call', '2026-10-05T10:00:00+02:00', '2026-10-05T10:30:00+02:00');
    await bot.ai('get_event', { event_id: withEnd });
    await bot.say('сделай его на 30 минут длиннее');
    await bot.yes();
    expect(instant(bot.live()[0]!.end_at)).toBe(Date.parse('2026-10-05T11:00:00+02:00'));

    const open = bot.add('Walk', '2026-10-06T10:00:00+02:00');
    await bot.ai('get_event', { event_id: open });
    await bot.say('продли его на 30 минут');
    expect(bot.lastText()).toContain('60');
    await bot.yes();
    expect(instant(bot.live().find((row) => row.id === open)!.end_at)).toBe(Date.parse('2026-10-06T11:30:00+02:00'));

    const zero = bot.add('Ping', '2026-10-07T10:00:00+02:00', '2026-10-07T10:00:00+02:00');
    await bot.ai('get_event', { event_id: zero });
    const before = bot.writes().length;
    expect((await bot.say('сделай его на 15 минут короче')).handled).toBe(false);
    expect(bot.writes().length).toBe(before);
  });

  test('a bare hour asks morning or evening and never assumes one', async () => {
    const bot = boot();
    const id = bot.add('Lunch', '2026-10-05T10:00:00+02:00');
    await bot.ai('get_event', { event_id: id });
    await bot.say('перенеси его на 3');
    expect(bot.choices()).toEqual(['03:00', '15:00', 'Отмена']);
    expect(bot.writes()).toEqual([]);
    await bot.say('15:00');
    expect(instant(bot.live()[0]!.start_at)).toBe(Date.parse('2026-10-05T15:00:00+02:00'));
  });
});

describe('negated and compound requests stay with the assistant', () => {
  test('no contextual rule runs a tool for these', async () => {
    const bot = boot();
    const id = bot.add('Retro', '2026-10-05T10:00:00+02:00');
    await bot.ai('get_event', { event_id: id });
    for (const text of [
      'не удаляй его',
      'удали его и пригласи алекса',
      'отмени это событие и отправь алексу уведомление',
      'Удали. И поправь мне тайм зону',
      'удали все',
      'перенеси все на завтра',
    ])
      expect((await bot.say(text)).handled, text).toBe(false);
    expect(bot.call).not.toHaveBeenCalled();
  });
});
