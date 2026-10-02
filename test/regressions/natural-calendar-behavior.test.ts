import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { createIntentMatcherLayer } from '../../src/bot/pipeline/intent-matcher-layer.ts';
import type { BotCommandContext } from '../../src/bot/types.ts';
import { migrations } from '../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../src/database/repositories/chat-history.repository.ts';
import { ContactRepository } from '../../src/database/repositories/contact.repository.ts';
import { EventRepository } from '../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../src/database/repositories/holiday.repository.ts';
import { IntentRepository } from '../../src/database/repositories/intent.repository.ts';
import { NotificationPreferencesRepository } from '../../src/database/repositories/notification-preferences.repository.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import { WorkflowSessionRepository } from '../../src/database/repositories/workflow-session.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import { _resetToolThrottleForTest, executeTool, isMutationTool } from '../../src/services/ai/tool-executor.ts';
import type { AgentContext } from '../../src/services/ai/types.ts';
import { ConversationLogger } from '../../src/services/conversation-logger.ts';
import { EventService } from '../../src/services/event/event-service.ts';
import { HolidayService } from '../../src/services/holiday/holiday-service.ts';
import { IntentExecutor } from '../../src/services/intent/intent-executor.ts';
import { IntentMatcher } from '../../src/services/intent/intent-matcher.ts';
import { seedIntents } from '../../src/services/intent/seed-catalog.ts';

// Saturday 2026-09-19 10:00 in Belgrade (UTC+2).
const NOW = new Date('2026-09-19T08:00:00Z');
const USER = 7001;

type IntentRow = Parameters<IntentMatcher['load']>[0][number];
let db: Database;

beforeEach(() => {
  _resetToolThrottleForTest();
  setSystemTime(NOW);
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  runMigrations(db, migrations);
});
afterEach(() => {
  setSystemTime();
  db.close();
});

function seedRows(): IntentRow[] {
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
  return db.query<IntentRow, []>('SELECT * FROM intents').all();
}

interface EventRow {
  id: number;
  title: string;
  start_at: string;
  end_at: string | null;
}

/** Real SQLite, real tool executor, real matcher and layer; only Telegram delivery is mocked. */
function fixture(language = 'en') {
  const users = new UserRepository(db);
  users.create({ telegram_id: USER, timezone: 'Europe/Belgrade', language, first_name: 'Ann' });
  const events = new EventService({ eventRepo: new EventRepository(db) });
  const prefsRepo = new NotificationPreferencesRepository(db);
  const history = new ChatHistoryRepository(db);
  const rows = seedRows();
  const matcher = new IntentMatcher();
  matcher.load(rows);
  const store = new WorkflowSessionRepository(db);
  let text = '';
  const buildCtx = (): AgentContext =>
    ({
      user: users.findByTelegramId(USER)!,
      chatId: USER,
      messageText: text,
      isGroup: false,
      userRepo: users,
      contactRepo: new ContactRepository(db),
      eventService: events,
      holidayService: new HolidayService(new HolidayRepository(db)),
      chatHistory: history,
      eventReminderRepo: new EventReminderRepository(db),
      conversationLogger: new ConversationLogger(history),
      notifications: {
        notificationPrefs: {
          ensureDefaults: (id: number) => prefsRepo.ensureDefaults(id),
          getPrefs: (id: number) => prefsRepo.get(id)!,
          update: (id: number, patch: never) => prefsRepo.update(id, patch),
        },
      },
    }) as unknown as AgentContext;
  const call = mock((name: string, input: unknown) => executeTool(buildCtx(), name, input));
  const send = mock(async (_text: string, _opts?: unknown) => ({ message_id: 1 }));
  const layer = createIntentMatcherLayer(matcher, new IntentRepository(db), new IntentExecutor(), call, store);
  const say = async (message: string) => {
    text = message;
    const ctx = { dbUser: users.findByTelegramId(USER)!, chatId: USER, id: 1, send } as unknown as BotCommandContext;
    return layer(ctx, message);
  };
  const choices = (): string[] => {
    const markup = (send.mock.calls.at(-1)?.[1] as { reply_markup?: { keyboard?: { text: string }[][] } } | undefined)
      ?.reply_markup;
    return (markup?.keyboard ?? []).flat().map((button) => button.text);
  };
  const nameOf = (message: string) => {
    const decision = matcher.explain(message);
    if (decision.kind !== 'matched') return decision.reason;
    return rows.find((row) => row.id === decision.result.intentId)!.canonical_name;
  };
  return {
    say,
    choices,
    nameOf,
    store,
    lastText: () => String(send.mock.calls.at(-1)?.[0] ?? ''),
    mutations: () => call.mock.calls.filter((entry) => isMutationTool(entry[0], entry[1])),
    tools: () => call.mock.calls.map((entry) => entry[0]),
    rows: () =>
      db.query<EventRow, []>('SELECT id,title,start_at,end_at FROM events WHERE is_deleted=0 ORDER BY id').all(),
    addEvent: (title: string) =>
      events.createEvent({ user_id: USER, title, start_at: '2026-10-05T10:00:00+02:00', timezone: 'Europe/Belgrade' })
        .id,
  };
}

