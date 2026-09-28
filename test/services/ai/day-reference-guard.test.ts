import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { CalendarProposalRepository } from '../../../src/database/repositories/calendar-proposal.repository.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { SecretaryRepository } from '../../../src/database/repositories/secretary.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { resolveTurnDayReferences } from '../../../src/services/ai/day-reference-guard.ts';
import { _resetToolThrottleForTest, executeTool } from '../../../src/services/ai/tool-executor.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';

// Synthetic user; the incident user wrote from Belgrade (UTC+2 in September).
const USER = 9101;
const TZ = 'Europe/Belgrade';
// Sunday 2026-09-27, 23:00 local.
const SUNDAY_NIGHT = new Date('2026-09-27T21:00:00Z');

let db: Database;
let history: ChatHistoryRepository;
let events: EventService;

function context(messageText: string, now = SUNDAY_NIGHT): AgentContext {
  const users = new UserRepository(db);
  const ctx: AgentContext = {
    user: users.findByTelegramId(USER)!,
    chatId: USER,
    messageText,
    isGroup: false,
    eventService: events,
    holidayService: new HolidayService(new HolidayRepository(db)),
    chatHistory: history,
    conversationLogger: new ConversationLogger(history),
    userRepo: users,
    eventReminderRepo: new EventReminderRepository(db),
  };
  ctx.dayReferences = resolveTurnDayReferences(messageText, history.getRecent(USER, 30), now, ctx.user.timezone);
  return ctx;
}

function say(text: string): void {
  history.save(USER, 'user', text);
}

function toolTurn(id: string, name: string, args: object, result: string): void {
  history.save(
    USER,
    'assistant',
    JSON.stringify({
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    }),
  );
  history.save(USER, 'tool', JSON.stringify([{ role: 'tool', tool_call_id: id, content: result }]));
}

const liveRows = () =>
  db
    .query<{ id: number; start_at: string }, []>('SELECT id, start_at FROM events WHERE is_deleted = 0 ORDER BY id')
    .all();

beforeEach(() => {
  _resetToolThrottleForTest();
  setSystemTime(SUNDAY_NIGHT);
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  new UserRepository(db).create({ telegram_id: USER, timezone: TZ, language: 'ru' });
  history = new ChatHistoryRepository(db);
  events = new EventService({ eventRepo: new EventRepository(db) });
});

afterEach(() => {
  setSystemTime();
  db.close();
});