const at = (iso: string) => Date.parse(iso);

describe('terse natural entries against real SQLite', () => {
  test('an exact entry asks first, then saves the title as written at the stated local time', async () => {
    const f = fixture();
    expect(await f.say('Завтра 13:15 Стрижка у мастера')).toMatchObject({ handled: true });
    expect(f.rows()).toEqual([]);
    expect(f.mutations()).toEqual([]);
    expect(f.lastText()).toContain('13:15');
    expect(f.lastText()).toContain('Europe/Belgrade');
    await f.say(f.choices()[0]!);
    const rows = f.rows();
    expect(rows.map((row) => row.title)).toEqual(['Стрижка у мастера']);
    expect(at(rows[0]!.start_at)).toBe(at('2026-09-20T13:15:00+02:00'));
    expect(f.mutations()).toHaveLength(1);
  });

  test('a weekday, a date before the title and a dotted time all resolve to the right day', async () => {
    const f = fixture();
    for (const [message, expected] of [
      ['Среда вокал 12:30', '2026-09-23T12:30:00+02:00'],
      ['10 октября, ремонт велосипеда в 16.00', '2026-10-10T16:00:00+02:00'],
      ['В четверг в 14 урок гитары', '2026-09-24T14:00:00+02:00'],
    ] as const) {
      await f.say(message);
      await f.say(f.choices()[0]!);
      expect(at(f.rows().at(-1)!.start_at), message).toBe(at(expected));
    }
  });

  test('a bare hour is never guessed: both clock times are offered and the chosen one is saved', async () => {
    const f = fixture();
    await f.say('Завтра в 3 пробежка');
    expect(f.choices()).toEqual(['03:00', '15:00', 'Cancel']);
    expect(f.rows()).toEqual([]);
    expect(f.tools()).toEqual([]);
    await f.say('15:00');
    expect(at(f.rows()[0]!.start_at)).toBe(at('2026-09-20T15:00:00+02:00'));
  });

  test('cancelling the clock question writes nothing', async () => {
    const f = fixture();
    await f.say('Завтра в 3 пробежка');
    await f.say('Cancel');
    expect(f.rows()).toEqual([]);
    expect(f.mutations()).toEqual([]);
    expect(f.store.get(USER, USER)).toBeNull();
  });

  test('12 is confirmed as noon and says so', async () => {
    const f = fixture();
    await f.say('Завтра бассейн в 12');
    expect(f.lastText()).toContain('noon');
    await f.say(f.choices()[0]!);
    expect(at(f.rows()[0]!.start_at)).toBe(at('2026-09-20T12:00:00+02:00'));
  });

  test('an explicit range stores its end; an explicit zone stores that zone’s instant', async () => {
    const f = fixture();
    await f.say('Послезавтра 13:00-14:30 воркшоп');
    await f.say(f.choices()[0]!);
    await f.say('Завтра в 15:00 по Москве созвон');
    expect(f.lastText()).toContain('Europe/Moscow');
    await f.say(f.choices()[0]!);
    const [range, zoned] = f.rows();
    expect(at(range!.end_at!)).toBe(at('2026-09-21T14:30:00+02:00'));
    expect(at(zoned!.start_at)).toBe(at('2026-09-20T12:00:00Z'));
  });

  test('invites, links, lists, negation and questions fall through untouched', async () => {
    const f = fixture();
    for (const message of [
      'Завтра в 10:30 йога. Пригласи Анну',
      'Суббота 18:00 ярмарка добавь Олега',
      'Завтра в 10:30 йога https://example.com',
      'Завтра:\n13:00 почта\n16:00 гараж',
      'не ставь йогу завтра в 10:30',
      'Йога завтра в 10:30?',
      'Завтра в два часа встреча',
      'Секретная встреча в 23 часа',
    ])
      expect((await f.say(message)).handled, message).toBe(false);
    expect(f.tools()).toEqual([]);
    expect(f.rows()).toEqual([]);
  });

  test('past, impossible and clock-change times fall through before any tool', async () => {
    const f = fixture();
    for (const message of ['Йога вчера в 10:30', 'Йога 31 февраля в 10:30', 'Йога 28 марта 2027 в 02:30'])
      expect((await f.say(message)).handled, message).toBe(false);
    expect(f.tools()).toEqual([]);
  });

  test('explicit commands keep their own rules; the natural rule only takes the rest', () => {
    const f = fixture();
    expect(f.nameOf('создай стендап завтра в 10:30')).toBe('basis.event.create');
    expect(f.nameOf('создай стендап завтра с 10:00 до 11:00')).toBe('basis.event.create_range');
    expect(f.nameOf('свободен ли я завтра в 10:30')).toBe('basis.slots.check_time');
    expect(f.nameOf('удали событие Ретро')).toBe('basis.event.delete');
    expect(f.nameOf('Стендап завтра в 10:30')).toBe('basis.event.create_natural');
    expect(f.nameOf('Планы на среду')).toBe('basis.calendar.day');
    expect(f.nameOf('Мое расписание на неделю')).toBe('basis.calendar.period');
    expect(f.nameOf('Покажи мой план на эти выходные.')).toBe('basis.calendar.period');
    expect(f.nameOf('Что у меня по календарю вчера?')).toBe('basis.calendar.day');
    expect(f.nameOf('Какая у меня таймзона?')).toBe('basis.settings.timezone_show');
  });
});

describe('terse cancellation by title against real SQLite', () => {
  test('one match asks, then deletes exactly that event', async () => {
    const f = fixture();
    f.addEvent('Pottery');
    f.addEvent('Planning');
    await f.say('Pottery cancel');
    expect(f.lastText()).toContain('Pottery');
    expect(f.rows()).toHaveLength(2);
    await f.say(f.choices()[0]!);
    expect(f.rows().map((row) => row.title)).toEqual(['Planning']);
  });

  test('several matches delete nothing; pronouns and bulk words never reach the rule', async () => {
    const f = fixture();
    f.addEvent('Pottery A');
    f.addEvent('Pottery B');
    await f.say('cancel Pottery');
    expect(f.rows()).toHaveLength(2);
    expect(f.mutations()).toEqual([]);
    for (const message of ['Удали его', 'Отмени всё', 'Удали бассейн и йогу'])
      expect((await f.say(message)).handled, message).toBe(false);
    expect(f.rows()).toHaveLength(2);
  });
});

describe('relative reminders with number words', () => {
  test('"in an hour and a half" becomes one confirmed reminder event 90 minutes from now', async () => {
    const f = fixture('ru');
    await f.say('через полтора часа напомни про звонок в банк');
    expect(f.rows()).toEqual([]);
    await f.say(f.choices()[0]!);
    const rows = f.rows();
    expect(rows.map((row) => row.title)).toEqual(['звонок в банк']);
    expect(at(rows[0]!.start_at)).toBe(NOW.getTime() + 90 * 60_000);
  });
});