describe('creating on a day the user did not name', () => {
  test('is rejected with the named dates and writes nothing; the named day is created', async () => {
    const text = 'понедельник Английский 12-30 среда Английский 12-30';
    say(text);
    const ctx = context(text);

    const wrong = await executeTool(ctx, 'create_event', {
      title: 'Английский',
      start_at: '2026-09-27T10:30:00Z',
      end_at: '2026-09-27T11:30:00Z',
    });
    expect(wrong.success).toBe(false);
    expect(wrong.mutationState).toBe('not_applied');
    expect(wrong.error).toContain('WRONG_DAY');
    expect(wrong.error).toContain('Monday 2026-09-28');
    expect(wrong.error).toContain('Wednesday 2026-09-30');
    expect(liveRows()).toEqual([]);

    const right = await executeTool(ctx, 'create_event', {
      title: 'Английский',
      start_at: '2026-09-30T10:30:00Z',
      end_at: '2026-09-30T11:30:00Z',
    });
    expect(right.success).toBe(true);
    expect(liveRows().map((row) => row.start_at)).toEqual(['2026-09-30T10:30:00Z']);
  });

  test('the Friday reproduction: Monday put on Sunday the 27th is rejected, the 28th is created', async () => {
    const friday = new Date('2026-09-25T11:57:00Z');
    setSystemTime(friday);
    const text = 'понедельник Алекс Английский пригласи Алекса 12-30';
    say(text);
    const ctx = context(text, friday);

    const sunday = await executeTool(ctx, 'create_event', { title: 'Английский', start_at: '2026-09-27T10:30:00Z' });
    expect(sunday.success).toBe(false);
    expect(sunday.error).toContain('Sunday 2026-09-27 12:30 local');
    // The corrective hint is a concrete calculate call for the named day at the same local time.
    expect(sunday.error).toContain('calculate("2026-09-28 12:30 Europe/Belgrade to UTC")');
    expect(liveRows()).toEqual([]);

    const monday = await executeTool(ctx, 'create_event', { title: 'Английский', start_at: '2026-09-28T10:30:00Z' });
    expect(monday.success).toBe(true);
  });

  test('the corrective calculate call it suggests is accepted and gives the right instant', async () => {
    say('в среду в 12:30 английский');
    const ctx = context('в среду в 12:30 английский');
    const wrong = await executeTool(ctx, 'create_event', { title: 'Английский', start_at: '2026-09-28T10:30:00Z' });
    const expression = /calculate\("([^"]+)"\)/.exec(wrong.error ?? '')?.[1];
    expect(expression).toBe('2026-09-30 12:30 Europe/Belgrade to UTC');

    const calculated = await executeTool(ctx, 'calculate', { expression });
    expect(calculated.success).toBe(true);
    expect(calculated.output).toContain('2026-09-30T10:30:00');
  });

  test('a turn without a checkable day is not constrained', async () => {
    say('по средам английский в 12:30');
    const ctx = context('по средам английский в 12:30');
    expect(ctx.dayReferences).toBeNull();
    const created = await executeTool(ctx, 'create_event', { title: 'Английский', start_at: '2026-09-28T10:30:00Z' });
    expect(created.success).toBe(true);
  });

  test('a date-only all-day start is the written day, also west of UTC', async () => {
    // 2026-09-27 17:00 in New York; Wednesday is 2026-09-30 there too.
    db.run('UPDATE users SET timezone = ? WHERE telegram_id = ?', ['America/New_York', USER]);
    say('в среду весь день конференция');
    const ctx = context('в среду весь день конференция');
    const created = await executeTool(ctx, 'create_event', {
      title: 'Конференция',
      start_at: '2026-09-30',
      all_day: true,
    });
    expect(created.error).toBeUndefined();
    expect(created.success).toBe(true);

    const tuesday = await executeTool(ctx, 'create_event', {
      title: 'Конференция',
      start_at: '2026-09-29',
      all_day: true,
    });
    expect(tuesday.error).toContain('Tuesday 2026-09-29');
    expect(tuesday.error).toContain('start_at "2026-09-30"');
  });
});

describe('reading a day the user did not name', () => {
  test('"Планы на среду" for Monday is rejected; a range with Wednesday runs', async () => {
    say('Планы на среду');
    const ctx = context('Планы на среду');

    const monday = await executeTool(ctx, 'get_events', {
      start_date: '2026-09-28T00:00:00Z',
      end_date: '2026-09-28T23:59:59Z',
      scope: 'personal',
    });
    expect(monday.success).toBe(false);
    expect(monday.error).toContain('«среду» = Wednesday 2026-09-30');
    expect(monday.error).toContain('get_events with start_date "2026-09-30"');

    const wednesday = await executeTool(ctx, 'get_events', { start_date: '2026-09-30', end_date: '2026-09-30' });
    expect(wednesday.success).toBe(true);
    const week = await executeTool(ctx, 'get_events', { start_date: '2026-09-27', end_date: '2026-10-05' });
    expect(week.success).toBe(true);
  });

  test('a day picture for another day is rejected', async () => {
    say('Во вторник отмени весь английский');
    const ctx = context('Во вторник отмени весь английский');
    const picture = await executeTool(ctx, 'render_day_image', { date: '2026-09-01' });
    expect(picture.success).toBe(false);
    expect(picture.error).toContain('Tuesday 2026-09-01');
  });

  test('a week or month picture must contain the named day', async () => {
    say('Планы на среду');
    const ctx = context('Планы на среду');
    const lastWeek = await executeTool(ctx, 'render_week_image', { week_start: '2026-09-21' });
    expect(lastWeek.success).toBe(false);
    expect(lastWeek.error).toContain('2026-09-21..2026-09-27');
    expect(lastWeek.error).toContain('render_week_image with week_start "2026-09-30"');
    const lastMonth = await executeTool(ctx, 'render_month_image', { month: '2026-08' });
    expect(lastMonth.error).toContain('2026-08-01..2026-08-31');
  });
});

describe('deleting on a day the user did not name', () => {
  const addLesson = (start: string) =>
    events.createEvent({ user_id: USER, title: 'Английский', start_at: start, timezone: TZ }).id;

  test('"во вторник" deletes the coming Tuesday, never a past one', async () => {
    const past = addLesson('2026-09-01T11:30:00Z');
    const coming = addLesson('2026-09-29T10:30:00Z');
    say('Во вторник отмени весь английский');
    const ctx = context('Во вторник отмени весь английский');

    const wrong = await executeTool(ctx, 'delete_event', { event_id: past });
    expect(wrong.success).toBe(false);
    expect(wrong.error).toContain(`Event ${past} «Английский» is on Tuesday 2026-09-01`);
    const right = await executeTool(ctx, 'delete_event', { event_id: coming });
    expect(right.success).toBe(true);
    expect(liveRows().map((row) => row.id)).toEqual([past]);
  });

  test('the answer "Да" to ask_user is checked against the message that asked', async () => {
    const past = addLesson('2026-09-01T11:30:00Z');
    const coming = addLesson('2026-09-29T10:30:00Z');
    say('Во вторник отмени весь английский');
    toolTurn('c1', 'search_events', { query: 'Английский' }, `id: ${past}\nid: ${coming}`);
    toolTurn(
      'c2',
      'ask_user',
      { question: 'Удалить «Английский» во вторник, 29 сентября?', options: ['Да', 'Нет'] },
      'Вопрос отправлен. Ожидаю ответа.',
    );
    say('Да');
    history.save(USER, 'assistant', JSON.stringify({ kind: 'bot_edit', text: '✅ Да' }));
    const ctx = context('Да');

    const wrong = await executeTool(ctx, 'delete_event', { event_id: past });
    expect(wrong.success).toBe(false);
    expect(wrong.error).toContain('«вторник» = Tuesday 2026-09-29');
    expect((await executeTool(ctx, 'delete_event', { event_id: coming })).success).toBe(true);
    expect(liveRows().map((row) => row.id)).toEqual([past]);
  });

  test('an edit that keeps the date must be on a named day; a move must land on one', async () => {
    const monday = addLesson('2026-09-28T10:30:00Z');
    const tuesday = addLesson('2026-09-29T10:30:00Z');
    say('Во вторник переименуй английский в «Разговорный английский»');
    const ctx = context('Во вторник переименуй английский в «Разговорный английский»');

    const wrong = await executeTool(ctx, 'update_event', { event_id: monday, title: 'Разговорный английский' });
    expect(wrong.success).toBe(false);
    expect(wrong.error).toContain(`Event ${monday} «Английский» is on Monday 2026-09-28`);
    const right = await executeTool(ctx, 'update_event', { event_id: tuesday, title: 'Разговорный английский' });
    expect(right.success).toBe(true);

    // "Перенеси английский на вторник": the lesson leaves a day the user did not name.
    say('Перенеси английский на вторник');
    const move = context('Перенеси английский на вторник');
    const moved = await executeTool(move, 'update_event', { event_id: monday, start_at: '2026-09-29T12:00:00Z' });
    expect(moved.success).toBe(true);
  });

  test("a secretary's delete in the owner's calendar is checked the same way", async () => {
    const OWNER = 9102;
    new UserRepository(db).create({ telegram_id: OWNER, timezone: TZ, language: 'ru' });
    const secretaryRepo = new SecretaryRepository(db);
    const access = secretaryRepo.upsert({ owner_id: OWNER, secretary_id: USER, permission: 'write' });
    secretaryRepo.updateStatus(access.id, 'active');
    const monday = events.createEvent({
      user_id: OWNER,
      title: 'Английский',
      start_at: '2026-09-28T10:30:00Z',
      timezone: TZ,
    }).id;
    say('Во вторник отмени английский у Алекса');
    const ctx = context('Во вторник отмени английский у Алекса');
    ctx.secretary = {
      secretaryRepo,
      secretaryForLine: undefined,
      calendarProposalRepo: new CalendarProposalRepository(db),
    };

    const wrong = await executeTool(ctx, 'delete_event', { event_id: monday, owner_id: OWNER });
    expect(wrong.error).toContain(`Event ${monday} «Английский» is on Monday 2026-09-28`);
    expect(liveRows().map((row) => row.id)).toEqual([monday]);
  });
});

describe('which turn text counts', () => {
  test('a day the question offered stays allowed after "Да"', () => {
    say('во вторник в 10 стоматолог');
    toolTurn(
      'c1',
      'ask_user',
      { question: 'Во вторник 10:00 занято. Поставить на 30 сентября?', options: ['Да', 'Нет'] },
      'Вопрос отправлен.',
    );
    say('Да');
    const set = resolveTurnDayReferences('Да', history.getRecent(USER, 30), SUNDAY_NIGHT, TZ);
    expect(set && [...set.allowedDates].sort()).toEqual(['2026-09-29', '2026-09-30', '2027-09-30']);
  });

  test('an answer naming its own day uses that day', () => {
    say('во вторник в 10 стоматолог');
    toolTurn('c1', 'ask_user', { question: 'Во сколько?', options: ['10:00'] }, 'Вопрос отправлен.');
    say('нет, в четверг');
    const set = resolveTurnDayReferences('нет, в четверг', history.getRecent(USER, 30), SUNDAY_NIGHT, TZ);
    expect(set && [...set.allowedDates]).toEqual(['2026-10-01']);
  });

  test('"Да" after a plain text reply is not tied to the earlier message', () => {
    say('во вторник в 10 стоматолог');
    history.save(USER, 'assistant', JSON.stringify({ role: 'assistant', content: 'Записала. Что-то ещё?' }));
    say('Да');
    expect(resolveTurnDayReferences('Да', history.getRecent(USER, 30), SUNDAY_NIGHT, TZ)).toBeNull();
  });

  test('a message that is not the newest saved one answers no question', () => {
    // A live-call transcript is never saved: the answered question before it is not its own.
    say('во вторник в 10 стоматолог');
    toolTurn('c1', 'ask_user', { question: 'Поставить на вторник, 29 сентября?', options: ['Да'] }, 'Отправлен.');
    say('Да');
    const history30 = history.getRecent(USER, 30);
    expect(resolveTurnDayReferences('поставь звонок маме на 3 часа', history30, SUNDAY_NIGHT, TZ)).toBeNull();
  });

  test('"эту среду" is this calendar week\'s or the coming one, never last week\'s', () => {
    const monday = new Date('2026-09-21T08:00:00Z');
    const set = resolveTurnDayReferences('отмени английский в эту среду', [], monday, TZ);
    expect(set && [...set.allowedDates].sort()).toEqual(['2026-09-23']);
    // On Sunday this week's Wednesday is past and the coming one is next week's: both readings stay.
    const sunday = resolveTurnDayReferences('отмени английский в эту среду', [], SUNDAY_NIGHT, TZ);
    expect(sunday && [...sunday.allowedDates].sort()).toEqual(['2026-09-23', '2026-09-30']);
  });
});
